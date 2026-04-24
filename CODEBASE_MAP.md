# Receptionist AI â Codebase Map
> Read this file first. It describes every file, its purpose, its dependencies, and the key functions inside it. Use it to identify exactly which files need reading before making any change.

---

## Project Overview

Node.js/Express SMS receptionist bot for Joe's Tree Services (Didsbury, Manchester). Deployed on Railway. Auto-deploys on push to `main`.

**Two bots share the same codebase:**
- **Main bot** â live production bot (server.js + ai.js + src/)
- **Demo bot** â sales demo bot (demo/demo-server.js + demo/demo-ai.js + demo/demo-db.js)

Both share: calendar.js, postcode.js. Main bot only: src/systemPrompt.js.

---

## Architecture

    server.js          â main Express app, mounts all routes
      âââ ai.js        â Anthropic API calls, cleanResponse, cleanReply
      âââ calendar.js  â Google Calendar OAuth2 + bookEvent()
      âââ postcode.js  â distance/fee calculations from Didsbury M20
      âââ db.js        â SQLite (better-sqlite3), all DB helpers
      âââ dashboard.js â /dashboard/* routes (auth, API endpoints)
      âââ src/systemPrompt.js  â builds full system prompt with live time/day

    demo/
      âââ demo-server.js  â demo Express app (/demo/* routes)
      âââ demo-ai.js      â demo AI calls + cleanResponse + checkShouldBook
      âââ demo-db.js      â demo SQLite (data/demo.db)

    public/
      âââ dashboard.html    â main dashboard SPA
      âââ quote-upload.html â customer photo upload page

---

## File Reference

### server.js (root)
**Purpose:** Main Express app. Entry point for Railway.
**Imports:** ai.js, calendar.js, postcode.js, db.js, dashboard.js
**Key routes:**
- POST /call-missed â missed call webhook, fires opening SMS
- POST /sms-incoming â main SMS webhook (bot reply logic)
- GET  /quote/:id â serves photo upload page to customer
- POST /quote/:id/submit â receives photo, runs AI assessment, texts quote
- GET  /auth/google â starts Google OAuth2 flow
- GET  /auth/callback â completes OAuth2, stores refresh token in DB
- GET  /api/postcode/:postcode â callout fee lookup
- POST /api/quote/create â creates photo link from dashboard
- /dashboard/* â mounted from dashboard.js

**SMS handler flow:**
1. extractPostcode() â check coverage, add fee note to message
2. getAIReply() â claude-sonnet-4-20250514
3. parseBooking() â extract ##BOOK:...## tag
4. needsPhoto check â ##PHOTO_REQUEST## tag
5. cleanResponse(cleanReply()) â strip tags, collapse lines, replace dashes
6. if booking: bookEvent() + saveAppointment()
7. if photo: createQuoteRequest() + append link to reply
8. twiml.message(reply)

**Fallback message:** "Sorry something went wrong, try sending that again!"

---

### ai.js (root)
**Purpose:** All Anthropic API calls for the main bot.
**Exports:** getAIReply, parseBooking, cleanReply, cleanResponse, assessImage, assessImageData

**Models:**
- claude-sonnet-4-20250514 â getAIReply (main conversation, max_tokens 1000)
- claude-opus-4-6 â assessImage, assessImageData (photo quotes, max_tokens 400)

**cleanResponse(text):** Replaces ` - `, ` â `, ` â ` with `, `; collapses all newlines into single space; trims.
**cleanReply(text):** Strips ##BOOK:...## and ##PHOTO_REQUEST## tags from text.
**assessImage(url, mimeType, caption):** Fetches MMS via Twilio auth, converts to base64, sends to Claude.
**assessImageData(b64, mimeType, caption):** Direct base64 assessment used by photo upload feature.

---

### calendar.js (root)
**Purpose:** Google Calendar integration.
**Exports:** bookEvent, getAvailableSlots
**bookEvent({ date, time, job, postcode, callerNumber }):** Creates Google Calendar event using stored OAuth2 refresh token.
**Env vars needed:** GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, GOOGLE_REFRESH_TOKEN, GOOGLE_CALENDAR_ID
**parseDateTime(date, time):** Natural language date/time â JS Date object.

---

### postcode.js (root)
**Purpose:** Distance and callout fee calculations from Didsbury M20.
**Exports:** calculateCalloutFee, extractPostcode
**calculateCalloutFee(postcode):** Returns { withinRange, distanceMiles, fee, message }. Free within 10mi, Â£1.50/mi beyond, max 25mi.
**extractPostcode(text):** Regex to extract UK postcode from message body.

---

### db.js (root)
**Purpose:** SQLite helpers for main bot.
**Database file:** data/conversations.db
**Key exports:** getConversation, addMessage, clearConversation, getSetting, setSetting, createQuoteRequest, getQuoteRequest, fulfillQuoteRequest, saveAppointment, getRecentConversations, getConversationHistory, getRecentAppointments, getAllSettings, getRecentPhotoQuotes
**Note:** Railway has ephemeral filesystem â DB resets on container restarts.

---

### dashboard.js (root)
**Purpose:** /dashboard/* Express router â login, session auth, API endpoints.
**Mounted at:** /dashboard in server.js
**Auth:** cookie-session using DASHBOARD_USERNAME / DASHBOARD_PASSWORD env vars
**Key routes:**
- GET  /dashboard/ â serves public/dashboard.html
- GET  /dashboard/api/status â { botEnabled, calendarConnected }
- GET  /dashboard/api/conversations â recent conversations list
- GET  /dashboard/api/conversations/:phone â thread history
- GET  /dashboard/api/appointments â booked appointments
- GET  /dashboard/api/settings â rates config (day_rate, half_day_rate, small_job_rate)
- POST /dashboard/api/settings â save settings (bot_enabled, day_rate, etc.)
- GET  /dashboard/api/photo-quotes â photo quote list
- GET  /dashboard/api/photo-quotes/:id/image â serve photo as binary

---

### src/systemPrompt.js
**Purpose:** Builds the full system prompt for the main bot with live time/date context.
**Exports:** buildSystemPrompt()
**getCurrentContext():** Returns current time/day/date in Europe/London. Sets hoursNote.
**Working hours:** MondayâSaturday 7amâ5pm. Sunday = emergency only.
**Emergency rule:** Fallen tree = urgent but NOT auto-emergency. Emergency callout rate ONLY outside working hours OR if danger/power lines involved. During working hours it's standard urgent rate.
**Coverage:** 25 miles from Didsbury M20. Free within 10mi, Â£1.50/mi beyond.
**Distance reference:** M20(0mi), SK4(4mi), WA14(7mi), OL1(12mi), BL1(14mi), WA1(18mi), WN1(22mi), CW1(24mi). Decline: PR1(30mi), BB1(28mi), LS1(45mi).
**Booking tag:** ##BOOK:[date]|[time]|[job]|[postcode]## â parseBooking() extracts it.
**Photo tag:** ##PHOTO_REQUEST## â system generates upload link and appends to SMS.
**CRITICAL RULES in prompt:** Never introduce as Joe. Single paragraph per reply. No em-dashes, hyphens mid-sentence, markdown, bullet points. Plain sentences only. Never fixed prices â always a range.

---

## Demo Bot Files

### demo/demo-server.js
**Purpose:** Demo bot Express app. Standalone sales demo for prospects.
**Key routes:** POST /demo/call-missed, POST /demo/sms-incoming, GET /demo/dashboard, POST /demo/pause, POST /demo/resume, GET /demo/conversations/:phone, POST /demo/send, POST /demo/delay
**Imports from demo-ai.js:** getDemoReply, parseBooking, cleanReply, cleanResponse, checkShouldBook
**Imports from calendar.js:** bookEvent

**SMS handler flow:**
1. Store message with addMessage()
2. isPaused() check â if true, return empty TwiML (silent)
3. getDemoReply(from, history) â rawReply
4. cleanResponse(cleanReply(rawReply)) â reply (collapses paragraphs, strips dashes)
5. addMessage(from, 'assistant', reply) â save to demo.db
6. Fire-and-forget: checkShouldBook(history).then(result => bookEvent(...) if result.shouldBook)
7. twiml.message(reply)

**Fallback:** "Sorry something went wrong, try sending that again!"
**Special reset:** "reset demo" text clears conversation history for that number.
**Delay endpoint:** POST /demo/delay { minutes } â pushes all today's Calendar events back N minutes and texts customers.

---

### demo/demo-ai.js
**Purpose:** AI logic for the demo bot.
**Exports:** getDemoReply, parseBooking, cleanReply, cleanResponse, checkShouldBook

**DEMO_SYSTEM_PROMPT** (self-contained â does NOT use src/systemPrompt.js):
- Persona: Sarah, Joe's receptionist. NEVER introduce as Joe. Never sign off with a name.
- Coverage: 25mi from Didsbury M20. Explicit postcodes: WN1 Wigan (22mi), BL1 Bolton (14mi), WA1 Warrington (18mi), OL1 Oldham (12mi), CW1 Crewe (24mi)
- Emergency callout: standard job rate + Â£100 callout fee
- CRITICAL RULES: one single paragraph per reply, no line breaks, no Joe sign-off, no em-dashes

**getDemoReply(phone, history):** claude-sonnet-4-20250514, max_tokens 250
**cleanResponse(text):** Strips ` - `, ` â `, ` â ` â `, `; collapses newlines; trims.
**checkShouldBook(recentHistory):** Uses claude-haiku-4-5-20251001. Detects confirmed bookings from last 6 messages. Returns { shouldBook, customerName, postcode, date, time, jobType }. Strips markdown code fences before JSON.parse.
**parseBooking(text):** Extracts ##BOOK:[date]|[time]|[job]|[postcode]## tag.
**cleanReply(text):** Strips ##BOOK:...## tags from reply text.

---

### demo/demo-db.js
**Purpose:** SQLite helpers for demo bot conversations and pause state.
**Database file:** data/demo.db
**Key exports:** addMessage, getConversation, getRecentConversations, clearConversation, isPaused, setPaused
**Tables:** messages (phone, role, content, created_at), state (key, value)

---

## Public Files

### public/dashboard.html
**Purpose:** Single-page dashboard app for Joe.
**Panels:** Overview, Conversations, Appointments, Photos, Settings, Postcode Check
**Mobile:** Hamburger (â°) calls toggleSidebar(). Tap overlay or â button calls closeSidebar(). showPanel() also calls closeSidebar().
**Key JS functions:**
- toggleSidebar() / closeSidebar() â mobile sidebar open/close
- showPanel(id, el) â switches active panel + closes sidebar
- loadStatus() â GET /dashboard/api/status; shows cal connected dot + connect button
- loadOverview() â stats + recent conversations
- openThread(encodedPhone) â thread view with messages
- requestPhoto() â POST /api/quote/create, fires SMS to customer
- loadPhotos() â photo grid with assessments and quote text
- saveSettings() â POST /dashboard/api/settings
- checkPostcode() â GET /api/postcode/:postcode

**IMPORTANT:** Calendar connect button href="/auth/google" (NOT /dashboard/auth/google)
**Bot toggle:** onchange calls toggleBot() â POST /dashboard/api/settings { bot_enabled: 'true'/'false' }

---

### public/quote-upload.html
**Purpose:** Mobile-first photo upload page texted to customers.
**Flow:** Customer opens link â takes/uploads photo â POST /quote/:id/submit â AI assesses â quote texted back automatically.

---

## Environment Variables

| Variable | Used in | Purpose |
|---|---|---|
| ANTHROPIC_API_KEY | ai.js, demo/demo-ai.js | Claude API access |
| TWILIO_ACCOUNT_SID | server.js, demo/demo-server.js | Twilio auth |
| TWILIO_AUTH_TOKEN | server.js, demo/demo-server.js | Twilio auth |
| TWILIO_PHONE_NUMBER | server.js | Main bot outbound number |
| DEMO_TWILIO_ACCOUNT_SID | demo/demo-server.js | Falls back to TWILIO_ACCOUNT_SID |
| DEMO_TWILIO_AUTH_TOKEN | demo/demo-server.js | Falls back to TWILIO_AUTH_TOKEN |
| DEMO_PHONE_NUMBER | demo/demo-server.js | Demo bot outbound number |
| GOOGLE_CLIENT_ID | server.js, calendar.js, demo/demo-server.js | OAuth2 |
| GOOGLE_CLIENT_SECRET | server.js, calendar.js, demo/demo-server.js | OAuth2 |
| GOOGLE_REDIRECT_URI | server.js, calendar.js, demo/demo-server.js | OAuth2 callback URL |
| GOOGLE_REFRESH_TOKEN | calendar.js, demo/demo-server.js | Stored after first auth |
| GOOGLE_CALENDAR_ID | calendar.js | Target calendar (default: primary) |
| DASHBOARD_USERNAME | dashboard.js | Login username |
| DASHBOARD_PASSWORD | dashboard.js | Login password |
| APP_URL | server.js | Base URL for photo upload links |
| BUSINESS_NAME | server.js | Used in missed-call voice message |
| SESSION_SECRET | server.js | Cookie session signing key |

---

## Common Change Patterns

| What to change | Files to READ | Files to EDIT |
|---|---|---|
| Main bot persona / coverage | src/systemPrompt.js | src/systemPrompt.js |
| Demo bot persona / coverage | demo/demo-ai.js | demo/demo-ai.js |
| Emergency handling rules | src/systemPrompt.js | src/systemPrompt.js |
| Travel fee logic | postcode.js | postcode.js |
| Add new SMS feature (main) | server.js, db.js | server.js, db.js |
| Add new demo route | demo/demo-server.js | demo/demo-server.js |
| Dashboard UI | public/dashboard.html | public/dashboard.html |
| Dashboard API endpoint | dashboard.js | dashboard.js |
| Calendar booking logic | calendar.js | calendar.js |
| Photo quote feature | server.js, ai.js, public/quote-upload.html | varies |
| Message cleaning / formatting | ai.js, demo/demo-ai.js | both |
| AI model or token limits | ai.js, demo/demo-ai.js | varies |
| Fallback error message | server.js (catch block), demo/demo-server.js (catch block) | both |

---

## Package Dependencies
express, twilio, @anthropic-ai/sdk, better-sqlite3, axios, cookie-session, googleapis, date-fns, date-fns-tz, dotenv

## Runtime Notes
- Node.js with CommonJS throughout (require/module.exports â no ES modules)
- Railway deployment: push to main â auto-deploy
- SQLite DBs are ephemeral on Railway (reset on container restart)
- Google OAuth tokens stored in SQLite settings table after first /auth/google flow
