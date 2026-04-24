require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const path = require('path');
const crypto = require('crypto');
const cookieSession = require('cookie-session');
const {
  getConversation, addMessage, clearConversation, getSetting,
  createQuoteRequest, getQuoteRequest, fulfillQuoteRequest,
} = require('./db');
const { getAIReply, parseBooking, cleanReply, cleanResponse, assessImage, assessImageData } = require('./ai');
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
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// âââââââââââââââââââââââââââââââââââââââââââââ
// 1. MISSED CALL WEBHOOK
// âââââââââââââââââââââââââââââââââââââââââââââ
app.post('/call-missed', async (req, res) => {
  const callerNumber = req.body.From;
  const twiml = new twilio.twiml.VoiceResponse();
  console.log(`ð Missed call from ${callerNumber}`);
  const openingText = `Hi, it's ${process.env.BUSINESS_NAME} here. Sorry I missed your call, I'm out on a job right now. What was it you were after? I'll get back to you as soon as I can.`;
  try {
    await twilioClient.messages.create({ body: openingText, from: process.env.TWILIO_PHONE_NUMBER, to: callerNumber });
    addMessage(callerNumber, 'assistant', openingText);
    console.log(`â Sent opening SMS to ${callerNumber}`);
  } catch (err) {
    console.error(`â Failed to send SMS to ${callerNumber}:`, err.message);
  }
  twiml.say({ voice: 'alice', language: 'en-GB' }, `Thanks for calling ${process.env.BUSINESS_NAME}. We're out on a job right now but we've just sent you a text. We'll be in touch very soon.`);
  twiml.hangup();
  res.type('text/xml');
  res.send(twiml.toString());
});

// âââââââââââââââââââââââââââââââââââââââââââââ
// 2. INCOMING SMS WEBHOOK
// âââââââââââââââââââââââââââââââââââââââââââââ
app.post('/sms-incoming', async (req, res) => {
  const callerNumber = req.body.From;
  const incomingMessage = req.body.Body?.trim() || '';
  const numMedia = parseInt(req.body.NumMedia || '0', 10);
  const mediaUrl = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0 || 'image/jpeg';
  const twiml = new twilio.twiml.MessagingResponse();
  console.log(`ð¬ SMS from ${callerNumber}: ${incomingMessage || '(media only)'}`);

  if (getSetting('bot_enabled') === 'false') {
    addMessage(callerNumber, 'user', incomingMessage, mediaUrl);
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  if (['stop', 'unsubscribe', 'quit', 'cancel'].includes(incomingMessage.toLowerCase())) {
    clearConversation(callerNumber);
    twiml.message("No problem, you won't hear from us again. Take care!");
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  addMessage(callerNumber, 'user', incomingMessage, mediaUrl);

  try {
    let reply;

    if (numMedia > 0 && mediaUrl) {
      // Customer sent an image directly — generate a photo quote link
      const quoteId = crypto.randomBytes(8).toString('hex');
      createQuoteRequest(quoteId, callerNumber);
      const baseUrl = process.env.BASE_URL || 'https://receptionist-ai-production-1c42.up.railway.app';
      const link = `${baseUrl}/quote/${quoteId}`;
      reply = `To get you an accurate quote I'll need to see the photo properly — could you upload it here: ${link}. Takes 30 seconds!`;
    } else {
      const postcode = extractPostcode(incomingMessage);
      let postcodeNote = '';
      if (postcode) {
        try {
          const callout = await calculateCalloutFee(postcode);
          if (!callout.withinRange) {
            addMessage(callerNumber, 'assistant', callout.message);
            twiml.message(callout.message);
            res.type('text/xml');
            return res.send(twiml.toString());
          }
          postcodeNote = callout.fee > 0
            ? `\n\n[Note: ${postcode} is ${callout.distanceMiles} miles away, callout fee Â£${callout.fee.toFixed(2)}]`
            : `\n\n[Note: ${postcode} is ${callout.distanceMiles} miles away, within free zone]`;
        } catch (pcErr) {
          console.warn('Postcode lookup failed:', pcErr.message);
        }
      }

      const history = getConversation(callerNumber);
      const messageForAI = postcodeNote ? `${incomingMessage}${postcodeNote}` : incomingMessage;
      if (postcodeNote) history[history.length - 1].content = messageForAI;

      const rawReply = await getAIReply(callerNumber, history);
      const bookingData = parseBooking(rawReply);
      const needsPhoto = rawReply.includes('##PHOTO_REQUEST##');
      reply = cleanResponse(cleanReply(rawReply));

      // Auto-generate photo link if bot requested it
      if (needsPhoto) {
        const qid = crypto.randomBytes(4).toString('hex');
        createQuoteRequest(qid, callerNumber);
        const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
        const link = `${appUrl}/quote/${qid}`;
        reply = reply + ' Here is a quick link to upload a photo: ' + link;
        console.log(`ð· Photo link created for ${callerNumber}: ${link}`);
      }

      if (bookingData) {
        try {
          const event = await bookEvent({ ...bookingData, callerNumber });
          console.log(`ð Booking created for ${callerNumber}: ${bookingData.job} on ${bookingData.date}`);
          const { saveAppointment } = require('./db');
          saveAppointment({
            phone: callerNumber,
            summary: `${bookingData.job} - ${bookingData.postcode}`,
            startTime: `${bookingData.date} ${bookingData.time}`,
            googleEventId: event?.id,
          });
        } catch (calErr) {
          console.error('â Calendar booking failed:', calErr.message);
        }
      }
    }

    addMessage(callerNumber, 'assistant', reply);
    twiml.message(reply);
    console.log(`â Replied to ${callerNumber}: ${reply}`);
  } catch (err) {
    console.error('â SMS handler error:', err.message);
    twiml.message("Sorry something went wrong, try sending that again!");
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// âââââââââââââââââââââââââââââââââââââââââââââ
// 3. PHOTO QUOTE UPLOAD â serve page
// âââââââââââââââââââââââââââââââââââââââââââââ
app.get('/quote/:id', (req, res) => {
  const quote = getQuoteRequest(req.params.id);
  if (!quote) return res.status(404).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link not found</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0d1a10;color:#d4edd6;text-align:center;padding:24px}</style></head><body><div><div style="font-size:48px">ð³</div><h2 style="margin:16px 0 8px">Link not found</h2><p style="color:#6b8e6f">This link has expired or doesn't exist.</p></div></body></html>`);
  if (quote.used) return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Already submitted</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0d1a10;color:#d4edd6;text-align:center;padding:24px}</style></head><body><div><div style="font-size:48px">â</div><h2 style="margin:16px 0 8px">Already received</h2><p style="color:#6b8e6f">We already have your photo and will be in touch shortly.</p></div></body></html>`);
  res.sendFile(path.join(__dirname, 'public', 'quote-upload.html'));
});

// âââââââââââââââââââââââââââââââââââââââââââââ
// 4. PHOTO QUOTE UPLOAD â receive submission
// âââââââââââââââââââââââââââââââââââââââââââââ
app.post('/quote/:id/submit', async (req, res) => {
  const { id } = req.params;
  const quote = getQuoteRequest(id);
  if (!quote || quote.used) return res.status(400).json({ error: 'Link expired or not found' });

  const { imageData, mimeType = 'image/jpeg', caption = '' } = req.body;
  if (!imageData) return res.status(400).json({ error: 'No image data' });

  const b64 = imageData.replace(/^data:image\/[a-z+]+;base64,/, '');

  try {
    console.log(`ð· Photo received for ${quote.phone}, processing with Claude...`);
    const assessment = await assessImageData(b64, mimeType, caption);

    await twilioClient.messages.create({
      body: assessment,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: quote.phone,
    });

    fulfillQuoteRequest(id, { imageData: b64, imageMime: mimeType, assessment, quoteSent: assessment });
    addMessage(quote.phone, 'assistant', `[Photo quote] ${assessment}`);

    console.log(`â Photo quote sent to ${quote.phone}`);
    res.json({ ok: true, assessment });
  } catch (err) {
    console.error('â Photo quote error:', err.message);
    res.status(500).json({ error: 'Processing failed. Please try again.' });
  }
});

// âââââââââââââââââââââââââââââââââââââââââââââ
// 5. GOOGLE CALENDAR AUTH
// âââââââââââââââââââââââââââââââââââââââââââââ
const { google } = require('googleapis');
app.get('/auth/google', (req, res) => {
  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
  const url = auth.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/calendar'], prompt: 'consent' });
  res.redirect(url);
});
app.get('/auth/callback', async (req, res) => {
  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
  const { tokens } = await auth.getToken(req.query.code);
  const { setSetting } = require('./db');
  setSetting('google_tokens', JSON.stringify(tokens));
  console.log('â Google Calendar connected');
  res.redirect('/dashboard?success=calendar_connected');
});

// âââââââââââââââââââââââââââââââââââââââââââââ
// 6. POSTCODE API
// âââââââââââââââââââââââââââââââââââââââââââââ
app.get('/api/postcode/:postcode', async (req, res) => {
  try {
    const result = await calculateCalloutFee(req.params.postcode);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// âââââââââââââââââââââââââââââââââââââââââââââ
// 7. CREATE PHOTO QUOTE LINK (from dashboard)
// âââââââââââââââââââââââââââââââââââââââââââââ
app.post('/api/quote/create', async (req, res) => {
  if (!req.session?.authenticated) return res.status(401).json({ error: 'Unauthorised' });
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  const id = crypto.randomBytes(4).toString('hex');
  createQuoteRequest(id, phone);
  const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  const link = `${appUrl}/quote/${id}`;
  try {
    await twilioClient.messages.create({
      body: `To help give you an accurate quote I'd love to see a photo of the tree. Here is a quick upload link: ${link}`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone,
    });
    addMessage(phone, 'assistant', `[Photo link sent] ${link}`);
    console.log(`ð· Photo link sent to ${phone}: ${link}`);
  } catch (smsErr) {
    console.error('SMS failed:', smsErr.message);
  }
  res.json({ ok: true, id, link });
});

// âââââââââââââââââââââââââââââââââââââââââââââ
// 8. DASHBOARD
// âââââââââââââââââââââââââââââââââââââââââââââ
const dashboardRoutes = require('./dashboard');
app.use('/dashboard', dashboardRoutes);

// âââââââââââââââââââââââââââââââââââââââââââââ
// 9. HEALTH
// âââââââââââââââââââââââââââââââââââââââââââââ
app.get('/', (req, res) => res.json({ status: 'running', business: process.env.BUSINESS_NAME }));
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

module.exports = app;
