require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const path = require('path');
const fs   = require('fs');

const express = require('express');
const twilio  = require('twilio');
const cron    = require('node-cron');
const { google } = require('googleapis');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'https://receptionist-ai-production-1c42.up.railway.app/jake/save-token'
);
const { getJakeReply, parseJakeBooking, cleanJakeReply } = require('./jake-ai');
const {
  addMessage,
  getConversation,
  getRecentConversations,
  getProspects,
  markBooked,
  upsertProspect,
  markSent,
  resetConversation,
} = require('./jake-db');
const { runCampaign } = require('./send-campaign');
const { updateLastMessageAt, getProspectsNeedingFollowUp, markFollowUpSent, markClosed, isClosed } = require('./jake-db');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const twilioClient = twilio(
  process.env.JAKE_TWILIO_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID,
  process.env.JAKE_TWILIO_AUTH_TOKEN  || process.env.TWILIO_AUTH_TOKEN
);

const JAKE_FROM = process.env.JAKE_PHONE_NUMBER;

// ── Google OAuth startup diagnostics ─────────────────────────────────────────
console.log('\n🔑 [Jake] Google OAuth env check:');
console.log('  GOOGLE_CLIENT_ID:          ', process.env.GOOGLE_CLIENT_ID          ? '✅ present' : '❌ MISSING');
console.log('  GOOGLE_CLIENT_SECRET:      ', process.env.GOOGLE_CLIENT_SECRET      ? '✅ present' : '❌ MISSING');
console.log('  JAKE_GOOGLE_REFRESH_TOKEN: ', process.env.JAKE_GOOGLE_REFRESH_TOKEN ? '✅ present' : '❌ MISSING');
console.log('  JAKE_GOOGLE_CALENDAR_ID:   ', process.env.JAKE_GOOGLE_CALENDAR_ID   ? '✅ present' : '❌ MISSING');
console.log('  GOOGLE_REDIRECT_URI:       ', process.env.GOOGLE_REDIRECT_URI       ? '✅ present' : '❌ MISSING');

try {
  const { google: _g } = require('googleapis');
  const _a = new _g.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
  _a.setCredentials({ refresh_token: process.env.JAKE_GOOGLE_REFRESH_TOKEN });
  _a.getAccessToken().then(({ token }) => {
    console.log('  Access token fetch: ', token ? '✅ ok' : '❌ null');
  }).catch(err => {
    console.log('  Access token fetch: ❌', err.message);
  });
} catch (err) {
  console.log('  OAuth init error: ❌', err.message);
}

const OPENERS = [
  "Hey, quick question. What happens when a customer calls and you're up a tree and can't answer?",
  "Hi, just a quick one. When you're on a job and miss a call, do you usually get back to them or do they just go elsewhere?",
  "Hey, random question. How many enquiries do you reckon you miss a week when you're mid job or off the clock?",
  "Hi, just wanted to ask. What do you do with customer enquiries that come in after hours when you're done for the day?",
  "Hey quick question. If someone texts you about a job while you're up a tree, how long does it usually take you to get back to them?",
];

// ── Closing phrase detection ──────────────────────────────────────────────────
const CLOSING_PHRASES = new Set([
  'bye', 'goodbye', 'bye bye', 'ta ta',
  'cya', 'see ya', 'see you', 'see you later', 'catch you later', 'catch ya later',
  'in a bit',
  'take care', 'take it easy', 'all the best', 'cheers then',
  'cheers', 'thanks', 'ta', 'thank you',
  'not interested', 'not for me', 'no thanks', 'no thank you', 'nah thanks',
  'leave me alone', 'go away', 'stop texting', 'stop messaging me',
  'speak soon', 'laters', 'later',
]);

function isClosingMessage(text) {
  const norm = text.toLowerCase().replace(/[!?.,'']/g, '').trim();
  return CLOSING_PHRASES.has(norm);
}

// ── Google Calendar: book a Jake demo/onboard call ───────────────────────────
async function bookJakeCalendarEvent(booking, prospectPhone) {
  try {
    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI,
    );
    auth.setCredentials({ refresh_token: process.env.JAKE_GOOGLE_REFRESH_TOKEN });
    const calendar = google.calendar({ version: 'v3', auth });
    const title = `${booking.type} - ${booking.businessName} - ${booking.town}`;
    const description = [booking.description, '', `Phone: ${prospectPhone}`].join('\n');
    const startDt = parseJakeDatetime(booking.date, booking.time);
    const endDt   = new Date(startDt.getTime() + 30 * 60 * 1000);
    const event   = {
      summary: title, description,
      start: { dateTime: startDt.toISOString(), timeZone: 'Europe/London' },
      end:   { dateTime: endDt.toISOString(),   timeZone: 'Europe/London' },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] },
    };
    const resp = await calendar.events.insert({
      calendarId: process.env.JAKE_GOOGLE_CALENDAR_ID || 'primary',
      resource: event,
    });
    console.log(`📅 [Jake] Calendar event created: ${resp.data.htmlLink}`);
    return resp.data;
  } catch (err) {
    console.error('❌ [Jake] Calendar booking failed:', err.message);
  }
}

function parseJakeDatetime(dateStr, timeStr) {
  const now   = new Date();
  const date  = new Date();
  const lower = dateStr.toLowerCase().trim();
  if (lower === 'tomorrow') {
    date.setDate(now.getDate() + 1);
  } else {
    const days   = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const dayIdx = days.findIndex(d => lower.includes(d));
    if (dayIdx !== -1) {
      const diff = (dayIdx - now.getDay() + 7) % 7 || 7;
      date.setDate(now.getDate() + diff);
    }
  }
  const m = timeStr.match(/(\d+)(?::(\d+))?\s*(am|pm)?/i);
  if (m) {
    let h = parseInt(m[1]);
    const mins = parseInt(m[2] || '0');
    const ampm = (m[3] || '').toLowerCase();
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    date.setHours(h, mins, 0, 0);
  }
  return date;
}

// ── Per-phone message queue ───────────────────────────────────────────────────
const msgQueues = {};

// ── Typing delay ──────────────────────────────────────────────────────────────
function typingDelay() {
  const ms = Math.floor(20000 + Math.random() * 25000);
  return new Promise(resolve => setTimeout(resolve, ms));
}

app.post('/incoming', (req, res) => {
  const from = req.body.From;
  if (from === process.env.JAKE_PHONE_NUMBER) return res.sendStatus(200);
  const body = req.body.Body?.trim() || '';
  if (!body) return res.sendStatus(200);

  if (isClosed(from)) {
    console.log(`[Jake] Ignoring message from closed conversation: ${from}`);
    return res.sendStatus(200);
  }

  res.type('text/xml');
  res.send('<Response></Response>');

  if (!msgQueues[from]) msgQueues[from] = Promise.resolve();
  msgQueues[from] = msgQueues[from].then(async () => {
    console.log(`[Jake] Reply from ${from}: ${body}`);

    if (['stop','unsubscribe','quit','cancel'].includes(body.toLowerCase())) {
      console.log(`[Jake] Opt-out from ${from}`);
      return;
    }

    if (isClosingMessage(body)) {
      console.log(`[Jake] Closing message from ${from}: "${body}" — sending sign-off`);
      addMessage(from, 'user', body);
      markClosed(from);
      const signOff = 'No worries, take care! 👍';
      addMessage(from, 'assistant', signOff);
      await typingDelay();
      await twilioClient.messages.create({ body: signOff, from: JAKE_FROM, to: from });
      console.log(`✅ [Jake] Sign-off sent to ${from}`);
      return;
    }

    // Auto-reply loop detection
    const priorHistory = getConversation(from);
    const lastUserMsg  = [...priorHistory].reverse().find(m => m.role === 'user');
    if (lastUserMsg && lastUserMsg.content === body) {
      console.log(`[Jake] Auto-reply loop detected from ${from} — closing conversation`);
      markClosed(from);
      return;
    }

    addMessage(from, 'user', body);
    updateLastMessageAt(from);

    try {
      const history  = getConversation(from);
      const rawReply = await getJakeReply(history);
      const booking  = parseJakeBooking(rawReply);
      const reply    = cleanJakeReply(rawReply);

      addMessage(from, 'assistant', reply);

      if (booking) {
        console.log(`📅 [Jake] Booking detected: ${booking.type} - ${booking.businessName} @ ${booking.date} ${booking.time}`);
        await bookJakeCalendarEvent(booking, from);
        markBooked(from);
      } else if (/booked in|jay will (call|be in touch)/i.test(reply)) {
        markBooked(from);
      }

      await typingDelay();
      await twilioClient.messages.create({ body: reply, from: JAKE_FROM, to: from });
      console.log(`✅ [Jake] Replied to ${from}: ${reply}`);
    } catch (err) {
      console.error('❌ [Jake] Error:', err.message);
    }
  }).catch(err => console.error('[Jake] Queue error for', from, ':', err));
});

// ── Read-only admin API ───────────────────────────────────────────────────────
app.get('/api/conversations', (req, res) => res.json(getRecentConversations()));
app.get('/api/conversations/:phone', (req, res) => res.json(getConversation(decodeURIComponent(req.params.phone))));
app.get('/api/prospects', (req, res) => res.json(getProspects(req.query.status || null)));

// ── Calendar diagnostics ──────────────────────────────────────────────────────
app.get('/test-calendar', async (req, res) => {
  const results = {};
  results.envVars = {
    GOOGLE_CLIENT_ID:          !!process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET:      !!process.env.GOOGLE_CLIENT_SECRET,
    JAKE_GOOGLE_REFRESH_TOKEN: !!process.env.JAKE_GOOGLE_REFRESH_TOKEN,
    JAKE_GOOGLE_CALENDAR_ID:   !!process.env.JAKE_GOOGLE_CALENDAR_ID,
    GOOGLE_REDIRECT_URI:       !!process.env.GOOGLE_REDIRECT_URI,
  };
  try {
    const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
    auth.setCredentials({ refresh_token: process.env.JAKE_GOOGLE_REFRESH_TOKEN });
    const tokenResult = await auth.getAccessToken();
    results.accessToken = tokenResult.token ? 'ok' : 'null';
    const calendar   = google.calendar({ version: 'v3', auth });
    const now        = new Date();
    const calendarId = process.env.JAKE_GOOGLE_CALENDAR_ID || 'primary';
    const event      = await calendar.events.insert({
      calendarId,
      resource: {
        summary: '[TEST] Jake calendar diagnostic',
        description: 'Auto-created by /test-calendar — safe to delete',
        start: { dateTime: now.toISOString(),                              timeZone: 'Europe/London' },
        end:   { dateTime: new Date(now.getTime() + 30*60*1000).toISOString(), timeZone: 'Europe/London' },
      },
    });
    results.status    = 'SUCCESS';
    results.eventLink = event.data.htmlLink;
  } catch (err) {
    results.status = 'FAILED';
    results.error  = err.message;
  }
  res.json(results);
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/reset/:phone', (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  resetConversation(phone);
  console.log(`[Jake] Reset conversation for ${phone}`);
  res.send(`<h2>✅ Reset done</h2><p>Conversation cleared for <b>${phone}</b>.</p>`);
});

app.get('/text-me/:phone', async (req, res) => {
  const phone  = decodeURIComponent(req.params.phone);
  if (!JAKE_FROM) return res.status(500).send('<h2>❌ JAKE_PHONE_NUMBER not configured</h2>');
  const opener = OPENERS[Math.floor(Math.random() * OPENERS.length)];
  try {
    await twilioClient.messages.create({ body: opener, from: JAKE_FROM, to: phone });
    upsertProspect(phone, '', '');
    addMessage(phone, 'assistant', opener);
    markSent(phone);
    console.log(`[Jake] text-me sent to ${phone}: ${opener}`);
    res.send(`<h2>✅ Message sent!</h2><p>Sent to <b>${phone}</b>:</p><blockquote>${opener}</blockquote>`);
  } catch (err) {
    res.status(500).send(`<h2>❌ Error</h2><p>${err.message}</p>`);
  }
});

app.post('/send-campaign', async (req, res) => {
  const { contacts, dryRun } = req.body;
  if (!Array.isArray(contacts) || contacts.length === 0)
    return res.status(400).json({ error: 'contacts array required' });
  if (!JAKE_FROM)
    return res.status(500).json({ error: 'JAKE_PHONE_NUMBER not configured' });
  const RATE = 2000;
  let sent = 0, skipped = 0, failed = 0;
  res.json({ status: 'started', total: contacts.length, dryRun: !!dryRun });
  for (const c of contacts) {
    const phone = (c.phone || c.mobile || c.number || '').trim();
    if (!phone) { skipped++; continue; }
    if (getConversation(phone).length > 0) { skipped++; continue; }
    const opener = OPENERS[Math.floor(Math.random() * OPENERS.length)];
    upsertProspect(phone, c.name || '', c.business || '');
    if (dryRun) { sent++; continue; }
    try {
      await twilioClient.messages.create({ body: opener, from: JAKE_FROM, to: phone });
      addMessage(phone, 'assistant', opener);
      markSent(phone);
      sent++;
    } catch (err) { failed++; console.error(`[Jake] Campaign failed for ${phone}:`, err.message); }
    await new Promise(r => setTimeout(r, RATE));
  }
  console.log(`[Jake] Campaign done. Sent: ${sent} Skipped: ${skipped} Failed: ${failed}`);
});

app.get('/trigger-campaign',  async (req, res) => { try { await runCampaign('jake/contacts.csv'); res.send('ok'); } catch (e) { res.send('Error: ' + e.message); } });
app.post('/trigger-campaign', async (req, res) => {
  const csvPath = path.join(__dirname, 'contacts.csv');
  if (!fs.existsSync(csvPath)) return res.status(404).json({ error: 'contacts.csv not found' });
  if (!JAKE_FROM)               return res.status(500).json({ error: 'JAKE_PHONE_NUMBER not configured' });
  const lines    = fs.readFileSync(csvPath, 'utf-8').split('\n').map(l => l.trim()).filter(Boolean);
  const headers  = lines[0].split(',').map(h => h.trim().toLowerCase());
  const contacts = lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim());
    const obj  = {};
    headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
    return obj;
  });
  const dryRun = req.body.dryRun === true || req.query.dryRun === 'true';
  let sent = 0, skipped = 0, failed = 0;
  res.json({ status: 'started', total: contacts.length, dryRun, csv: csvPath });
  for (const c of contacts) {
    const phone = (c.phone || c.mobile || c.number || '').trim();
    if (!phone) { skipped++; continue; }
    if (getConversation(phone).length > 0) { skipped++; continue; }
    const opener = OPENERS[Math.floor(Math.random() * OPENERS.length)];
    upsertProspect(phone, c.name || '', c.business || '');
    if (dryRun) { sent++; continue; }
    try {
      await twilioClient.messages.create({ body: opener, from: JAKE_FROM, to: phone });
      addMessage(phone, 'assistant', opener);
      markSent(phone);
      sent++;
    } catch (err) { failed++; }
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log(`[Jake] trigger-campaign done. Sent: ${sent} Skipped: ${skipped} Failed: ${failed}`);
});

// ── Hourly follow-up job ─────────────────────────────────────────────────────
const COLD_FOLLOW_UP_MSG = "Hey, did you get my message the other day? Just wanted to make sure it didn't get lost 👍";
const FOLLOW_UP_MSG      = "Hey, just checking back in — still happy to jump on a quick call and show you how it works if you're interested. No pressure either way 👍";

setInterval(async () => {
  try {
    const prospects = getProspectsNeedingFollowUp();
    console.log(`🔔 [Jake] Follow-up check: ${prospects.length} prospect(s) eligible`);
    for (const p of prospects) {
      const hasReplied = getConversation(p.phone).some(m => m.role === 'user');
      try {
        await twilioClient.messages.create({
          body: hasReplied ? FOLLOW_UP_MSG : COLD_FOLLOW_UP_MSG,
          from: process.env.JAKE_PHONE_NUMBER,
          to:   p.phone,
        });
        addMessage(p.phone, 'assistant', hasReplied ? FOLLOW_UP_MSG : COLD_FOLLOW_UP_MSG);
        markFollowUpSent(p.phone);
        console.log(`✅ [Jake] Follow-up sent to ${p.phone} (${p.name || 'unknown'})`);
      } catch (err) {
        console.error(`❌ [Jake] Follow-up failed for ${p.phone}:`, err.message);
      }
    }
  } catch (err) {
    console.error('❌ [Jake] Follow-up job error:', err.message);
  }
}, 60 * 60 * 1000);

// ── Google re-auth ───────────────────────────────────────────────────────────
app.get('/reauth-google', (req, res) => {
  res.redirect(oauth2Client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/calendar'] }));
});
app.get('/save-token', async (req, res) => {
  const { tokens } = await oauth2Client.getToken(req.query.code);
  res.send(`Your new refresh token is: <b>${tokens.refresh_token}</b> — copy into JAKE_GOOGLE_REFRESH_TOKEN on Railway`);
});

// ── Scheduled batch campaigns with missed-window recovery ────────────────────
//
// Stores each batch in SQLite so a redeploy can detect if the scheduled window
// was missed and fire immediately (up to 2 hours late) instead of waiting a
// full week.

const Database = require('better-sqlite3');
const schedDb  = new Database(path.join(__dirname, '../data/jake.db'));

schedDb.exec(`
  CREATE TABLE IF NOT EXISTS jake_batch_schedule (
    label       TEXT PRIMARY KEY,
    csv_file    TEXT NOT NULL,
    cron_day    INTEGER NOT NULL,
    cron_hour   INTEGER NOT NULL,
    cron_minute INTEGER NOT NULL,
    last_fired  TEXT
  );
`);

function getLondonTime() {
  const now   = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone : 'Europe/London',
    weekday  : 'long',
    year     : 'numeric',
    month    : '2-digit',
    day      : '2-digit',
    hour     : '2-digit',
    minute   : '2-digit',
    hour12   : false,
  }).formatToParts(now);
  const get  = t => parts.find(p => p.type === t)?.value;
  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  return {
    dayOfWeek : days.indexOf(get('weekday').toLowerCase()), // 0=Sun … 6=Sat
    hour      : parseInt(get('hour')),
    minute    : parseInt(get('minute')),
    dateStr   : `${get('year')}-${get('month')}-${get('day')}`,
  };
}

async function fireBatch(label, csvFile) {
  console.log(`[Jake] Firing ${label}`);
  // Mark fired BEFORE sending so a mid-campaign restart doesn't double-fire
  schedDb.prepare('UPDATE jake_batch_schedule SET last_fired = ? WHERE label = ?')
         .run(getLondonTime().dateStr, label);
  try {
    const src  = path.join(__dirname, csvFile);
    const dest = path.join(__dirname, 'contacts.csv');
    fs.copyFileSync(src, dest);
    await runCampaign(dest);
  } catch (err) {
    console.error(`[Jake] ${label} error:`, err.message);
  }
}

function scheduleBatch(label, csvFile, cronDay, cronHour, cronMinute) {
  // Upsert — preserve last_fired so we never double-fire after a redeploy
  schedDb.prepare(`
    INSERT INTO jake_batch_schedule (label, csv_file, cron_day, cron_hour, cron_minute)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(label) DO UPDATE SET
      csv_file    = excluded.csv_file,
      cron_day    = excluded.cron_day,
      cron_hour   = excluded.cron_hour,
      cron_minute = excluded.cron_minute
  `).run(label, csvFile, cronDay, cronHour, cronMinute);

  const row      = schedDb.prepare('SELECT * FROM jake_batch_schedule WHERE label = ?').get(label);
  const london   = getLondonTime();
  const cronExpr = `${cronMinute} ${cronHour} * * ${cronDay}`;

  const isToday     = london.dayOfWeek === cronDay;
  const alreadyDone = row.last_fired === london.dateStr;
  const elapsed     = (london.hour * 60 + london.minute) - (cronHour * 60 + cronMinute);
  const inWindow    = elapsed >= 0 && elapsed < 120; // missed but within 2-hour recovery window

  if (isToday && !alreadyDone && inWindow) {
    // Missed the window due to a redeploy — fire immediately
    console.log(`[Jake] Missed-window recovery: ${label} (${elapsed}m late) — firing now`);
    setImmediate(() => fireBatch(label, csvFile));
  } else if (isToday && !alreadyDone && elapsed < 0) {
    // Scheduled time hasn't arrived yet today
    console.log(`[Jake] Scheduled ${label} for today at ${String(cronHour).padStart(2,'0')}:${String(cronMinute).padStart(2,'0')} London`);
    const task = cron.schedule(cronExpr, () => { task.stop(); fireBatch(label, csvFile); }, { timezone: 'Europe/London' });
  } else {
    // Either already fired today or not today's day — register for next occurrence
    if (alreadyDone) {
      console.log(`[Jake] ${label} already fired today — scheduled for next occurrence`);
    } else {
      console.log(`[Jake] Scheduled ${label} — next: ${cronExpr} Europe/London`);
    }
    const task = cron.schedule(cronExpr, () => { task.stop(); fireBatch(label, csvFile); }, { timezone: 'Europe/London' });
  }
}

// Tuesday  12:04 — yellow_batch_4
// Wednesday 11:07 — yellow_batch_5
// Thursday 14:07 — yellow_batch_8
// Friday   10:23 — yellow_batch_7
scheduleBatch('Yellow_Batch_4_Tue_12:04', 'yellow_batch_4_clean.csv', 2, 12,  4);
scheduleBatch('Yellow_Batch_5_Wed_11:07', 'yellow_batch_5_clean.csv', 3, 11,  7);
scheduleBatch('Yellow_Batch_8_Thu_14:07', 'yellow_batch_8_clean.csv', 4, 14,  7);
scheduleBatch('Yellow_Batch_7_Fri_10:23', 'yellow_batch_7_clean.csv', 5, 10, 23);

module.exports = app;
