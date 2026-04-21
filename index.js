/**
 * This script contains the Node.js functions for the decompressing of the zip file
 *
 * Owned by Shore-Interactive
 * Version 0.0.1
 *  19042026 svandenoever - Initial version, support for generating/revoking Tokens, Token validating, .ZIP extraction and Folder deletion after inactivity
 */
const express = require('express');
const multer = require('multer');
const unzipper = require('unzipper');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const helmet = require('helmet');

const OBJ_APP = express();
// Because we are routing the traffic through NGINX, a header is added with the origin IP
// We need to trust it, otherwise Express will return errors
OBJ_APP.set('trust proxy', 1)
OBJ_APP.use(cors());
OBJ_APP.use(helmet());
// Important - Limit the File Size to 100MB for now, as it is the largest example we have seen
const OBJ_UPLOAD = multer({
    dest: 'uploads/',
    limits: {fileSize: 100 * 1024 * 1024}
});

// Limit the amount of uploads PER 15 MINUTES
const OBJ_UPLOAD_LIMITER = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: {error: 'Too many uploads, please try again later'}
});
// Limit the amount of fetches PER 15 MINUTES
const OBJ_FETCH_LIMITER = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 2000,
    message: {error: 'Too many requests, please try again later'}
});

const INT_PORT = 3000;

// Hash the token
function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

// Match the token received via the request with the saved hashed tokens that have been generated
function isValidToken(token) {
    const TOKENS = JSON.parse(fs.readFileSync('./tokens.json', 'utf8'));
    return !!TOKENS[hashToken(token)];
}

// Retrieve the Name of the token for logging purposes
function getTokenName(token) {
    const TOKENS = JSON.parse(fs.readFileSync('./tokens.json', 'utf8'));
    return TOKENS[hashToken(token)]?.name || 'Unknown';
}

const OBJ_CLEANUP_TIMERS = {};

function logRequest(STR_ENDPOINT, STR_JOB_ID, STR_TOKEN_NAME) {
    console.log(`[${new Date().toISOString()}] ${STR_ENDPOINT} | job: ${STR_JOB_ID} | client: ${STR_TOKEN_NAME}`);
}

// Clean up any left behind uploads from a previous server run (after shutdown, reboot, etc.)
if(fs.existsSync('uploads')) {
    fs.rmSync('uploads', {recursive: true, force: true});
    fs.mkdirSync('uploads');
}

// Automatically clean up the extracted folders after 30 minutes of inactivity
// This way we don't hold on to sensitive data and prevent the server from getting full
function scheduleCleanup(STR_JOB_ID, STR_FOLDER, STR_UPLOADED_FILE) {
    if(OBJ_CLEANUP_TIMERS[STR_JOB_ID]) {
        clearTimeout(OBJ_CLEANUP_TIMERS[STR_JOB_ID]);
    }

    OBJ_CLEANUP_TIMERS[STR_JOB_ID] = setTimeout(() => {
        fs.rmSync(STR_FOLDER, {recursive: true, force: true});
        fs.rmSync(STR_UPLOADED_FILE, {force: true});
        delete OBJ_CLEANUP_TIMERS[STR_JOB_ID];
        console.log('Cleaned up job:', STR_FOLDER);
    }, 30 * 60 * 1000);
}

OBJ_APP.get('/', (_, response) => {
    response.send('Server is running');
});

/**
 * Extract the zip file into a new folder, named by a random UUID and return the UUID
 * The UUID is returned as Job ID, so we can find this folder again when retrieving the files
 */
OBJ_APP.post('/extract', OBJ_UPLOAD_LIMITER, OBJ_UPLOAD.single('zipfile'), (request, response) => {
    // Retrieve the API key from the request header
    const STR_API_KEY = request.headers['x-api-key'];

    // Match it against the saved (hashed) tokens
    if(!STR_API_KEY || !isValidToken(STR_API_KEY)) {
        return response.status(401).json({error: 'Unauthorized'});
    }

    if(!request.file) {
        return response.status(400).json({error: 'No file uploaded'});
    }


    // If code reaches this stage, all is well, so start extraction
    const STR_JOB_ID = crypto.randomUUID();
    const STR_EXTRACT_FOLDER = path.join('uploads', STR_JOB_ID);

    logRequest('POST /extract', STR_JOB_ID, getTokenName(STR_API_KEY));

    // Create a temporary folder to save the extracted files
    fs.mkdirSync(STR_EXTRACT_FOLDER, {recursive: true});
    // Log the time before extraction start
    const DT_START_TIME = Date.now();
    // Stream the file received via the request
    fs.createReadStream(request.file.path)
    .pipe(unzipper.Extract({path: STR_EXTRACT_FOLDER}))
    .on('close', () => {
        // Read all the files in the extracted folder recursively
        const ARR_FILES = fs.readdirSync(STR_EXTRACT_FOLDER, {recursive: true})
            .filter(f => !fs.statSync(path.join(STR_EXTRACT_FOLDER, f)).isDirectory());
        const OBJ_INVOICES = {};
        // For each file,
        for (const STR_FILE of ARR_FILES) {
            const STR_BASENAME = path.basename(STR_FILE);
            const ARR_PARTS = STR_BASENAME.split('-');
            const STR_INVOICE_ID = ARR_PARTS[ARR_PARTS.length - 2];

            if(!OBJ_INVOICES[STR_INVOICE_ID]) {
                OBJ_INVOICES[STR_INVOICE_ID] = {xmlFiles: [], pdfFile: null}
            }

            if(STR_BASENAME.endsWith('.xml')) {
                OBJ_INVOICES[STR_INVOICE_ID].xmlFiles.push(STR_FILE);
            } else if(STR_BASENAME.endsWith('.pdf') && !OBJ_INVOICES[STR_INVOICE_ID].pdfFile) {
                OBJ_INVOICES[STR_INVOICE_ID].pdfFile = STR_FILE;
            }
        }

        // Schedule the cleanup of the folder after 5 minutes
        scheduleCleanup(STR_JOB_ID, STR_EXTRACT_FOLDER, request.file.path);

        response.json({
            intJobId: STR_JOB_ID,
            objInvoices: OBJ_INVOICES,
            intTotalInvoices: Object.keys(OBJ_INVOICES).length
        });
    })
    .on('error', (ex) => {
        response.status(500).json({error: 'Extraction failed', detail: ex.message});
    });
});

/**
 * Here we build the object of the files.
 * In our case, 1 invoice can have multiple XML files, but only 1 PDF.
 * When finished, return the full object with all the files, grouped by Invoice number
 */
OBJ_APP.get('/job/:jobId/invoices', OBJ_FETCH_LIMITER, (request, response) => {
    const STR_API_KEY = request.headers['x-api-key'];

    // Validate API key
    if (!STR_API_KEY || !isValidToken(STR_API_KEY)) {
        return response.status(401).json({ error: 'Unauthorized' });
    }

    // Check if the folder exists on the server
    const STR_EXTRACT_FOLDER = path.join('uploads', request.params.jobId);

    if (!fs.existsSync(STR_EXTRACT_FOLDER)) {
        return response.status(404).json({ error: 'Job not found' });
    }

    logRequest('GET /invoices', request.params.jobId, getTokenName(STR_API_KEY));

    const ARR_FILES = fs.readdirSync(STR_EXTRACT_FOLDER, { recursive: true })
        .filter(f => !fs.statSync(path.join(STR_EXTRACT_FOLDER, f)).isDirectory());
    const OBJ_INVOICES = {};

    // For each file,  extract the invoice number and use it to build the object
    for (const STR_FILE of ARR_FILES) {
        const STR_BASENAME = path.basename(STR_FILE);
        const ARR_PARTS = STR_BASENAME.split('-');
        const STR_INVOICE_NUMBER = ARR_PARTS[ARR_PARTS.length - 2];

        if (!OBJ_INVOICES[STR_INVOICE_NUMBER]) {
            OBJ_INVOICES[STR_INVOICE_NUMBER] = { xmlFiles: [], pdfFile: null };
        }

        if (STR_BASENAME.endsWith('.xml')) {
            OBJ_INVOICES[STR_INVOICE_NUMBER].xmlFiles.push(STR_FILE);
        } else if (STR_BASENAME.endsWith('.pdf') && !OBJ_INVOICES[STR_INVOICE_NUMBER].pdfFile) {
            OBJ_INVOICES[STR_INVOICE_NUMBER].pdfFile = STR_FILE;
        }
    }

    scheduleCleanup(request.params.jobId, STR_EXTRACT_FOLDER, '');

    response.json({ invoices: OBJ_INVOICES });
});

/**
 * Since we can't process hundreds of files at once, instead we retrieve them on a file to file basis.
 * Each file is an API call and we just return the filename & contents
 */
OBJ_APP.get('/job/:jobId/pdf', OBJ_FETCH_LIMITER, (request, response) => {
    const STR_API_KEY = request.headers['x-api-key'];

    // Validate the API key
    if(!STR_API_KEY || !isValidToken(STR_API_KEY)) {
        return response.status(401).json({error: 'Unauthorized'});
    }
    // Define the folder/filepath from the parameters
    const STR_EXTRACT_FOLDER = path.join('uploads', request.params.jobId);
    const STR_FILE_PATH = path.join(STR_EXTRACT_FOLDER, request.query.filename);

    const STR_RESOLVED_PATH = path.resolve(STR_FILE_PATH);
    const STR_RESOLVED_FOLDER = path.resolve(STR_EXTRACT_FOLDER);

    // Resolve the paths to make sure that the job is always executed in the job folder
    // This way we can contain any injections
    if(!STR_RESOLVED_PATH.startsWith(STR_RESOLVED_FOLDER)) {
        return response.status(400).json({error: 'Invalid filename'});
    }

    // Check if the filepath exists on the server
    if(!fs.existsSync(STR_FILE_PATH)) {
        return response.status(404).json({error: 'File not found'});
    }
    logRequest('GET /pdf/:filename', request.params.jobId, getTokenName(STR_API_KEY));
    // Schedule for cleanup after inactivity
    scheduleCleanup(request.params.jobId, STR_EXTRACT_FOLDER, '');
    // Return as base64 JSON so binary data is not mangled over HTTP
    const STR_CONTENT = fs.readFileSync(STR_FILE_PATH).toString('base64');
    response.json({ filename: path.basename(STR_FILE_PATH), content: STR_CONTENT });
});

/**
 * Since we can't process hundreds of files at once, instead we retrieve them on a file to file basis.
 * Each file is an API call and we just return the filename & contents
 */
OBJ_APP.get('/job/:jobId/xml/file', OBJ_FETCH_LIMITER, (request, response) => {
    const STR_API_KEY = request.headers['x-api-key'];

    // Validate the API key
    if (!STR_API_KEY || !isValidToken(STR_API_KEY)) {
        return response.status(401).json({ error: 'Unauthorized' });
    }

    const STR_EXTRACT_FOLDER = path.join('uploads', request.params.jobId);
    const STR_FILE_PATH = path.join(STR_EXTRACT_FOLDER, request.query.filename);
    // Make sure we resolve the path so people can't execute anything outside the specified folder
    const STR_RESOLVED_PATH = path.resolve(STR_FILE_PATH);
    const STR_RESOLVED_FOLDER = path.resolve(STR_EXTRACT_FOLDER);
    
    if (!STR_RESOLVED_PATH.startsWith(STR_RESOLVED_FOLDER)) {
        return response.status(400).json({ error: 'Invalid filename' });
    }

    if (!fs.existsSync(STR_FILE_PATH)) {
        return response.status(404).json({ error: 'File not found' });
    }

    logRequest('GET /xml/:filename', request.params.jobId, getTokenName(STR_API_KEY));

    scheduleCleanup(request.params.jobId, STR_EXTRACT_FOLDER, '');
    // Finally, obtain the data from the file and return it
    const STR_CONTENT = fs.readFileSync(STR_FILE_PATH).toString('base64');
    response.json({ filename: request.query.filename, content: STR_CONTENT });
});

OBJ_APP.listen(INT_PORT, () => {
    console.log(`Listening on port ${INT_PORT}`);
});
