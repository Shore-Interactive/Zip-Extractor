const express = require('express');
const multer = require('multer');
const unzipper = require('unzipper');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const upload = multer({dest: 'uploads/'});
const PORT = 3000;

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function isValidToken(token) {
    const TOKENS = JSON.parse(fs.readFileSync('./tokens.json', 'utf8'));
    return !!TOKENS[hashToken(token)];
}

app.get('/', (request, response) => {
    response.send('Server is running');
});

app.post('/extract', upload.single('zipfile'), (request, response) => {
    const API_KEY = request.headers['x-api-key'];

    if(!API_KEY || !isValidToken(API_KEY)) {
        return response.status(401).json({error: 'Unauthorized'});
    }

    if(!request.file) {
        return response.status(400).json({error: 'No file uploaded'});
    }

    console.log('Received file:', request.file.originalname);
    response.json({message: 'File received'})
})

app.listen(PORT, () => {
    console.log(`Listening on port ${PORT}`);
});