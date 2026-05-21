require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express  = require('express');
const twilio   = require('twilio');
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
const { updateLastMessageAt, getProspectsNeedingFollowUp, markFollowUpSent } = require('./jake-db');


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
console.log('  GOOGLE_CLIENT_ID:     ', process.env.GOOGLE_CLIENT_ID     ? '✅ present' : '❌ MISSING');
console.log('  GOOGLE_CLIENT_SECRET: ', process.env.GOOGLE_CLIENT_SECRET ? '✅ present' : '❌ MISSING');
console.log('  JAKE_GOOGLE_REFRESH_TOKEN: ', process.env.JAKE_GOOGLE_REFRESH_TOKEN ? '✅ present' : '❌ MISSING');
console.log('  JAKE_GOOGLE_CALENDAR_ID:   ', process.env.JAKE_GOOGLE_CALENDAR_ID   ? '✅ present' : '❌ MISSING');
console.log('  GOOGLE_REDIRECT_URI:  ', process.env.GOOGLE_REDIRECT_URI  ? '✅ present' : '❌ MISSING');

// Quick OAuth token check
try {
  const { google: _google } = require('googleapis');
  const _auth = new _google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
  _auth.setCredentials({ refresh_token: process.env.JAKE_GOOGLE_REFRESH_TOKEN });
  _auth.getAccessToken().then(({ token }) => {
    console.log('  Access token fetch:  ', token ? '✅ success (token starts: ' + token.substring(0, 20) + '...)' : '❌ returned null');
  }).catch(err => {
    console.log('  Access token fetch:  ❌ FAILED —', err.message);
  });
} catch (err) {
  console.log('  OAuth init error:    ❌', err.message);
}


const OPENERS = [
  "Hey, quick question. What happens when a customer calls and you're up a tree and can't answer?",
  "Hi, just a quick one. When you're on a job and miss a call, do you usually get back to them or do they just go elsewhere?",
  "Hey, random question. How many enquiries do you reckon you miss a week when you're mid job or off the clock?",
  "Hi, just wanted to ask. What do you do with customer enquiries that come in after hours when you're done for the day?",
  "Hey quick question. If someone texts you about a job while you're up a tree, how long does it usually take you to get back to them?",
];

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

    // Title: "DEMO - Manchester Tree Care - Didsbury"
    const title = `${booking.type} - ${booking.businessName} - ${booking.town}`;

    // Full description with everything Jake collected
    const description = [
      booking.description,
      '',
      `Phone: ${prospectPhone}`,
    ].join('\n');

    const startDt = parseJakeDatetime(booking.date, booking.time);
    const endDt   = new Date(startDt.getTime() + 30 * 60 * 1000); // 30-min slot

    const event = {
      summary: title,
      description,
      start: { dateTime: startDt.toISOString(), timeZone: 'Europe/London' },
      end:   { dateTime: endDt.toISOString(),   timeZone: 'Europe/London' },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 30 },
        ],
      },
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

// Simple date/time parser (mirrors calendar.js)
function parseJakeDatetime(dateStr, timeStr) {
  const now  = new Date();
  const date = new Date();
  const lower = dateStr.toLowerCase().trim();

  if (lower === 'tomorrow') {
    date.setDate(now.getDate() + 1);
  } else {
    const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
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

// ── Inbound reply from a prospect ────────────────────────────────────────────
const msgQueues = {}; // per-phone queue — prevents double-handling

app.post('/incoming', (req, res) => {
  const from = req.body.From;
  const body = req.body.Body?.trim() || '';

  // Respond to Twilio immediately — prevents webhook timeout on slow AI responses
  res.type('text/xml');
  res.send('<Response></Response>');

  // Queue per phone number to prevent double-handling if messages arrive close together
  if (!msgQueues[from]) msgQueues[from] = Promise.resolve();
  msgQueues[from] = msgQueues[from].then(async () => {
    console.log(`[Jake] Reply from ${from}: ${body}`);

    // TODO (production): uncomment the line below to add a human-like delay before replying
    // await new Promise(r => setTimeout(r, 25000 + Math.random() * 5000));

    // Opt-out handling (Twilio handles STOP compliance automatically)
    if (['stop', 'unsubscribe', 'quit', 'cancel'].includes(body.toLowerCase())) {
      console.log(`[Jake] Opt-out from ${from}`);
      return;
    }

    addMessage(from, 'user', body);
    updateLastMessageAt(from);

    try {
      const history   = getConversation(from);
      const rawReply  = await getJakeReply(history);
      const booking   = parseJakeBooking(rawReply);
      const reply     = cleanJakeReply(rawReply);

      addMessage(from, 'assistant', reply);

      // If a booking tag was detected, create the Calendar event and flag the prospect
      if (booking) {
        console.log(`📅 [Jake] Booking detected: ${booking.type} - ${booking.businessName} @ ${booking.date} ${booking.time}`);
        await bookJakeCalendarEvent(booking, from);
        markBooked(from);
      } else if (/booked in|jay will (call|be in touch)/i.test(reply)) {
        // Fallback: flag as booked even without a tag
        markBooked(from);
      }

      await twilioClient.messages.create({
        body: reply,
        from: JAKE_FROM,
        to: from,
      });

      console.log(`✅ [Jake] Replied to ${from}: ${reply}`);
    } catch (err) {
      console.error('❌ [Jake] Error:', err.message);
    }
  }).catch(err => console.error('[Jake] Queue error for', from, ':', err));
})

// ── Simple read-only admin API ────────────────────────────────────────────────
app.get('/api/conversations', (req, res) => {
  res.json(getRecentConversations());
});

app.get('/api/conversations/:phone', (req, res) => {
  res.json(getConversation(decodeURIComponent(req.params.phone)));
});

app.get('/api/prospects', (req, res) => {
  const { status } = req.query;
  res.json(getProspects(status || null));
});

// ── Health ────────────────────────────────────────────────────────────────────
// ── Calendar diagnostics ─────────────────────────────────────────────────────
app.get('/test-calendar', async (req, res) => {
  const results = {};

  // Check env vars
  results.envVars = {
    GOOGLE_CLIENT_ID:     !!process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: !!process.env.GOOGLE_CLIENT_SECRET,
    JAKE_GOOGLE_REFRESH_TOKEN: !!process.env.JAKE_GOOGLE_REFRESH_TOKEN,
    JAKE_GOOGLE_CALENDAR_ID:   !!process.env.JAKE_GOOGLE_CALENDAR_ID,
    GOOGLE_REDIRECT_URI:  !!process.env.GOOGLE_REDIRECT_URI,
  };

  // Try fetching an access token
  try {
    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI,
    );
    auth.setCredentials({ refresh_token: process.env.JAKE_GOOGLE_REFRESH_TOKEN });

    const tokenResult = await auth.getAccessToken();
    results.accessToken = tokenResult.token ? 'ok (starts: ' + tokenResult.token.substring(0, 20) + '...)' : 'null';

    // Try creating a test event
    const calendar = google.calendar({ version: 'v3', auth });
    const now = new Date();
    const end = new Date(now.getTime() + 30 * 60 * 1000);

    const calendarId = process.env.JAKE_GOOGLE_CALENDAR_ID || 'primary';
    results.calendarId = calendarId;

    const event = await calendar.events.insert({
      calendarId,
      resource: {
        summary: '[TEST] Jake calendar diagnostic',
        description: 'Auto-created by /test-calendar endpoint — safe to delete',
        start: { dateTime: now.toISOString(), timeZone: 'Europe/London' },
        end:   { dateTime: end.toISOString(), timeZone: 'Europe/London' },
      },
    });

    results.eventCreated = true;
    results.eventId = event.data.id;
    results.eventLink = event.data.htmlLink;
    results.status = 'SUCCESS';
  } catch (err) {
    results.error = err.message;
    results.errorCode = err.code;
    results.errorDetails = err.errors || null;
    results.status = 'FAILED';
  }

  res.json(results);
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Testing helpers (browser-friendly GET endpoints) ─────────────────────────

// Reset a conversation — just visit this URL in your browser:
// https://receptionist-ai-production-1c42.up.railway.app/jake/reset/+447700900001
app.get('/reset/:phone', (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  resetConversation(phone);
  console.log(`[Jake] Reset conversation for ${phone}`);
  res.send(`<h2>✅ Reset done</h2><p>Conversation cleared for <b>${phone}</b>. Jake will treat this number as brand new.</p>`);
});

// Have Jake text you first — just visit this URL in your browser:
// https://receptionist-ai-production-1c42.up.railway.app/jake/text-me/+447700900001
app.get('/text-me/:phone', async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
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
    console.error(`[Jake] text-me error: ${err.message}`);
    res.status(500).send(`<h2>❌ Error</h2><p>${err.message}</p>`);
  }
});

// ── Manual campaign trigger ──────────────────────────────────────────────────
app.post('/send-campaign', async (req, res) => {
  const { contacts, dryRun } = req.body;
  if (!Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ error: 'contacts array required. Body: { contacts: [{phone, name, business}] }' });
  }
  if (!JAKE_FROM) {
    return res.status(500).json({ error: 'JAKE_PHONE_NUMBER not configured' });
  }

  const RATE_LIMIT_MS = 2000;
  let sent = 0, skipped = 0, failed = 0;

  // Respond immediately, process async
  res.json({ status: 'started', total: contacts.length, dryRun: !!dryRun });

  for (const contact of contacts) {
    const phone = (contact.phone || contact.mobile || contact.number || '').trim();
    if (!phone) { skipped++; continue; }
    if (getConversation(phone).length > 0) {
      console.log(`[Jake] Skipping ${phone} — already in conversation`);
      skipped++;
      continue;
    }
    const opener = OPENERS[Math.floor(Math.random() * OPENERS.length)];
    upsertProspect(phone, contact.name || '', contact.business || '');
    if (dryRun) {
      sent++;
      console.log(`[Jake] DRY RUN — would send to ${phone}: ${opener}`);
      continue;
    }
    try {
      await twilioClient.messages.create({ body: opener, from: JAKE_FROM, to: phone });
      addMessage(phone, 'assistant', opener);
      markSent(phone);
      sent++;
      console.log(`[Jake] Campaign sent to ${phone}`);
    } catch (err) {
      failed++;
      console.error(`[Jake] Campaign failed for ${phone}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
  }
  console.log(`[Jake] Campaign done. Sent: ${sent} Skipped: ${skipped} Failed: ${failed}`);
});

// ── Campaign trigger — reads jake/contacts.csv from disk ─────────────────────
app.post('/trigger-campaign', async (req, res) => {
  const fs = require('fs');
  const csvPath = path.join(__dirname, 'contacts.csv');

  if (!fs.existsSync(csvPath)) {
    return res.status(404).json({ error: 'contacts.csv not found at ' + csvPath });
  }
  if (!JAKE_FROM) {
    return res.status(500).json({ error: 'JAKE_PHONE_NUMBER not configured' });
  }

  const raw = fs.readFileSync(csvPath, 'utf-8');
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const contacts = lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
    return obj;
  });

  const dryRun = req.body.dryRun === true || req.query.dryRun === 'true';
  const RATE_LIMIT_MS = 2000;
  let sent = 0, skipped = 0, failed = 0;

  res.json({ status: 'started', total: contacts.length, dryRun, csv: csvPath });

  for (const contact of contacts) {
    const phone = (contact.phone || contact.mobile || contact.number || '').trim();
    if (!phone) { skipped++; continue; }
    if (getConversation(phone).length > 0) {
      console.log(`[Jake] Skipping ${phone} — already in conversation`);
      skipped++;
      continue;
    }
    const opener = OPENERS[Math.floor(Math.random() * OPENERS.length)];
    upsertProspect(phone, contact.name || '', contact.business || '');
    if (dryRun) {
      sent++;
      console.log(`[Jake] DRY RUN — would send to ${phone}: ${opener}`);
      continue;
    }
    try {
      await twilioClient.messages.create({ body: opener, from: JAKE_FROM, to: phone });
      addMessage(phone, 'assistant', opener);
      markSent(phone);
      sent++;
      console.log(`[Jake] Campaign sent to ${phone}`);
    } catch (err) {
      failed++;
      console.error(`[Jake] Campaign failed for ${phone}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
  }
  console.log(`[Jake] trigger-campaign done. Sent: ${sent} Skipped: ${skipped} Failed: ${failed}`);
});

// ── Hourly follow-up job ─────────────────────────────────────────────────────
const FOLLOW_UP_MSG = "Hey, just checking back in — still happy to jump on a quick call and show you how it works if you're interested. No pressure either way 👍";

setInterval(async () => {
  try {
    const prospects = getProspectsNeedingFollowUp();
    console.log(`🔔 [Jake] Follow-up check: ${prospects.length} prospect(s) eligible`);
    for (const p of prospects) {
      try {
        await twilioClient.messages.create({
          body: FOLLOW_UP_MSG,
          from: process.env.JAKE_PHONE_NUMBER,
          to: p.phone,
        });
        addMessage(p.phone, 'assistant', FOLLOW_UP_MSG);
        markFollowUpSent(p.phone);
        console.log(`✅ [Jake] Follow-up sent to ${p.phone} (${p.name || 'unknown'})`);
      } catch (err) {
        console.error(`❌ [Jake] Follow-up failed for ${p.phone}:`, err.message);
      }
    }
  } catch (err) {
    console.error('❌ [Jake] Follow-up job error:', err.message);
  }
}, 60 * 60 * 1000); // every hour


// ── Google re-auth ───────────────────────────────────────────────────────────

app.get('/reauth-google', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar']
  });
  res.redirect(authUrl);
});

app.get('/save-token', async (req, res) => {
  const { code } = req.query;
  const { tokens } = await oauth2Client.getToken(code);
  res.send(`Your new refresh token is: <b>${tokens.refresh_token}</b> — copy this into your JAKE_GOOGLE_REFRESH_TOKEN env var on Railway`);
});

    // — Test calendar connection
app.get('/test-calendar', async (req, res) => {
    try {
          oauth2Client.setCredentials({ refresh_token: process.env.JAKE_GOOGLE_REFRESH_TOKEN });
          const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
          const now = new Date();
          const end = new Date(now.getTime() + 30 * 60 * 1000);
          await calendar.events.insert({
                  calendarId: process.env.JAKE_GOOGLE_CALENDAR_ID,
                  requestBody: {
                            summary: 'Test Event - Calendar Connection Check',
                            start: { dateTime: now.toISOString() },
                            end: { dateTime: end.toISOString() },
                  },
          });
          res.json({ status: 'SUCCESS', event: 'created' });
    } catch (err) {
          res.json({ status: 'FAILED', error: err.message });
    }
});
module.exports = app;
