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

const {
  addMessage,
  getConversation,
  getRecentConversations,
  clearConversation,
  isPaused,
  setPaused,
} = require('./demo-db');
const { getDemoReply, parseBooking, cleanReply, cleanResponse, checkShouldBook, buildDemoSystemPrompt } = require('./demo-ai');
const { bookEvent, getAvailableSlots } = require('../calendar');

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
// Tracks phones that have already received a photo upload link this session
const photoLinkSent = new Set();

// ââ Missed call â instant text back ââââââââââââââââââââââââââââââââââââââââââ
app.post('/demo/call-missed', async (req, res) => {
  const callerNumber = req.body.From;
  const twiml        = new twilio.twiml.VoiceResponse();

  const opener = `Hi, this is Sarah from Joe's Tree Services. Sorry Joe missed your call, he's out on a job. What was it you were after? I'll get him to sort it for you.`;

  try {
    await twilioClient.messages.create({
      body: opener,
      from: DEMO_FROM,
      to: callerNumber,
    });
    addMessage(callerNumber, 'assistant', opener);
    console.log(`â [Demo] Sent opener to ${callerNumber}`);
  } catch (err) {
    console.error('â [Demo] SMS failed:', err.message);
  }

  twiml.say({ voice: 'alice', language: 'en-GB' },
    `Thanks for calling Joe's Tree Services. We're out on a job right now but we've just sent you a text. We'll be in touch very soon.`
  );
  twiml.hangup();

  res.type('text/xml');
  res.send(twiml.toString());
});

// ââ Inbound SMS âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.post('/demo/sms-incoming', async (req, res) => {
  const from  = req.body.From;
  const body  = req.body.Body?.trim() || '';
  const twiml = new twilio.twiml.MessagingResponse();
  const numMedia = parseInt(req.body.NumMedia || '0');
  console.log(`ð¨ [Demo] SMS from ${from}: ${body}`);

  // Allow demo reset via special keyword
  if (body.toLowerCase() === 'reset demo') {
    clearConversation(from);
    photoLinkSent.delete(from);
    twiml.message("Demo reset. Text anything to start a fresh conversation.");
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // Always store the incoming message in history so context is preserved

  // If customer tried to send photo via MMS (UK numbers do not support MMS)
  if (numMedia > 0) {
    console.log(` [Demo] NumMedia=${numMedia} from ${from} — UK MMS not supported, sending upload link`);
    if (!photoLinkSent.has(from)) {
      const { createQuoteRequest } = require('../db');
      const crypto = require('crypto');
      const quoteId = crypto.randomBytes(8).toString('hex');
      createQuoteRequest(quoteId, from);
      const baseUrl = process.env.BASE_URL || 'https://receptionist-ai-production-1c42.up.railway.app';
      const photoLink = `${baseUrl}/quote/${quoteId}`;
      const linkMsg = `To get you an accurate quote, upload your photo here — takes 30 seconds: ${photoLink}`;
      try {
        await twilioClient.messages.create({ body: linkMsg, from: DEMO_FROM, to: from });
        photoLinkSent.add(from);
        addMessage(from, 'assistant', linkMsg);
        console.log(` [Demo] Photo upload link sent to ${from}`);
      } catch (smsErr) {
        console.error(`❌ [Demo] Photo link SMS failed: ${smsErr.message}`);
      }
    } else {
      console.log(` [Demo] NumMedia>0 but link already sent to ${from} — skipping`);
    }
    res.type('text/xml');
    return res.send(twiml.toString());
  }
  addMessage(from, 'user', body);

  // PAUSED: bot stays silent â returns empty TwiML.
  // If Twilio SMS forwarding is configured on this number, the arborist's
  // personal phone receives the message as a normal text and can reply directly.
  // History is maintained so the bot resumes seamlessly on RESUME.
  if (isPaused()) {
    console.log(`â¸ï¸  [Demo] PAUSED â storing message from ${from} but not replying`);
    res.type('text/xml');
    return res.send(twiml.toString()); // empty TwiML = no bot reply
  }

  try {
    // Build dynamic system prompt with current UK time and real calendar slots
    const ukDateTime = new Date().toLocaleString('en-GB', {
      timeZone: 'Europe/London',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    let availableSlots = [];
    try {
      availableSlots = await getAvailableSlots();
      console.log(`ð [Demo] Loaded ${availableSlots.length} available slot(s)`);
    } catch (slotErr) {
      console.warn(`â ï¸ [Demo] Could not load calendar slots: ${slotErr.message}`);
    }
    const systemPrompt = buildDemoSystemPrompt(ukDateTime, availableSlots);

        const history = getConversation(from);
    const rawReply = await getDemoReply(from, history, systemPrompt);
    const reply = cleanResponse(cleanReply(rawReply));

    // If AI requested a photo, send upload link as a separate outbound SMS
    if (rawReply.includes('##PHOTO_REQUEST##')) {
      if (!photoLinkSent.has(from)) {
        const { createQuoteRequest } = require('../db');
        const crypto = require('crypto');
        const quoteId = crypto.randomBytes(8).toString('hex');
        createQuoteRequest(quoteId, from);
        const baseUrl = process.env.BASE_URL || 'https://receptionist-ai-production-1c42.up.railway.app';
        const photoLink = `${baseUrl}/quote/${quoteId}`;
        console.log(` [Demo] Sending photo upload link to ${from}: ${photoLink}`);
        try {
          await twilioClient.messages.create({
            body: `Here's a quick link to upload a photo — takes 30 seconds: ${photoLink}`,
            from: DEMO_FROM,
            to: from,
          });
          photoLinkSent.add(from);
        } catch (photoErr) {
          console.error(`❌ [Demo] Photo link SMS failed: ${photoErr.message}`);
        }
      } else {
        console.log(` [Demo] Photo link already sent to ${from} — skipping duplicate`);
      }
    }

    addMessage(from, 'assistant', reply);
    // Primary: detect booking from ##BOOK:...## tag (most reliable)
    const bookingData = parseBooking(rawReply);
    if (bookingData) {
      console.log(`ðï¸ [Demo] ##BOOK## tag: ${JSON.stringify(bookingData)}`);
      console.log(`ð [Demo] Booking to calendarId: ${process.env.GOOGLE_CALENDAR_ID || '(GOOGLE_CALENDAR_ID not set!)'}`);
      bookEvent({ ...bookingData, callerNumber: from })
        .then((evt) => console.log(`â [Demo] Event booked for ${from}: ${evt?.htmlLink || evt?.id || 'no id'}`))
        .catch((calErr) => console.error(`â [Demo] bookEvent failed: ${calErr.message}\n${calErr.stack}`));
    }

    // Backup: semantic check for confirmed bookings without tag
    checkShouldBook(getConversation(from)).then(result => {
      if (result.shouldBook && !bookingData) {
        console.log(`ðï¸ [Demo] checkShouldBook result: ${JSON.stringify(result)}`);
        console.log(`ð [Demo] Booking to calendarId: ${process.env.GOOGLE_CALENDAR_ID || '(GOOGLE_CALENDAR_ID not set!)'}`);
        bookEvent({ date: result.date, time: result.time, job: result.jobType, postcode: result.postcode, callerNumber: from })
          .then((evt) => console.log(`â [Demo] Event booked (via check) for ${from}: ${evt?.htmlLink || evt?.id || 'no id'}`))
          .catch((calErr) => console.error(`â [Demo] bookEvent failed: ${calErr.message}\n${calErr.stack}`));
      }
    }).catch((err) => console.error(`â [Demo] Booking check error: ${err.message}`));
    twiml.message(reply);
    console.log('â [Demo] Replied to ' + from + ': ' + reply);
  } catch (err) {
    console.error('â [Demo] Error:', err.message);
    twiml.message("Sorry something went wrong, try sending that again!");
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// ââ Dashboard (PWA) âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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

// ââ Health ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.get('/health', (req, res) => res.json({
  ok: true,
  service: 'demo-receptionist',
  business: "Joe's Tree Services",
  location: 'Didsbury, M20',
  paused: isPaused(),
}));


// ââ Photo Quotes API ââââââââââââââââââââââââââââ
app.get('/demo/api/photo-quotes', (req, res) => {
  const { getRecentPhotoQuotes } = require('../db');
  res.json(getRecentPhotoQuotes(50));
});

app.get('/demo/api/photo-quotes/:id/image', (req, res) => {
  const { getQuoteRequest } = require('../db');
  const row = getQuoteRequest(req.params.id);
  if (!row || !row.image_data) return res.status(404).send('Not found');
  const mime = row.image_mime || 'image/jpeg';
  const buf = Buffer.from(row.image_data, 'base64');
  res.setHeader('Content-Type', mime);
  res.send(buf);
});

module.exports = app;
