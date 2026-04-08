require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express  = require('express');
const twilio   = require('twilio');
const { google } = require('googleapis');
const { getJakeReply, parseJakeBooking, cleanJakeReply } = require('./jake-ai');
const {h
  addMessage,
  getConversation,
  getRecentConversations,
  getProspects,
  markBooked,
} = require('./jake-db');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const twilioClient = twilio(
  process.env.JAKE_TWILIO_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID,
  process.env.JAKE_TWILIO_AUTH_TOKEN  || process.env.TWILIO_AUTH_TOKEN
);

const JAKE_FROM = process.env.JAKE_PHONE_NUMBER;

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
app.post('/incoming', async (req, res) => {
  const from     = req.body.From;
  const body     = req.body.Body?.trim() || '';
  const twiml    = new twilio.twiml.MessagingResponse();

  console.log(`📨 [Jake] Reply from ${from}: ${body}`);

  // Opt-out handling
  if (['stop', 'unsubscribe', 'quit', 'cancel'].includes(body.toLowerCase())) {
    console.log(`🚫 [Jake] Opt-out from ${from}`);
    res.type('text/xml');
    return res.send(twiml.toString()); // Twilio auto-handles STOP compliance
  }

  addMessage(from, 'user', body);

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

  res.type('text/xml');
  res.send(twiml.toString());
});

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
app.get('/health', (req, res) => res.json({ ok: true, service: 'jake-outbound' }));

module.exports = app;
