const Database = require('better-sqlite3');
const db = new Database('logs.db');

db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    token_name TEXT,
    filename TEXT,
    file_size_bytes INTEGER,
    job_id TEXT,
    processing_time_ms INTEGER,
    status TEXT
    )
`);

module.exports = db;