/**
 * SQLite persistence layer
 * Replaces in-memory conversations.js with persistent storage
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
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        phone      TEXT NOT NULL,
        role       TEXT NOT NULL CHECK(role IN ('user','assistant')),
        content    TEXT,
        media_url  TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS appointments (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        phone           TEXT NOT NULL,
        summary         TEXT,
        start_time      DATETIME,
        google_event_id TEXT,
        created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO settings (key, value) VALUES
        ('bot_enabled', 'true'),
        ('day_rate', '350'),
        ('half_day_rate', '200'),
        ('small_job_rate', '80');
    `);
  }
  return _db;
}

function getConversation(phone) {
  return getDb().prepare(`SELECT role, content as text FROM conversations WHERE phone = ? ORDER BY created_at ASC LIMIT 20`).all(phone).map(r => ({ role: r.role, content: r.text || '' }));
}
function addMessage(phone, role, content, mediaUrl) {
  getDb().prepare(`INSERT INTO conversations (phone, role, content, media_url) VALUES (?, ?, ?, ?)`).run(phone, role, content || null, mediaUrl || null);
}
function clearConversation(phone) {
  getDb().prepare(`DELETE FROM conversations WHERE phone = ?`).run(phone);
}
function getRecentConversations(limit = 50) {
  return getDb().prepare(`SELECT phone,MAX(created_at) AS last_message,COUNT(*) AS message_count,(SELECT content FROM conversations c2 WHERE c2.phone=c.phone ORDER BY c2.created_at DESC LIMIT 1) AS last_body FROM conversations c GROUP BY phone ORDER BY last_message DESC LIMIT ?`).all(limit);
}
function getConversationHistory(phone, limit = 40) {
  return getDb().prepare(`SELECT role,content,media_url,created_at FROM conversations WHERE phone=? ORDER BY created_at ASC LIMIT ?`).all(phone,limit);
}
function getSetting(key) { const row=getDb().prepare(`SELECT value FROM settings WHERE key=?`).get(key); return row?row.value:null; }
function setSetting(key,value) { getDb().prepare(`INSERT INTO settings(key,value)VALUES(?,?) ON CONFLICT(key) DOUPDATE SET value=excluded.value`).run(key,String(value)); }
function getAllSettings() { const rows=getDb().prepare(`SELECT key,value FROM settings`).all(); return Object.fromEntries(rows.map(r=>[r.key,r.value])); }
function saveAppointment({phone,summary,startTime,googleEventId}) { getDb().prepare(`INSERT INTO appointments(phone,summary,start_time,google_event_id)VALUES(?,?,?,?)`).run(phone,summary||null,startTime||null,googleEventId||null); }
function getRecentAppointments(limit=20) { return getDb().prepare(`SELECT* FROM appointments ORDER BY created_at DESC LIMIT?`).all(limit); }

module.exports={getConversation,addMessage,clearConversation,getRecentConversations,getConversationHistory,getSetting,setSetting,getAllSettings,saveAppointment,getRecentAppointments};
