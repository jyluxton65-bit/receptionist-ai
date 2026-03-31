/**
 * demo-server.js
 *
 * Demo receptionist pre-configured for Joe's Tree Services, Didsbury.
 * Used during sales demos — prospects can text this number live during a call.
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

const {
  addMessage,
  getConversation,
  getRecentConversations,
  clearConversation,
  isPaused,
  setPaused,
} = require('./demo-db');
const { getDemoReply, parseBooking, cleanReply } = require('./demo-ai');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Serve PWA static assets
app.use('/demo/public', express.static(path.join(__dirname, 'public')));

const twilioClient = twilio(
  process.env.DEMO_TWILIO_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID,
  process.env.DEMO_TWILIO_AUTH_TOKEN  || process.env.TWILIO_AUTH_TOKEN
);

const DEMO_FROM = process.env.DEMO_PHONE_NUMBER;

// ── Missed call → instant text back ──────────────────────────────────────────
app.post('/demo/call-missed', async (req, res) => {
  const callerNumber = req.body.From;
  const twiml        = new twilio.twiml.VoiceResponse();

  const opener = `Hi, it's Joe from Joe's Tree Services. Sorry I missed your call, I'm on a job right now. What was it you were after? I'll get back to you as soon as I can.`;

  try {
    await twilioClient.messages.create({
      body: opener,
      from: DEMO_FROM,
      to: callerNumber,
    });
    addMessage(callerNumber, 'assistant', opener);
    console.log(`✅ [Demo] Sent opener to ${callerNumber}`);
  } catch (err) {
    console.error('❌ [Demo] SMS failed:', err.message);
  }

  twiml.say({ voice: 'alice', language: 'en-GB' },
    `Thanks for calling Joe's Tree Services. We're out on a job right now but we've just sent you a text. We'll be in touch very soon.`
  );
  twiml.hangup();

  res.type('text/xml');
  res.send(twiml.toString());
});

// ── Inbound SMS ───────────────────────────────────────────────────────────────
app.post('/demo/sms-incoming', async (req, res) => {
  const from  = req.body.From;
  const body  = req.body.Body?.trim() || '';
  const twiml = new twilio.twiml.MessagingResponse();

  console.log(`📨 [Demo] SMS from ${from}: ${body}`);

  // Allow demo reset via special keyword
  if (body.toLowerCase() === 'reset demo') {
    clearConversation(from);
    twiml.message("Demo reset. Text anything to start a fresh conversation.");
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // Always store the incoming message in history so context is preserved
  addMessage(from, 'user', body);

  // PAUSED: bot stays silent — returns empty TwiML.
  // If Twilio SMS forwarding is configured on this number, the arborist's
  // personal phone receives the message as a normal text and can reply directly.
  // History is maintained so the bot resumes seamlessly on RESUME.
  if (isPaused()) {
    console.log(`⏸️  [Demo] PAUSED — storing message from ${from} but not replying`);
    res.type('text/xml');
    return res.send(twiml.toString()); // empty TwiML = no bot reply
  }

  try {
    const history  = getConversation(from);
    const rawReply = await getDemoReply(from, history);
    const booking  = parseBooking(rawReply);
    const reply    = cleanReply(rawReply);

    addMessage(from, 'assistant', reply);

    if (booking) {
      console.log(`📅 [Demo] Booking detected: ${JSON.stringify(booking)}`);
      // In a real deployment this would call bookEvent() — demo just logs it
    }

    twiml.message(reply);
    console.log(`✅ [Demo] Replied to ${from}: ${reply}`);
  } catch (err) {
    console.error('❌ [Demo] Error:', err.message);
    twiml.message(`Sorry, just give Joe a ring back when you get a chance.`);
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// ── Dashboard (PWA) ───────────────────────────────────────────────────────────

app.get('/demo/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/demo/status', (req, res) => {
  res.json({ paused: isPaused(), business: "Joe's Tree Services", owner: 'Joe' });
});

app.post('/demo/pause', (req, res) => {
  setPaused(true);
  console.log('⏸️  [Demo] Bot PAUSED via dashboard');
  res.json({ ok: true, paused: true });
});

app.post('/demo/resume', (req, res) => {
  setPaused(false);
  console.log('▶️  [Demo] Bot RESUMED via dashboard');
  res.json({ ok: true, paused: false });
});

app.get('/demo/conversations', (req, res) => {
  res.json(getRecentConversations(20));
});

app.get('/demo/conversations/:phone', (req, res) => {
  res.json(getConversation(decodeURIComponent(req.params.phone)));
});

// Manual send — arborist replies from the dashboard
app.post('/demo/send', async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'to and message required' });

  try {
    await twilioClient.messages.create({ body: message, from: DEMO_FROM, to });
    addMessage(to, 'assistant', message);
    console.log(`✅ [Demo] Manual send to ${to}: ${message}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ [Demo] Send failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delay — push today's remaining Google Calendar events back and text customers
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
    auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    const calendar = google.calendar({ version: 'v3', auth });

    const now      = new Date();
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);

    // List all remaining events today
    const listResp = await calendar.events.list({
      calendarId:  process.env.GOOGLE_CALENDAR_ID || 'primary',
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
        calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
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
        const msg = `Hi, it's Joe. Running about ${minutes} mins behind today — your appointment is now at ${newTimeStr}. Sorry for the inconvenience.`;

        try {
          await twilioClient.messages.create({ body: msg, from: DEMO_FROM, to: phone });
          addMessage(phone, 'assistant', msg);
          affected.push({ phone, newTime: newTimeStr, event: event.summary });
          console.log(`📅 [Demo] Pushed "${event.summary}" to ${newTimeStr}, texted ${phone}`);
        } catch (smsErr) {
          console.error(`❌ [Demo] SMS to ${phone} failed:`, smsErr.message);
          affected.push({ phone, newTime: newTimeStr, event: event.summary, smsError: smsErr.message });
        }
      } else {
        affected.push({ event: event.summary, newTime: newStart.toISOString(), noPhone: true });
      }
    }

    res.json({ ok: true, delayed: events.length, minutes: parseInt(minutes), affected });
  } catch (err) {
    console.error('❌ [Demo] Delay failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  ok: true,
  service: 'demo-receptionist',
  business: "Joe's Tree Services",
  location: 'Didsbury, M20',
  paused: isPaused(),
}));

const PORT = process.env.DEMO_PORT || 3002;
app.listen(PORT, () => {
  console.log(`
🌳 Joe's Tree Services — Demo Receptionist
🚀 Running on port ${PORT}
📞 Missed call webhook → POST /demo/call-missed
📱 SMS webhook          → POST /demo/sms-incoming
📊 Dashboard (PWA)      → GET  /demo/dashboard
💡 Text "reset demo" to any number to clear its conversation
  `);
});
