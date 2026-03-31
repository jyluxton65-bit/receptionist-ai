require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'demo.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS demo_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    phone      TEXT NOT NULL,
    role       TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_demo_phone ON demo_messages(phone);
`);

function addMessage(phone, role, body) {
  db.prepare('INSERT INTO demo_messages (phone, role, body) VALUES (?, ?, ?)')
    .run(phone, role, body);
}

function getConversation(phone) {
  const rows = db.prepare(
    'SELECT role, body FROM demo_messages WHERE phone = ? ORDER BY created_at'
  ).all(phone);
  return rows.map(r => ({ role: r.role, content: r.body }));
}

function clearConversation(phone) {
  db.prepare('DELETE FROM demo_messages WHERE phone = ?').run(phone);
}

module.exports = { addMessage, getConversation, clearConversation };
