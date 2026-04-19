/**
 * This script contains the Node.js functions for the decompressing of the zip file
 * 
 * Owned by 'Shore-Interactive'
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

const app = express();
// Important - Limit the File Size to 80MB for now, as it is the largest example we have seen
const upload = multer({
    dest: 'uploads/',
    limits: {fileSize: 100 * 1024 * 1024}
});

// Limit the amount of uploads PER 15 MINUTES
const uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: {error: 'Too many uploads, please try again later'}
});
// Limit the amount of fetches PER 15 MINUTES
const fetchLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: {error: 'Too many requests, please try again later'}
});

const PORT = 3000;

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

const objCleanupTimers = {};

// Clean up and left behind uploads from a previous server run (after shutdown, reboot, etc.)
if(fs.existsSync('uploads')) {
    fs.rmSync('uploads', {recursive: true, force: true});
    fs.mkdirSync('uploads');
}

// Automatically clean up the extracted folders after 5 minutes of inactivity
// This way we don't hold on to sensitive data and prevent the server from getting full
function scheduleCleanup(strJobId, strFolder, strUploadedFile) {
    if(objCleanupTimers[strJobId]) {
        clearTimeout(objCleanupTimers[strJobId]);
    }

    objCleanupTimers[strJobId] = setTimeout(() => {
        fs.rmSync(strFolder, {recursive: true, force: true});
        fs.rmSync(strUploadedFile, {force: true});
        delete objCleanupTimers[strJobId]
        console.log('Cleaned up job:', strFolder)
    }, 5 * 60 * 1000);
}

app.get('/', (request, response) => {
    response.send('Server is running');
});

app.post('/extract', uploadLimiter, upload.single('zipfile'), (request, response) => {
    // Retrieve the API key from the request header
    const API_KEY = request.headers['x-api-key'];

    // Match it against the saved (hashed) tokens
    if(!API_KEY || !isValidToken(API_KEY)) {
        return response.status(401).json({error: 'Unauthorized'});
    }

    if(!request.file) {
        return response.status(400).json({error: 'No file uploaded'});
    }

    // If code reaches this stage, all is well, so start extraction
    const intJobId = crypto.randomUUID();
    const strExtractFolder = path.join('uploads', intJobId);
    // Create a temporary folder to save the extracted files
    fs.mkdirSync(strExtractFolder, {recursive: true});
    // Log the time before extraction start
    const dtStartTime = Date.now();
    // Stream the file received via the request
    fs.createReadStream(request.file.path)
    .pipe(unzipper.Extract({path: strExtractFolder}))
    .on('close', () => {
        const arrFiles = fs.readdirSync(strExtractFolder)
        // Collect the file types in an array
        const arrXMLFiles = arrFiles.filter(f => f.endsWith('.xml'))
        const arrPDFFiles = arrFiles.filter(f => f.endsWith('.pdf'))
        // Insert a log into the database for the successful extraction
        db.prepare(`
            INSERT INTO requests (timestamp, token_name, filename, file_size_bytes, job_id, processing_time_ms, status)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
                new Date().toISOString(),
                getTokenName(API_KEY),
                request.file.originalname,
                request.file.size,
                intJobId,
                Date.now() - dtStartTime,
                'SUCCESS'
            );

        console.log('Extracted to:', strExtractFolder)
        // Schedule the cleanup of the folder after 5 minutes
        scheduleCleanup(intJobId, strExtractFolder, request.file.path);

        response.json({
            intJobId: intJobId,
            objXMLFiles: arrXMLFiles,
            objPDFFiles: arrPDFFiles,
            intTotalXML: arrXMLFiles.length,
            intTotalPDF: arrPDFFiles.length
        })
    })
    .on('error', (ex) => {
        db.prepare(`
            INSERT INTO requests (timestamp, token_name, filename, file_size_bytes, job_id, processing_time_ms, status)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
                new Date().toISOString(),
                getTokenName(API_KEY),
                request.file.originalname,
                request.file.size,
                intJobId,
                Date.now() - dtStartTime,
                'ERROR'
            );
        response.status(500).json({error: 'Extraction failed', detail: ex.message})
    })
})

/**
 * Because we are limited by the 10MB file/response limit, we have to paginate the responses
 */
app.get('/job/:jobId/xml', fetchLimiter, (request, response) => {
    const API_KEY = request.headers['x-api-key'];
    // Validate the API key
    if(!API_KEY || !isValidToken(API_KEY)) {
        return response.status(401).json({error: 'Unauthorized'});
    }
    // Set the correct page to retrieve the files from
    const intPage = parseInt(request.query.page) || 1;
    const intPageSize = parseInt(request.query.size) || 50;

    const strExtractFolder = path.join('uploads', request.params.jobId);
    // Make sure the folder exists
    if(!fs.existsSync(strExtractFolder)) {
        return response.status(404).json({error: 'Job not found'});
    }
    // Read the directory and obtain all XML files
    const arrAllXML = fs.readdirSync(strExtractFolder).filter(f => f.endsWith('.xml'));
    const arrPage = arrAllXML.slice((intPage - 1) * intPageSize, intPage * intPageSize)

    const objXMLContents = {};
    for (const strFile of arrPage) {
        const strFilePath = path.join(strExtractFolder, strFile);
        objXMLContents[strFile] = fs.readFileSync(strFilePath).toString('base64');
    }

    // Mark for cleanup after inactivity
    scheduleCleanup(request.params.jobId, strExtractFolder, '');

    response.json({
        page: intPage,
        pageSize: intPageSize,
        totalFiles: arrAllXML.length,
        totalPages: Math.ceil(arrAllXML.length / intPageSize),
        files: objXMLContents
    })
})

/**
 * Since we only have to obtain 1 PDF file per Invoice, we can retrieve them on a single fetch basis, instead of just pumping all the PDF files back
 */
app.get('/job/:jobId/pdf/:filename', fetchLimiter, (request, response) => {
    const API_KEY = request.headers['x-api-key'];

    // Validate the API key
    if(!API_KEY || !isValidToken(API_KEY)) {
        return response.status(401).json({error: 'Unauthorized'})
    }
    // Define the folder/filepath from the parameters
    const strExtractFolder = path.join('uploads', request.params.jobId);
    const strFilePath = path.join(strExtractFolder, request.params.filename);

    const strResolvedPath = path.resolve(strFilePath)
    const strResolvedFolder = path.resolve(strExtractFolder)

    // Resolve the paths to make sure that the job is always executed in the job folder
    // This way we can contain any injections
    if(!strResolvedPath.startsWith(strResolvedFolder)) {
        return response.status(400).json({error: 'Invalid filename'});
    }

    // Check if the filepath exists on the server
    if(!fs.existsSync(strFilePath)) {
        return response.status(404).json({error: 'File not found'});
    }
    // Schedule for cleanup after inactivity
    scheduleCleanup(request.params.jobId, strExtractFolder, '');
    // Return the file
    response.download(strFilePath)
})

app.listen(PORT, () => {
    console.log(`Listening on port ${PORT}`);
});