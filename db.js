/**
 * SQLite persistence layer
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data/grafted.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let _db;
function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        content TEXT,
        media_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS appointments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT NOT NULL,
        summary TEXT,
        start_time DATETIME,
        google_event_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS photo_quotes (
        id TEXT PRIMARY KEY,
        phone TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        submitted_at DATETIME,
        image_data TEXT,
        image_mime TEXT DEFAULT 'image/jpeg',
        assessment TEXT,
        quote_sent TEXT,
        used INTEGER DEFAULT 0
      );
      INSERT OR IGNORE INTO settings(key,value) VALUES
        ('bot_enabled','true'),
        ('day_rate','350'),
        ('half_day_rate','200'),
        ('small_job_rate','80');
    `);
  }
  return _db;
}

function getConversation(p) {
  return getDb().prepare(`SELECT role, content as text FROM conversations WHERE phone=? ORDER BY created_at ASC LIMIT 20`).all(p).map(r => ({ role: r.role, content: r.text || '' }));
}
function addMessage(p, r, c, m) {
  getDb().prepare(`INSERT INTO conversations(phone,role,content,media_url) VALUES(?,?,?,?)`).run(p, r, c || null, m || null);
}
function clearConversation(p) {
  getDb().prepare(`DELETE FROM conversations WHERE phone=?`).run(p);
}
function getRecentConversations(l = 50) {
  return getDb().prepare(`
    SELECT phone, MAX(created_at) AS last_message, COUNT(*) AS message_count,
    (SELECT content FROM conversations c2 WHERE c2.phone=c.phone ORDER BY c2.created_at DESC LIMIT 1) AS last_body
    FROM conversations c GROUP BY phone ORDER BY last_message DESC LIMIT ?
  `).all(l);
}
function getConversationHistory(p, l = 40) {
  return getDb().prepare(`SELECT role, content, media_url, created_at FROM conversations WHERE phone=? ORDER BY created_at ASC LIMIT ?`).all(p, l);
}
function getSetting(k) {
  const r = getDb().prepare(`SELECT value FROM settings WHERE key=?`).get(k);
  return r ? r.value : null;
}
function setSetting(k, v) {
  getDb().prepare(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(k, String(v));
}
function getAllSettings() {
  const r = getDb().prepare(`SELECT key, value FROM settings`).all();
  return Object.fromEntries(r.map(x => [x.key, x.value]));
}
function saveAppointment({ phone, summary, startTime, googleEventId }) {
  getDb().prepare(`INSERT INTO appointments(phone,summary,start_time,google_event_id) VALUES(?,?,?,?)`).run(phone, summary || null, startTime || null, googleEventId || null);
}
function getRecentAppointments(l = 20) {
  return getDb().prepare(`SELECT * FROM appointments ORDER BY created_at DESC LIMIT ?`).all(l);
}

// ââ Photo quotes ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
function createQuoteRequest(id, phone) {
  getDb().prepare(`INSERT INTO photo_quotes(id,phone) VALUES(?,?)`).run(id, phone);
}
function getQuoteRequest(id) {
  return getDb().prepare(`SELECT * FROM photo_quotes WHERE id=?`).get(id);
}
function fulfillQuoteRequest(id, { imageData, imageMime, assessment, quoteSent }) {
  getDb().prepare(`
    UPDATE photo_quotes
    SET image_data=?, image_mime=?, assessment=?, quote_sent=?,
        submitted_at=CURRENT_TIMESTAMP, used=1
    WHERE id=?
  `).run(imageData, imageMime || 'image/jpeg', assessment, quoteSent, id);
}
function getRecentPhotoQuotes(l = 50) {
  return getDb().prepare(`
    SELECT id, phone, created_at, submitted_at, assessment, quote_sent, used
    FROM photo_quotes ORDER BY created_at DESC LIMIT ?
  `).all(l);
}

module.exports = {
  getConversation, addMessage, clearConversation,
  getRecentConversations, getConversationHistory,
  getSetting, setSetting, getAllSettings,
  saveAppointment, getRecentAppointments,
  createQuoteRequest, getQuoteRequest, fulfillQuoteRequest, getRecentPhotoQuotes,
};
