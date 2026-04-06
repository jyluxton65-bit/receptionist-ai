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
