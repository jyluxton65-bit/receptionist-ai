/**
 * send-campaign.js
 *
 * Usage:
 *   node jake/send-campaign.js jake/contacts.csv
 *
 * CSV format (first row is headers):
 *   phone,name,business
 *   +447700900001,Dave Smith,DS Tree Services
 *
 * Env vars required:
 *   JAKE_PHONE_NUMBER  - your Jake Twilio number
 *   TWILIO_ACCOUNT_SID / JAKE_TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN  / JAKE_TWILIO_AUTH_TOKEN
 *   ANTHROPIC_API_KEY
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs      = require('fs');
const path    = require('path');
const twilio  = require('twilio');
const { upsertProspect, addMessage, markSent, getConversation } = require('./jake-db');

const twilioClient = twilio(
  process.env.JAKE_TWILIO_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID,
  process.env.JAKE_TWILIO_AUTH_TOKEN  || process.env.TWILIO_AUTH_TOKEN
);

const JAKE_FROM      = process.env.JAKE_PHONE_NUMBER;
const RATE_LIMIT_MS  = parseInt(process.env.JAKE_RATE_LIMIT_MS || '2000', 10);
const DRY_RUN        = process.env.JAKE_DRY_RUN === 'true';

const OPENERS = [
  "Hey, quick question. What happens when a customer calls and you're up a tree and can't answer?",
  "Hi, just a quick one. When you're on a job and miss a call, do you usually get back to them or do they just go elsewhere?",
  "Hey, random question. How many enquiries do you reckon you miss a week when you're mid job or off the clock?",
  "Hi, just wanted to ask. What do you do with customer enquiries that come in after hours when you're done for the day?",
  "Hey quick question. If someone texts you about a job while you're up a tree, how long does it usually take you to get back to them?",
];

function randomOpener() {
  return OPENERS[Math.floor(Math.random() * OPENERS.length)];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseCSV(filePath) {
  const raw     = fs.readFileSync(filePath, 'utf-8');
  const lines   = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  return lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim());
    const obj  = {};
    headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
    return obj;
  });
}

async function runCampaign(csvPath) {
  if (!fs.existsSync(csvPath)) {
    console.error('CSV file not found: ' + csvPath); process.exit(1);
  }
  if (!JAKE_FROM) { console.error('JAKE_PHONE_NUMBER not set'); process.exit(1); }
  const contacts = parseCSV(csvPath);
  console.log('Loaded ' + contacts.length + ' contacts from ' + csvPath);
  if (DRY_RUN) console.log('DRY RUN mode - no messages sent');
  let sent = 0, skipped = 0, failed = 0;
  for (const contact of contacts) {
    const phone = (contact.phone || contact.mobile || contact.number || '').trim();
    if (!phone) { skipped++; continue; }
    if (getConversation(phone).length > 0) { skipped++; continue; }
    const opener = randomOpener();
    upsertProspect(phone, contact.name || '', contact.business || '');
    if (DRY_RUN) { sent++; continue; }
    try {
      await twilioClient.messages.create({ body: opener, from: JAKE_FROM, to: phone });
      addMessage(phone, 'assistant', opener);
      markSent(phone); sent++;
      console.log('Sent to ' + phone);
    } catch (err) {
      failed++; console.error('Failed ' + phone + ': ' + err.message);
    }
    await sleep(RATE_LIMIT_MS);
  }
  console.log('Campaign done. Sent: ' + sent + ' Skipped: ' + skipped + ' Failed: ' + failed);
}

const csvArg = process.argv[2];
if (!csvArg) {
  console.error('Usage: node jake/send-campaign.js <path-to-contacts.csv>');
  process.exit(1);
}
runCampaign(path.resolve(csvArg));
