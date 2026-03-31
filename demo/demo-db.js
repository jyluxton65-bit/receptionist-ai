require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const Database = require('better-sqlite3');
const path = require('path');
const fs   = require('fs');

const DATA_DIR = path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'demo.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    phone      TEXT PRIMARY KEY,
    messages   TEXT NOT NULL DEFAULT '[]',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// ── Conversations ─────────────────────────────────────────────────────────────

function addMessage(phone, role, content) {
  const row  = db.prepare('SELECT messages FROM conversations WHERE phone = ?').get(phone);
  const msgs = row ? JSON.parse(row.messages) : [];
  msgs.push({ role, content });
  db.prepare(`
    INSERT INTO conversations (phone, messages, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(phone) DO UPDATE
      SET messages   = excluded.messages,
          updated_at = CURRENT_TIMESTAMP
  `).run(phone, JSON.stringify(msgs));
}

function getConversation(phone) {
  const row = db.prepare('SELECT messages FROM conversations WHERE phone = ?').get(phone);
  return row ? JSON.parse(row.messages) : [];
}

function getRecentConversations(limit = 20) {
  return db
    .prepare('SELECT phone, messages, updated_at FROM conversations ORDER BY updated_at DESC LIMIT ?')
    .all(limit)
    .map(r => ({ phone: r.phone, messages: JSON.parse(r.messages), updated_at: r.updated_at }));
}

function clearConversation(phone) {
  db.prepare('DELETE FROM conversations WHERE phone = ?').run(phone);
}

// ── State (pause, etc.) ───────────────────────────────────────────────────────

function getState(key, defaultVal = null) {
  const row = db.prepare('SELECT value FROM state WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : defaultVal;
}

function setState(key, value) {
  db.prepare('INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
}

// Convenience helpers
function isPaused()     { return getState('paused', false); }
function setPaused(val) { setState('paused', Boolean(val)); }

module.exports = {
  addMessage,
  getConversation,
  getRecentConversations,
  clearConversation,
  isPaused,
  setPaused,
};
