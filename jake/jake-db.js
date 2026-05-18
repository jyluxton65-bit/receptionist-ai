require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'jake.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS jake_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone      TEXT NOT NULL,
  role       TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_jake_phone ON jake_messages(phone);

CREATE TABLE IF NOT EXISTS jake_prospects (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  phone           TEXT UNIQUE NOT NULL,
  name            TEXT,
  business        TEXT,
  status          TEXT DEFAULT 'pending',
  sent_at         DATETIME,
  last_message_at DATETIME,
  follow_up_sent  INTEGER DEFAULT 0,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

// ── Messages ─────────────────────────────────────────────────────────────

function addMessage(phone, role, body) {
  db.prepare('INSERT INTO jake_messages (phone, role, body) VALUES (?, ?, ?)')
    .run(phone, role, body);
}

function getConversation(phone) {
  const rows = db.prepare(
    'SELECT role, body FROM jake_messages WHERE phone = ? ORDER BY created_at'
  ).all(phone);
  return rows.map(r => ({ role: r.role, content: r.body }));
}

function getRecentConversations(limit = 50) {
  return db.prepare(`
    SELECT phone, MAX(created_at) AS last_message,
      (SELECT body FROM jake_messages m2 WHERE m2.phone = m1.phone ORDER BY created_at DESC LIMIT 1) AS last_body,
      (SELECT role FROM jake_messages m2 WHERE m2.phone = m1.phone ORDER BY created_at DESC LIMIT 1) AS last_role
    FROM jake_messages m1
    GROUP BY phone
    ORDER BY last_message DESC
    LIMIT ?
  `).all(limit);
}

// ── Prospects ─────────────────────────────────────────────────────────────────

function upsertProspect(phone, name = '', business = '') {
  db.prepare(`
    INSERT INTO jake_prospects (phone, name, business)
    VALUES (?, ?, ?)
    ON CONFLICT(phone) DO NOTHING
  `).run(phone, name, business);
}

function markSent(phone) {
  db.prepare(`
    UPDATE jake_prospects SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE phone = ?
  `).run(phone);
}

function markBooked(phone) {
  db.prepare(`UPDATE jake_prospects SET status = 'booked' WHERE phone = ?`).run(phone);
}

function getProspects(status = null) {
  if (status) {
    return db.prepare('SELECT * FROM jake_prospects WHERE status = ? ORDER BY created_at DESC').all(status);
  }
  return db.prepare('SELECT * FROM jake_prospects ORDER BY created_at DESC').all();
}

function resetConversation(phone) {
  db.prepare('DELETE FROM jake_messages WHERE phone = ?').run(phone);
  db.prepare('DELETE FROM jake_prospects WHERE phone = ?').run(phone);
}

// ── Follow-up helpers ─────────────────────────────────────────────────────────────

function updateLastMessageAt(phone) {
  db.prepare(`
    UPDATE jake_prospects SET last_message_at = CURRENT_TIMESTAMP WHERE phone = ?
  `).run(phone);
}

function getProspectsNeedingFollowUp() {
  return db.prepare(`
    SELECT * FROM jake_prospects
    WHERE status = 'sent'
      AND follow_up_sent = 0
      AND (
        last_message_at IS NULL AND sent_at <= datetime('now', '-3 days')
        OR
        last_message_at <= datetime('now', '-3 days')
      )
  `).all();
}

function markFollowUpSent(phone) {
  db.prepare(`
    UPDATE jake_prospects SET follow_up_sent = 1 WHERE phone = ?
  `).run(phone);
}

module.exports = {
  addMessage,
  getConversation,
  getRecentConversations,
  upsertProspect,
  markSent,
  markBooked,
  getProspects,
  resetConversation,
  updateLastMessageAt,
  getProspectsNeedingFollowUp,
  markFollowUpSent,
};
