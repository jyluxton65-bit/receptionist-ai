# 🌿 ReceptionistAI Backend

AI-powered missed call handler for arborists. When a customer calls and can't get through, this automatically texts them back and has a full AI conversation to qualify the job and book them in.

---

## How It Works

1. Customer calls the arborist's number
2. Call goes unanswered → Twilio fires the `/call-missed` webhook
3. Server instantly texts the customer from the business number
4. Customer replies → Twilio fires `/sms-incoming`
5. Claude AI continues the conversation, finds out what job they need, books them in
6. Booking appears in Google Calendar automatically

---

## Setup (Step by Step)

### 1. Install dependencies
```bash
npm install
```

### 2. Set up your .env file
```bash
cp .env.example .env
```
Fill in all values in `.env` (see below for where to get each one).

### 3. Set up Twilio
- Sign up at twilio.com
- Buy a UK phone number (~£1/month)
- Go to your number's settings and set:
  - **"A call comes in"** → Webhook → `https://yourdomain.com/call-missed`
  - **"A message comes in"** → Webhook → `https://yourdomain.com/sms-incoming`
- To handle missed calls specifically, set your number's **ring timeout** to ~20 seconds, then point the "call status callback" to `/call-missed`

### 4. Set up Google Calendar API
- Go to console.cloud.google.com
- Create a new project
- Enable the **Google Calendar API**
- Create OAuth2 credentials (Web Application type)
- Add `http://localhost:3000/auth/callback` as an authorised redirect URI
- Copy the Client ID and Secret into your `.env`

Then run the server locally and visit:
```
http://localhost:3000/auth/google
```
This will open Google sign-in. Approve it, and you'll see your **refresh token** on screen. Copy it into your `.env` as `GOOGLE_REFRESH_TOKEN`.

### 5. Deploy to Railway (easiest option, free to start)
- Sign up at railway.app
- Connect your GitHub repo or drag and drop this folder
- Add all your `.env` variables in Railway's environment settings
- Railway gives you a public URL — use that in your Twilio webhook settings

### 6. Test it
```bash
npm run dev
```
Then use ngrok to expose your local server:
```bash
npx ngrok http 3000
```
Point your Twilio webhooks at the ngrok URL temporarily for testing.

---

## Project Structure

```
receptionist-backend/
├── server.js          # Main Express server, Twilio webhooks
├── ai.js              # Claude API integration
├── calendar.js        # Google Calendar integration
├── conversations.js   # In-memory conversation store
├── .env.example       # Environment variable template
├── package.json
└── README.md
```

---

## Costs (per customer per month)

| Item | Cost |
|------|------|
| Twilio number | ~£1 |
| Outbound SMS (~30 msgs) | ~£1.50 |
| Claude API (~30 replies) | ~£0.50 |
| Railway hosting (shared) | ~£0.50 |
| **Total** | **~£3.50** |

You're charging £67/month. Margin is very healthy.

---

## Customising for Each Customer

When you onboard a new arborist, update the `.env` variables:
- `BUSINESS_NAME` — their business name
- `BUSINESS_OWNER_NAME` — first name of the owner
- `BUSINESS_SERVICES` — what they offer
- `BUSINESS_AREA` — where they cover
- `GOOGLE_CALENDAR_ID` — their Google Calendar

For multiple customers on one server, move these into a database per customer and look them up by Twilio number.

---

## Next Steps

- [ ] Swap in-memory conversations for a database (Supabase is free and easy)
- [ ] Add a simple dashboard to see all conversations
- [ ] Add follow-up SMS if customer doesn't reply within 30 mins
- [ ] Introduce Voice AI plan (Twilio Voice + Claude for live call handling)
