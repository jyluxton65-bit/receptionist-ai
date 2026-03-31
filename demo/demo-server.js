/**
 * demo-server.js
 *
 * Demo receptionist pre-configured for Joe's Tree Services, Didsbury.
 * Used during sales demos — prospects can text this number live during a call.
 *
 * Twilio webhook URLs to set on your demo number:
 *   Missed call (Voice):  POST https://YOUR-URL/demo/call-missed
 *   Inbound SMS:          POST https://YOUR-URL/demo/sms-incoming
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express = require('express');
const twilio  = require('twilio');
const { addMessage, getConversation, clearConversation } = require('./demo-db');
const { getDemoReply, parseBooking, cleanReply } = require('./demo-ai');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

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

  addMessage(from, 'user', body);

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

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  ok: true,
  service: 'demo-receptionist',
  business: "Joe's Tree Services",
  location: 'Didsbury, M20',
}));

const PORT = process.env.DEMO_PORT || 3002;
app.listen(PORT, () => {
  console.log(`
🌳 Joe's Tree Services — Demo Receptionist
🚀 Running on port ${PORT}
📞 Missed call webhook → POST /demo/call-missed
📱 SMS webhook         → POST /demo/sms-incoming
💡 Text "reset demo" to any number to clear its conversation
  `);
});
