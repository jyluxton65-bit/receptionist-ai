const { google } = require('googleapis');

const getCalendarClient = () => {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.calendar({ version: 'v3', auth });
};

// Book an event into Google Calendar
const bookEvent = async ({ date, time, job, postcode, callerNumber }) => {
  const calendar = getCalendarClient();

  // Parse date and time into a proper datetime
  // date might be "Thursday 6th March" or "tomorrow" — Claude should give us a real date
  // For robustness we'll create a 1-hour slot
  const startDateTime = parseDateTime(date, time);
  const endDateTime = new Date(startDateTime.getTime() + 60 * 60 * 1000); // +1 hour

  const event = {
    summary: `📞 ${job} - ${postcode}`,
    description: `Job enquiry via AI receptionist.\nCustomer: ${callerNumber}\nJob: ${job}\nLocation: ${postcode}`,
    start: {
      dateTime: startDateTime.toISOString(),
      timeZone: 'Europe/London',
    },
    end: {
      dateTime: endDateTime.toISOString(),
      timeZone: 'Europe/London',
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 30 },
        { method: 'sms', minutes: 60 },
      ],
    },
  };

  const response = await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    resource: event,
  });

  console.log(`✅ Calendar event created: ${response.data.htmlLink}`);
  return response.data;
};

// Get available slots for the next 7 days (for Jake's demo booking)
const getAvailableSlots = async () => {
  const calendar = getCalendarClient();
  const now = new Date();
  const weekLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const response = await calendar.events.list({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    timeMin: now.toISOString(),
    timeMax: weekLater.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });

  return response.data.items || [];
};

// Very simple date parser — handles "tomorrow", day names, and dd/mm/yyyy
const parseDateTime = (dateStr, timeStr) => {
  const now = new Date();
  let date = new Date();

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

  // Parse time like "9am", "2pm", "14:00", "9:30am"
  const timeMatch = timeStr.match(/(\d+)(?::(\d+))?\s*(am|pm)?/i);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1]);
    const mins = parseInt(timeMatch[2] || '0');
    const ampm = (timeMatch[3] || '').toLowerCase();
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
    date.setHours(hours, mins, 0, 0);
  }

  return date;
};

module.exports = { bookEvent, getAvailableSlots };
