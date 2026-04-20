/**
 * This script file generates/revokes API Tokens.
 * 
 * Owned by Shore-Interactive
 * Version 0.0.1
 * 
 */
const crypto = require('crypto');
const fs = require('fs');

const TOKENS_FILE = './tokens.json';

// Hash the token so it will remain private
function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

// Generate a token, hash it, and store it in our trusted tokens file
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

// Revoke tokens
function revokeToken(name) {
    const TOKENS = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    const ENTRY = Object.entries(TOKENS).find(([, v]) => v.name === name);

    if(!ENTRY) {
        console.log(`No token found for ${name}.`);
        return;
    }

    delete TOKENS[ENTRY[0]];
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(TOKENS, null, 2));
    console.log(`Token for ${name} has been revoked.`)
}

const [, , STR_COMMAND, STR_NAME] = process.argv;

// Depending on the command received, execute the respective function
if(STR_COMMAND === 'generate' && STR_NAME) {
    generateToken(STR_NAME);
} else if (STR_COMMAND === 'revoke' && STR_NAME) {
    revokeToken(STR_NAME);
} else {
    console.log('Usage:')
    console.log('   node token-manager.js generate "Customer Name"');
    console.log('   node token-manager.js revoke "Customer Name"');
}