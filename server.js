require('dotenv').config();

const express = require('express');
const twilio = require('twilio');
const path = require('path');
const cookieSession = require('cookie-session');

const { getConversation, addMessage, clearConversation, getSetting } = require('./db');
const { getAIReply, parseBooking, cleanReply, assessImage } = require('./ai');
const { bookEvent } = require('./calendar');
const { calculateCalloutFee, extractPostcode } = require('./postcode');

const app = express();
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

app.use(cookieSession({
  name: 'grafted_session',
  secret: process.env.SESSION_SECRET || 'change-me-in-production',
  maxAge: 7 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
}));

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// 1. MISSED CALL WEBHOOK
// Twilio calls this when a call goes unanswered.
// ─────────────────────────────────────────────
app.post('/call-missed', async (req, res) => {
  const callerNumber = req.body.From;
  const twiml = new twilio.twiml.VoiceResponse();

  console.log(`📞 Missed call from ${callerNumber}`);

  const openingText = `Hi, it's ${process.env.BUSINESS_NAME} here. Sorry I missed your call, I'm out on a job right now. What was it you were after? I'll get back to you as soon as I can.`;

  try {
    await twilioClient.messages.create({
      body: openingText,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: callerNumber,
    });
    addMessage(callerNumber, 'assistant', openingText);
    console.log(`✅ Sent opening SMS to ${callerNumber}`);
  } catch (err) {
    console.error(`❌ Failed to send SMS to ${callerNumber}:`, err.message);
  }

  twiml.say({ voice: 'alice', language: 'en-GB' },
    `Thanks for calling ${process.env.BUSINESS_NAME}. We're out on a job right now but we've just sent you a text. We'll be in touch very soon.`
  );
  twiml.hangup();
  res.type('text/xml');
  res.send(twiml.toString());
});

// ─────────────────────────────────────────────
// 2. INCOMING SMS WEBHOOK
// ─────────────────────────────────────────────
app.post('/sms-incoming', async (req, res) => {
  const callerNumber = req.body.From;
  const incomingMessage = req.body.Body?.trim() || '';
  const numMedia = parseInt(req.body.NumMedia || '0', 10);
  const mediaUrl = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0 || 'image/jpeg';

  const twiml = new twilio.twiml.MessagingResponse();

  console.log(`💬 SMS from ${callerNumber}: ${incomingMessage || '(media only)'}`);

  // Bot enabled check
  if (getSetting('bot_enabled') === 'false') {
    addMessage(callerNumber, 'user', incomingMessage, mediaUrl);
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // Opt-out
  if (['stop', 'unsubscribe', 'quit', 'cancel'].includes(incomingMessage.toLowerCase())) {
    clearConversation(callerNumber);
    twiml.message("No problem, you won't hear from us again. Take care!");
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  addMessage(callerNumber, 'user', incomingMessage, mediaUrl);

  try {
    let reply;

    // ── MMS photo handling ───────────────────────────────────────────────────
    if (numMedia > 0 && mediaUrl) {
      console.log(`🖼️  MMS received: ${mediaUrl}`);
      try {
        reply = await assessImage(mediaUrl, mediaType, incomingMessage);
      } catch (imgErr) {
        console.error('Image assessment failed:', imgErr.message);
        reply = "Thanks for the photo! I've passed it to the team who'll be in touch with a quote shortly.";
      }

    } else {
      // ── Postcode detection ─────────────────────────────────────────────────
      const postcode = extractPostcode(incomingMessage);
      let postcodeNote = '';

      if (postcode) {
        try {
          const callout = await calculateCalloutFee(postcode);
          if (!callout.withinRange) {
            // Outside range — decline politely
            addMessage(callerNumber, 'assistant', callout.message);
            twiml.message(callout.message);
            res.type('text/xml');
            return res.send(twiml.toString());
          }
          postcodeNote = callout.fee > 0
            ? `\n\n[Note: ${postcode} is ${callout.distanceMiles} miles away, callout fee £${callout.fee.toFixed(2)}]`
            : `\n\n[Note: ${postcode} is ${callout.distanceMiles} miles away, within free zone]`;
        } catch (pcErr) {
          console.warn('Postcode lookup failed:', pcErr.message);
        }
      }

      // ── Get AI reply ───────────────────────────────────────────────────────
      const history = getConversation(callerNumber);
      const messageForAI = postcodeNote
        ? `${incomingMessage}${postcodeNote}`
        : incomingMessage;

      // Append postcode context to last user message if needed
      if (postcodeNote) {
        history[history.length - 1].content = messageForAI;
      }

      const rawReply = await getAIReply(callerNumber, history);
      const bookingData = parseBooking(rawReply);
      reply = cleanReply(rawReply);

      // ── Calendar booking ───────────────────────────────────────────────────
      if (bookingData) {
        try {
          const event = await bookEvent({ ...bookingData, callerNumber });
          console.log(`📅 Booking created for ${callerNumber}: ${bookingData.job} on ${bookingData.date}`);
          // Optionally save appointment record
          const { saveAppointment } = require('./db');
          saveAppointment({
            phone: callerNumber,
            summary: `${bookingData.job} - ${bookingData.postcode}`,
            startTime: `${bookingData.date} ${bookingData.time}`,
            googleEventId: event?.id,
          });
        } catch (calErr) {
          console.error('❌ Calendar booking failed:', calErr.message);
        }
      }
    }

    addMessage(callerNumber, 'assistant', reply);
    twiml.message(reply);
    console.log(`✅ Replied to ${callerNumber}: ${reply}`);

  } catch (err) {
    console.error('❌ SMS handler error:', err.message);
    twiml.message(`Sorry, just give ${process.env.BUSINESS_OWNER_NAME} a ring back when you get a chance!`);
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// ─────────────────────────────────────────────
// 3. GOOGLE CALENDAR AUTH (one-time setup)
// ─────────────────────────────────────────────
const { google } = require('googleapis');

app.get('/auth/google', (req, res) => {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  const url = auth.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
    prompt: 'consent',
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  const { tokens } = await auth.getToken(req.query.code);
  const { setSetting } = require('./db');
  setSetting('google_tokens', JSON.stringify(tokens));
  console.log('✅ Google Calendar connected');
  res.redirect('/dashboard?success=calendar_connected');
});

// ─────────────────────────────────────────────
// 4. POSTCODE API
// ─────────────────────────────────────────────
app.get('/api/postcode/:postcode', async (req, res) => {
  try {
    const result = await calculateCalloutFee(req.params.postcode);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// 5. DASHBOARD
// ─────────────────────────────────────────────
const dashboardRoutes = require('./dashboard');
app.use('/dashboard', dashboardRoutes);

// ─────────────────────────────────────────────
// 6. HEALTH CHECK
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    business: process.env.BUSINESS_NAME,
    endpoints: {
      missed_call: 'POST /call-missed',
      incoming_sms: 'POST /sms-incoming',
      dashboard: 'GET /dashboard',
      postcode_check: 'GET /api/postcode/:postcode',
    },
  });
});

app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

module.exports = app;
