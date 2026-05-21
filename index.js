require('dotenv').config();
const express = require('express');

// Import all three sub-apps (each exports its Express app)
const mainApp = require('./server');
const demoApp = require('./demo/demo-server');
const jakeApp = require('./jake/jake-server');

const combined = express();
const PORT = process.env.PORT || 3000;

// Main receptionist — routes: /sms-incoming, /call-missed, /dashboard, /auth/*
combined.use(mainApp);

// Demo bot — routes already prefixed /demo/*
combined.use(demoApp);

// Jake outbound — routes prefixed with /jake: /jake/incoming, /jake/api/*
combined.use('/jake', jakeApp);

// ── Campaign trigger ─────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const twilio = require('twilio');
const { addMessage, getConversation, upsertProspect, markSent } = require('./jake/jake-db');

const JAKE_OPENERS = [
  "Hey, quick question. What happens when a customer calls and you're up a tree and can't answer?",
  "Hi, just a quick one. When you're on a job and miss a call, do you usually get back to them or do they just go elsewhere?",
  "Hey, random question. How many enquiries do you reckon you miss a week when you're mid job or off the clock?",
  "Hi, just wanted to ask. What do you do with customer enquiries that come in after hours when you're done for the day?",
  "Hey quick question. If someone texts you about a job while you're up a tree, how long does it usually take you to get back to them?",
];

combined.get('/trigger-campaign', async (req, res) => {
  try {
    const csvPath = path.join(__dirname, 'jake', 'contacts.csv');
    if (!fs.existsSync(csvPath)) {
      return res.status(404).send('contacts.csv not found at ' + csvPath);
    }
    const jakeTwilio = twilio(
      process.env.JAKE_TWILIO_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID,
      process.env.JAKE_TWILIO_AUTH_TOKEN  || process.env.TWILIO_AUTH_TOKEN
    );
    const JAKE_FROM = process.env.JAKE_PHONE_NUMBER;
    if (!JAKE_FROM) return res.status(500).send('JAKE_PHONE_NUMBER not set');

    const raw = fs.readFileSync(csvPath, 'utf-8');
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const contacts = lines.slice(1).map(line => {
      const vals = line.split(',').map(v => v.trim());
      const obj = {};
      headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
      return obj;
    });

    const dryRun = req.query.dryRun === 'true';
    let sent = 0, skipped = 0, failed = 0;

    res.setHeader('Content-Type', 'text/plain');
    res.write(`Starting campaign for ${contacts.length} contacts (dryRun=${dryRun})\n`);

    for (const contact of contacts) {
      const phone = (contact.phone || contact.mobile || contact.number || '').trim();
      if (!phone) { skipped++; res.write(`SKIP (no phone): ${JSON.stringify(contact)}\n`); continue; }
      if (getConversation(phone).length > 0) {
        skipped++;
        res.write(`SKIP (existing conversation): ${phone}\n`);
        continue;
      }
      const opener = JAKE_OPENERS[Math.floor(Math.random() * JAKE_OPENERS.length)];
      upsertProspect(phone, contact.name || '', contact.business || '');
      if (dryRun) {
        sent++;
        res.write(`DRY RUN: would send to ${phone}: ${opener}\n`);
        continue;
      }
      try {
        await jakeTwilio.messages.create({ body: opener, from: JAKE_FROM, to: phone });
        addMessage(phone, 'assistant', opener);
        markSent(phone);
        sent++;
        res.write(`SENT: ${phone}\n`);
      } catch (err) {
        failed++;
        res.write(`FAILED: ${phone}: ${err.message}\n`);
      }
      await new Promise(r => setTimeout(r, 2000));
    }

    res.end(`\nDone. Sent: ${sent} Skipped: ${skipped} Failed: ${failed}\n`);
  } catch (err) {
    res.status(500).send('Campaign error: ' + err.message);
  }
});

combined.listen(PORT, () => {
  console.log(`\n🚀 All services running on port ${PORT}\n`);
    console.log(`  🌿 Main Receptionist`);
      console.log(`     SMS webhook:  POST /sms-incoming`);
        console.log(`     Call webhook: POST /call-missed`);
          console.log(`     Dashboard:    GET  /dashboard`);
            console.log(`\n  🌳 Demo Bot (Joe's Tree Services)`);
              console.log(`     SMS webhook:  POST /demo/sms-incoming`);
                console.log(`     Call webhook: POST /demo/call-missed`);
                  console.log(`     Dashboard:    GET  /demo/dashboard`);
                    console.log(`\n  📱 Jake Outbound Caller`);
                      console.log(`     SMS webhook:  POST /jake/incoming`);
                        console.log(`     Prospects:    GET  /jake/api/prospects`);
                          console.log(`     Convos:       GET  /jake/api/conversations`);
                          });
