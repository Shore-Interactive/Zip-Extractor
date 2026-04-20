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
const db = require('./db');
const rateLimit = require('express-rate-limit');

const OBJ_APP = express();
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
    max: 200,
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

// Clean up and left behind uploads from a previous server run (after shutdown, reboot, etc.)
if(fs.existsSync('uploads')) {
    fs.rmSync('uploads', {recursive: true, force: true});
    fs.mkdirSync('uploads');
}

// Automatically clean up the extracted folders after 5 minutes of inactivity
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
    }, 5 * 60 * 1000);
}

OBJ_APP.get('/', (_, response) => {
    response.send('Server is running');
});

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
    // Create a temporary folder to save the extracted files
    fs.mkdirSync(STR_EXTRACT_FOLDER, {recursive: true});
    // Log the time before extraction start
    const DT_START_TIME = Date.now();
    // Stream the file received via the request
    fs.createReadStream(request.file.path)
    .pipe(unzipper.Extract({path: STR_EXTRACT_FOLDER}))
    .on('close', () => {
        const ARR_FILES = fs.readdirSync(STR_EXTRACT_FOLDER);
        // Collect the file types in an array
        const ARR_XML_FILES = ARR_FILES.filter(f => f.endsWith('.xml'));
        const ARR_PDF_FILES = ARR_FILES.filter(f => f.endsWith('.pdf'));
        // Insert a log into the database for the successful extraction
        db.prepare(`
            INSERT INTO requests (timestamp, token_name, filename, file_size_bytes, job_id, processing_time_ms, status)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
                new Date().toISOString(),
                getTokenName(STR_API_KEY),
                request.file.originalname,
                request.file.size,
                STR_JOB_ID,
                Date.now() - DT_START_TIME,
                'SUCCESS'
            );

        console.log('Extracted to:', STR_EXTRACT_FOLDER);
        // Schedule the cleanup of the folder after 5 minutes
        scheduleCleanup(STR_JOB_ID, STR_EXTRACT_FOLDER, request.file.path);

        response.json({
            intJobId: STR_JOB_ID,
            objXMLFiles: ARR_XML_FILES,
            objPDFFiles: ARR_PDF_FILES,
            intTotalXML: ARR_XML_FILES.length,
            intTotalPDF: ARR_PDF_FILES.length
        });
    })
    .on('error', (ex) => {
        db.prepare(`
            INSERT INTO requests (timestamp, token_name, filename, file_size_bytes, job_id, processing_time_ms, status)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
                new Date().toISOString(),
                getTokenName(STR_API_KEY),
                request.file.originalname,
                request.file.size,
                STR_JOB_ID,
                Date.now() - DT_START_TIME,
                'ERROR'
            );
        response.status(500).json({error: 'Extraction failed', detail: ex.message});
    });
});

/**
 * Because we are limited by the 10MB file/response limit, we have to paginate the responses
 */
OBJ_APP.get('/job/:jobId/xml', OBJ_FETCH_LIMITER, (request, response) => {
    const STR_API_KEY = request.headers['x-api-key'];
    // Validate the API key
    if(!STR_API_KEY || !isValidToken(STR_API_KEY)) {
        return response.status(401).json({error: 'Unauthorized'});
    }
    // Set the correct page to retrieve the files from
    const INT_PAGE = parseInt(request.query.page) || 1;
    const INT_PAGE_SIZE = parseInt(request.query.size) || 50;

    const STR_EXTRACT_FOLDER = path.join('uploads', request.params.jobId);
    // Make sure the folder exists
    if(!fs.existsSync(STR_EXTRACT_FOLDER)) {
        return response.status(404).json({error: 'Job not found'});
    }
    // Read the directory and obtain all XML files
    const ARR_ALL_XML = fs.readdirSync(STR_EXTRACT_FOLDER).filter(f => f.endsWith('.xml'));
    const ARR_PAGE = ARR_ALL_XML.slice((INT_PAGE - 1) * INT_PAGE_SIZE, INT_PAGE * INT_PAGE_SIZE);

    const OBJ_XML_CONTENTS = {};
    for (const STR_FILE of ARR_PAGE) {
        const STR_FILE_PATH = path.join(STR_EXTRACT_FOLDER, STR_FILE);
        OBJ_XML_CONTENTS[STR_FILE] = fs.readFileSync(STR_FILE_PATH).toString('base64');
    }

    // Mark for cleanup after inactivity
    scheduleCleanup(request.params.jobId, STR_EXTRACT_FOLDER, '');

    response.json({
        page: INT_PAGE,
        pageSize: INT_PAGE_SIZE,
        totalFiles: ARR_ALL_XML.length,
        totalPages: Math.ceil(ARR_ALL_XML.length / INT_PAGE_SIZE),
        files: OBJ_XML_CONTENTS
    });
});

/**
 * Since we only have to obtain 1 PDF file per Invoice, we can retrieve them on a single fetch basis, instead of just pumping all the PDF files back
 */
OBJ_APP.get('/job/:jobId/pdf/:filename', OBJ_FETCH_LIMITER, (request, response) => {
    const STR_API_KEY = request.headers['x-api-key'];

    // Validate the API key
    if(!STR_API_KEY || !isValidToken(STR_API_KEY)) {
        return response.status(401).json({error: 'Unauthorized'});
    }
    // Define the folder/filepath from the parameters
    const STR_EXTRACT_FOLDER = path.join('uploads', request.params.jobId);
    const STR_FILE_PATH = path.join(STR_EXTRACT_FOLDER, request.params.filename);

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
    // Schedule for cleanup after inactivity
    scheduleCleanup(request.params.jobId, STR_EXTRACT_FOLDER, '');
    // Return the file
    response.download(STR_FILE_PATH);
});

OBJ_APP.listen(INT_PORT, () => {
    console.log(`Listening on port ${INT_PORT}`);
});
