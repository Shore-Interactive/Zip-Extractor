/**
 * This script file generates API Tokens.
 * 
 * Owned by 'Shore-Interactive'
 * Version 0.0.1
 * 
 */
const crypto = require('crypto');
const fs = require('fs');

const TOKENS_FILE = './tokens.json';

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function generateToken(name) {
    const TOKEN = crypto.randomBytes(32).toString('hex');
    const HASH = hashToken(TOKEN);

    const TOKENS = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    TOKENS[HASH] = {
        name,
        createdAt: new Date().toISOString()
    };
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(TOKENS, null, 2));

    console.log(`Token for ${name}: ${TOKEN}`);
    console.log('Store this somewhere safe - it will not be shown again.');
}

const [, , command, name] = process.argv;

if(command === 'generate' && name) {
    generateToken(name);
} else {
    console.log('Usage: node token-manager.js generate "Customer Name"');
}