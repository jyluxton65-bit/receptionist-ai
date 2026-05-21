/**
 * demo-server.js
 *
 * Demo receptionist pre-configured for Joe's Tree Services, Didsbury.
 * Used during sales demos â prospects can text this number live during a call.
 *
 * Twilio webhook URLs to set on your demo number:
 *   Missed call (Voice):  POST https://YOUR-URL/demo/call-missed
 *   Inbound SMS:          POST https://YOUR-URL/demo/sms-incoming
 *
 * Dashboard (PWA):        GET  https://YOUR-URL/demo/dashboard
 *
 * PAUSE BEHAVIOUR:
 *   When paused via the dashboard, incoming SMS messages are stored in history
 *   but the bot returns empty TwiML (no auto-reply). If you configure Twilio
 *   SMS forwarding on the demo number to the arborist's personal phone, they
 *   receive messages as normal texts and can reply from their SMS app.
 *   On RESUME the bot picks up the full conversation history seamlessly.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express    = require('express');
const path       = require('path');
const twilio     = require('twilio');
const { google } = require('googleapis');
const multer     = require('multer');

const { addDays, startOfToday, nextDay, setDay } = require('date-fns');

const demoOauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'https://receptionist-ai-production-1c42.up.railway.app/demo/save-token'
);

const {
  addMessage,
  getConversation,
  getRecentConversations,
  clearConversation,
  isPaused,
  setPaused,
} = require('./demo-db');
const { getDemoReply, parseBooking, cleanReply } = require('./demo-ai');
const { assessImageData } = require('../ai');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve PWA static assets
app.use('/demo/public', express.static(path.join(__dirname, 'public')));

const twilioClient = twilio(
  process.env.DEMO_TWILIO_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID,
  process.env.DEMO_TWILIO_AUTH_TOKEN  || process.env.TWILIO_AUTH_TOKEN
);

const DEMO_FROM = process.env.DEMO_PHONE_NUMBER;

// Per-phone queue — ensures sequential processing and prevents duplicate replies
const phoneQueues = new Map();


// ââ Missed call â instant text back ââââââââââââââââââââââââââââââââââââââââââ
// ── Booking date/time parsers ───────────────────────────────────────────
function parseDateString(dateStr) {
  const lower = (dateStr || '').toLowerCase().trim();
  const today = startOfToday(); // midnight today, local time

  if (lower === 'today' || lower === 'tonight')   return today;
  if (lower === 'tomorrow')                        return addDays(today, 1);
  if (lower.includes('day after tomorrow'))        return addDays(today, 2);
  if (lower.includes('next week'))                 return addDays(today, 7);

  // "in X days"
  const inDays = lower.match(/in\s+(\d+)\s+days?/);
  if (inDays) return addDays(today, parseInt(inDays[1]));

  // Day names — resolve to NEXT occurrence (never today if it's already past)
  const dayNames = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };
  const isNext = lower.includes('next');
  for (const [name, num] of Object.entries(dayNames)) {
    if (lower.includes(name)) {
      const current = today.getDay();
      let diff = num - current;
      if (diff <= 0 || isNext) diff += 7;
      return addDays(today, diff);
    }
  }

  // Fallback: try native Date parse
  const direct = new Date(dateStr);
  if (!isNaN(direct)) return direct;

  return null;
}
function parseTimeString(timeStr) {
  const lower = (timeStr || '').toLowerCase().trim();
  if (lower === 'morning')   return { hour: 9,  minute: 0 };
  if (lower === 'afternoon') return { hour: 14, minute: 0 };
  if (lower === 'evening')   return { hour: 17, minute: 0 };
  const m = lower.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (m) {
    let hour = parseInt(m[1]);
    const minute = m[2] ? parseInt(m[2]) : 0;
    if (m[3] === 'pm' && hour < 12) hour += 12;
    if (m[3] === 'am' && hour === 12) hour = 0;
    return { hour, minute };
  }
  return { hour: 9, minute: 0 };
}
app.post('/demo/call-missed', (req, res) => {
  const callerNumber = req.body.From;

  // â¡ Send TwiML IMMEDIATELY â Twilio times out after ~5s if we await first
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.pause({ length: 1 });
  twiml.say({ voice: 'alice', language: 'en-GB' },
    `Thanks for calling Joe's Tree Services. We're out on a job right now but we've just sent you a text. We'll be in touch very soon.`
  );
  twiml.hangup();
  res.type('text/xml');
  res.send(twiml.toString());

  // ð± Send SMS async AFTER TwiML is already on the wire
  const opener = `Hi, it's Joe from Joe's Tree Services. Sorry I missed your call, I'm on a job right now. What was it you were after? I'll get back to you as soon as I can.`;
    // Initialise session sync so reply texts always find a valid session
  addMessage(callerNumber, 'assistant', opener);

  twilioClient.messages.create({ body: opener, from: DEMO_FROM, to: callerNumber })
    .then(() => console.log(`â [Demo] Sent opener to ${callerNumber}`))
    .catch(err => console.error('â [Demo] SMS failed:', err.message));
});

// ââ Inbound SMS âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.post('/demo/sms-incoming', (req, res) => {
  if (req.body.CallSid) {
    res.type('text/xml');
    return res.send('<Response></Response>');
  }
  const from    = req.body.From;
  const body    = req.body.Body?.trim() || '';
  const reqBody = req.body;
  console.log(`📨 [Demo] SMS from ${from}: ${body}`);
  // Respond to Twilio immediately — prevents duplicate retries from slow processing
  res.type('text/xml');
  res.send('<Response></Response>');
  // Queue per phone — second message waits for first to finish
  const prev = phoneQueues.get(from) || Promise.resolve();
  const next = prev.then(() => handleSMS(from, body, reqBody)).catch(err =>
    console.error(`❌ [Demo] Queue error for ${from}:`, err.message)
  );
  phoneQueues.set(from, next);
  next.finally(() => { if (phoneQueues.get(from) === next) phoneQueues.delete(from); });
});

async function handleSMS(from, body, reqBody) {
  if (body.toLowerCase() === 'reset demo') {
    clearConversation(from);
    await twilioClient.messages.create({ body: 'Demo reset. Text anything to start a fresh conversation.', from: DEMO_FROM, to: from });
    return;
  }
  addMessage(from, 'user', body);
  if (isPaused()) {
    console.log(`⏸️ [Demo] PAUSED — storing message from ${from} but not replying`);
    return;
  }
  try {
    const numMedia = parseInt(reqBody.NumMedia || '0', 10);
    const history  = getConversation(from);
    const rawReply = await getDemoReply(from, history);
    const booking  = parseBooking(rawReply);
    let reply      = cleanReply(rawReply);
    const mentionedPhoto = /\b(photo|pic|picture|image|snap)\b/i.test(body);
    const botCantSee     = /can.t see|not (?:coming|getting) through|didn.t (?:come|get) through|no photo|no image/i.test(reply);
    if ((mentionedPhoto && numMedia === 0) || botCantSee) {
      const baseUrl    = process.env.BASE_URL || 'https://receptionist-ai-production-1c42.up.railway.app';
      const uploadLink = baseUrl + '/quote-upload.html?phone=' + encodeURIComponent(from);
      reply = 'Still not getting the photo through — happens sometimes with texts. Here\'s a quick link to send it instead, takes 30 seconds: ' + uploadLink + '\n\nAnd can you let me know your postcode so I can check if we cover your area?';
    }
    addMessage(from, 'assistant', reply);
    await twilioClient.messages.create({ body: reply, from: DEMO_FROM, to: from });
    console.log(`✅ [Demo] Replied to ${from}: ${reply.slice(0, 80)}`);
    if (booking) {
      console.log(`📅 [Demo] Booking detected: ${JSON.stringify(booking)}`);
      try {
        const bookingDate = parseDateString(booking.date);
        const bookingTime = parseTimeString(booking.time);
        console.log(`📅 [Demo] Parsed: ${bookingDate} ${JSON.stringify(bookingTime)}`);
        if (!bookingDate) {
          console.error(`📅 [Demo] Could not parse date: "${booking.date}"`);
        } else {
          const startDT = new Date(bookingDate);
          startDT.setHours(bookingTime.hour, bookingTime.minute, 0, 0);
          const endDT   = new Date(startDT.getTime() + 60 * 60 * 1000);
          if (!process.env.DEMO_GOOGLE_REFRESH_TOKEN) {
            console.error('❌ [Demo] DEMO_GOOGLE_REFRESH_TOKEN not set — skipping calendar');
          } else {
            const calAuth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
            calAuth.setCredentials({ refresh_token: process.env.DEMO_GOOGLE_REFRESH_TOKEN });
            const calendar   = google.calendar({ version: 'v3', auth: calAuth });
            const calendarId = process.env.DEMO_GOOGLE_CALENDAR_ID || 'primary';
            const event = {
              summary:     `Joe's Tree Services — ${booking.job}`,
              description: `Phone: ${from}\nJob: ${booking.job}\nPostcode: ${booking.postcode}`,
              start: { dateTime: startDT.toISOString(), timeZone: 'Europe/London' },
              end:   { dateTime: endDT.toISOString(),   timeZone: 'Europe/London' },
            };
            console.log(`📅 [Demo] Inserting into "${calendarId}": ${JSON.stringify(event)}`);
            const calResp = await calendar.events.insert({ calendarId, resource: event });
            console.log(`✅ [Demo] Calendar event created: ${calResp.data.htmlLink}`);
          }
        }
      } catch (calErr) {
        console.error(`❌ [Demo] Calendar failed: ${calErr.message}`, calErr.stack);
      }
    }
  } catch (err) {
    console.error('❌ [Demo] handleSMS error:', err.message, err.stack);
    await twilioClient.messages.create({ body: `Sorry, just give Joe a ring back when you get a chance.`, from: DEMO_FROM, to: from }).catch(() => {});
  }
}

app.get('/demo/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/demo/status', (req, res) => {
  res.json({ paused: isPaused(), business: "Joe's Tree Services", owner: 'Joe' });
});

app.post('/demo/pause', (req, res) => {
  setPaused(true);
  console.log('â¸ï¸  [Demo] Bot PAUSED via dashboard');
  res.json({ ok: true, paused: true });
});

app.post('/demo/resume', (req, res) => {
  setPaused(false);
  console.log('â¶ï¸  [Demo] Bot RESUMED via dashboard');
  res.json({ ok: true, paused: false });
});

app.get('/demo/conversations', (req, res) => {
  res.json(getRecentConversations(20));
});

app.get('/demo/conversations/:phone', (req, res) => {
  res.json(getConversation(decodeURIComponent(req.params.phone)));
});

// Manual send â arborist replies from the dashboard
app.post('/demo/send', async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'to and message required' });

  try {
    await twilioClient.messages.create({ body: message, from: DEMO_FROM, to });
    addMessage(to, 'assistant', message);
    console.log(`â [Demo] Manual send to ${to}: ${message}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('â [Demo] Send failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delay â push today's remaining Google Calendar events back and text customers
app.post('/demo/delay', async (req, res) => {
  const { minutes } = req.body;
  if (!minutes || isNaN(minutes) || parseInt(minutes) < 1) {
    return res.status(400).json({ error: 'minutes must be a positive number' });
  }
  const delayMs = parseInt(minutes) * 60 * 1000;

  try {
    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI,
    );
    auth.setCredentials({ refresh_token: process.env.DEMO_GOOGLE_REFRESH_TOKEN });
    const calendar = google.calendar({ version: 'v3', auth });

    const now      = new Date();
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);

    // List all remaining events today
    const listResp = await calendar.events.list({
      calendarId:  process.env.DEMO_GOOGLE_CALENDAR_ID || 'primary',
      timeMin:     now.toISOString(),
      timeMax:     endOfDay.toISOString(),
      singleEvents: true,
      orderBy:     'startTime',
    });

    const events   = listResp.data.items || [];
    const affected = [];

    for (const event of events) {
      const newStart = new Date(new Date(event.start.dateTime).getTime() + delayMs);
      const newEnd   = new Date(new Date(event.end.dateTime).getTime()   + delayMs);

      await calendar.events.patch({
        calendarId: process.env.DEMO_GOOGLE_CALENDAR_ID || 'primary',
        eventId:    event.id,
        resource: {
          start: { dateTime: newStart.toISOString(), timeZone: 'Europe/London' },
          end:   { dateTime: newEnd.toISOString(),   timeZone: 'Europe/London' },
        },
      });

      // Extract phone number from event description (line: "Phone: +447...")
      const phoneMatch = (event.description || '').match(/Phone:\s*(\+?[\d\s\-()]+)/);
      if (phoneMatch) {
        const phone      = phoneMatch[1].trim().replace(/[\s\-()]/g, '');
        const newTimeStr = newStart.toLocaleTimeString('en-GB', {
          hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London',
        });
        const msg = `Hi, it's Joe. Running about ${minutes} mins behind today â your appointment is now at ${newTimeStr}. Sorry for the inconvenience.`;

        try {
          await twilioClient.messages.create({ body: msg, from: DEMO_FROM, to: phone });
          addMessage(phone, 'assistant', msg);
          affected.push({ phone, newTime: newTimeStr, event: event.summary });
          console.log(`ð [Demo] Pushed "${event.summary}" to ${newTimeStr}, texted ${phone}`);
        } catch (smsErr) {
          console.error(`â [Demo] SMS to ${phone} failed:`, smsErr.message);
          affected.push({ phone, newTime: newTimeStr, event: event.summary, smsError: smsErr.message });
        }
      } else {
        affected.push({ event: event.summary, newTime: newStart.toISOString(), noPhone: true });
      }
    }

    res.json({ ok: true, delayed: events.length, minutes: parseInt(minutes), affected });
  } catch (err) {
    console.error('â [Demo] Delay failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ââ Photo upload submission âââââââââââââââââââââââââââââââââââââââââââââââââ
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// CORS preflight for upload endpoint
app.options('/quote/:phone/submit', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.sendStatus(200);
});

app.post('/quote/:phone/submit', upload.single('photo'), async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');

  const phone = decodeURIComponent(req.query.phone || req.body.phone || req.params.phone || '');
  console.log(`ð¸ [Demo] Upload attempt from ${phone}`);
  console.log(`ð¸ [Demo] Content-Type: ${req.headers['content-type']}`);
  console.log(`ð¸ [Demo] Body keys: ${Object.keys(req.body || {}).join(', ')}`);
  console.log(`ð¸ [Demo] File attached: ${req.file ? `${req.file.originalname} (${req.file.size} bytes)` : 'none'}`);

  let imageData, mimeType, caption;

  if (req.file) {
    // Multipart form upload â convert buffer to base64
    imageData = req.file.buffer.toString('base64');
    mimeType  = req.file.mimetype;
    caption   = req.body.caption || '';
    console.log(`ð¸ [Demo] Multipart: ${req.file.originalname}, ${req.file.size} bytes, type: ${mimeType}`);
  } else {
    // JSON body â imageData already base64
    ({ imageData, mimeType, caption } = req.body);
    console.log(`ð¸ [Demo] JSON body | type: ${mimeType} | size: ${imageData ? imageData.length : 0} chars | caption: "${caption || '(none)'}"`);
  }

  if (!imageData || !mimeType) {
    console.error(`â [Demo] Missing imageData or mimeType for ${phone}`);
    return res.status(400).json({ ok: false, error: 'Missing imageData or mimeType' });
  }

  try {
    console.log(`🔍 [Demo] assessImageData | apiKey:${!!process.env.ANTHROPIC_API_KEY} | mime:${mimeType} | b64len:${imageData.length}`);
    const assessment = await assessImageData(imageData, mimeType, caption || '');
    console.log(`✅ [Demo] Assessment for ${phone}: ${assessment.slice(0,120)}`);
    await twilioClient.messages.create({ body: assessment, from: DEMO_FROM, to: phone });
    addMessage(phone, 'assistant', assessment);
    console.log(`✅ [Demo] Sent photo assessment to ${phone}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`❌ [Demo] Photo failed for ${phone}:`, err.message);
    console.error(`❌ [Demo] type:${err.constructor?.name} status:${err.status||err.statusCode||'?'} code:${err.code||'?'}`);
    console.error(`❌ [Demo] full:`, JSON.stringify(err, Object.getOwnPropertyNames(err)));
    console.error(`❌ [Demo] stack:`, err.stack);
    res.status(500).json({ ok: false, error: err.message || 'Failed to process photo' });
  }
});

// ââ Google re-auth ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

app.get('/demo/reauth-google', (req, res) => {
  const authUrl = demoOauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar'],
  });
  res.redirect(authUrl);
});

app.get('/demo/save-token', async (req, res) => {
  const { code } = req.query;
  const { tokens } = await demoOauth2Client.getToken(code);
  res.send(`Your new refresh token is: <b>${tokens.refresh_token}</b> â copy this into your DEMO_GOOGLE_REFRESH_TOKEN env var on Railway`);
});

// ââ Health ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.get('/health', (req, res) => res.json({ status: 'ok' }));


// ── Startup: log presence of calendar env vars ───────────────────────────────
console.log('[Demo] DEMO_GOOGLE_REFRESH_TOKEN set:', !!process.env.DEMO_GOOGLE_REFRESH_TOKEN);
console.log('[Demo] DEMO_GOOGLE_CALENDAR_ID    set:', !!process.env.DEMO_GOOGLE_CALENDAR_ID, process.env.DEMO_GOOGLE_CALENDAR_ID || '(missing)');
console.log('[Demo] ANTHROPIC_API_KEY          set:', !!process.env.ANTHROPIC_API_KEY);

const PORT = process.env.DEMO_PORT || 3002;
app.listen(PORT, () => {
  console.log(`
ð³ Joe's Tree Services â Demo Receptionist
ð Running on port ${PORT}
ð Missed call webhook â POST /demo/call-missed
ð± SMS webhook        â POST /demo/sms-incoming
ð Dashboard (PWA)    â GET  /demo/dashboard
ð¡ Text "reset demo" to any number to clear its conversation
  `);
});

module.exports = app;
