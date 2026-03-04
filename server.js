require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const { getConversation, addMessage, clearConversation } = require('./conversations');
const { getAIReply, parseBooking, cleanReply } = require('./ai');
const { bookEvent } = require('./calendar');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ─────────────────────────────────────────────
// 1. MISSED CALL WEBHOOK
// Twilio calls this when a call goes unanswered.
// Set this URL in your Twilio number's "Call comes in" webhook
// with the fallback set to fire after your ring timeout.
// ─────────────────────────────────────────────
app.post('/call-missed', async (req, res) => {
  const callerNumber = req.body.From;
  const twiml = new twilio.twiml.VoiceResponse();

  console.log(`📞 Missed call from ${callerNumber}`);

  // Send the instant text back to the missed caller
  const openingText = `Hi, it's ${process.env.BUSINESS_NAME} here. Sorry I missed your call, I'm out on a job right now. What was it you were after? I'll get back to you as soon as I can.`;

  try {
    await twilioClient.messages.create({
      body: openingText,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: callerNumber,
    });

    // Save the opening message to conversation history
    addMessage(callerNumber, 'assistant', openingText);
    console.log(`✅ Sent opening SMS to ${callerNumber}`);
  } catch (err) {
    console.error(`❌ Failed to send SMS to ${callerNumber}:`, err.message);
  }

  // Play a brief message if they're still on the line, then hang up
  twiml.say({ voice: 'alice', language: 'en-GB' },
    `Thanks for calling ${process.env.BUSINESS_NAME}. We're out on a job right now but we've just sent you a text. We'll be in touch very soon.`
  );
  twiml.hangup();

  res.type('text/xml');
  res.send(twiml.toString());
});


// ─────────────────────────────────────────────
// 2. INCOMING SMS WEBHOOK
// Twilio calls this when the customer replies to the text.
// Set this URL in your Twilio number's "A message comes in" webhook.
// ─────────────────────────────────────────────
app.post('/sms-incoming', async (req, res) => {
  const callerNumber = req.body.From;
  const incomingMessage = req.body.Body?.trim();
  const twiml = new twilio.twiml.MessagingResponse();

  console.log(`💬 SMS from ${callerNumber}: ${incomingMessage}`);

  // Handle opt-out
  if (['stop', 'unsubscribe', 'quit', 'cancel'].includes(incomingMessage.toLowerCase())) {
    clearConversation(callerNumber);
    twiml.message('No problem, you won\'t hear from us again. Take care!');
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // Add customer message to history
  addMessage(callerNumber, 'user', incomingMessage);
  const history = getConversation(callerNumber);

  try {
    // Get Claude's reply
    const rawReply = await getAIReply(callerNumber, history);
    const bookingData = parseBooking(rawReply);
    const reply = cleanReply(rawReply);

    // Save AI reply to history
    addMessage(callerNumber, 'assistant', reply);

    // If booking detected, add to Google Calendar
    if (bookingData) {
      try {
        await bookEvent({ ...bookingData, callerNumber });
        console.log(`📅 Booking created for ${callerNumber}: ${bookingData.job} on ${bookingData.date} at ${bookingData.time}`);
      } catch (calErr) {
        console.error('❌ Calendar booking failed:', calErr.message);
        // Don't fail the SMS reply if calendar fails
      }
    }

    twiml.message(reply);
    console.log(`✅ Replied to ${callerNumber}: ${reply}`);
  } catch (err) {
    console.error('❌ AI reply failed:', err.message);
    twiml.message(`Sorry, just give ${process.env.BUSINESS_OWNER_NAME} a ring back when you get a chance!`);
  }

  res.type('text/xml');
  res.send(twiml.toString());
});


// ─────────────────────────────────────────────
// 3. GOOGLE CALENDAR AUTH (run once to get refresh token)
// Visit /auth/google in your browser to start the OAuth flow
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
  console.log('✅ YOUR REFRESH TOKEN (copy this into .env):');
  console.log(tokens.refresh_token);
  res.send(`
    <h2>Authorised!</h2>
    <p>Copy this refresh token into your .env file as GOOGLE_REFRESH_TOKEN:</p>
    <code style="font-size:14px; word-break:break-all">${tokens.refresh_token}</code>
  `);
});


// ─────────────────────────────────────────────
// 4. HEALTH CHECK
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    business: process.env.BUSINESS_NAME,
    endpoints: {
      missed_call: 'POST /call-missed',
      incoming_sms: 'POST /sms-incoming',
      google_auth: 'GET /auth/google',
    }
  });
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
🌿 ${process.env.BUSINESS_NAME} AI Receptionist
🚀 Server running on port ${PORT}
📞 Missed call webhook: POST /call-missed
💬 Incoming SMS webhook: POST /sms-incoming
  `);
});
