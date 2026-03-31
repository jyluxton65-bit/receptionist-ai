/**
 * Dashboard routes — mounted at /dashboard in server.js
 */

const express = require('express');
const router = express.Router();
const path = require('path');

const {
  getRecentConversations, getConversationHistory,
  getRecentAppointments, getAllSettings, setSetting, getSetting,
} = require('./db');

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.path.startsWith('/api')) return res.status(401).json({ error: 'Unauthorised' });
  res.redirect('/dashboard/login');
}

router.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Grafted Services -- Login</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1a12;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{background:#1a2b1e;border:1px solid #2d4a33;border-radius:12px;padding:40px;width:360px}.logo{text-align:center;margin-bottom:32px}.logo h1{color:#4caf50;font-size:22px}.logo p{color:#6b9e6f;font-size:13px;margin-top:4px}label{color:#a8d5ab;font-size:13px;display:block;margin-bottom:6px}input{width:100%;padding:10px 14px;background:#0f1a12;border:1px solid #2d4a33;border-radius:8px;color:#e0f0e0;font-size:14px;margin-bottom:16px}input:focus{outline:none;border-color:#4caf50}button{width:100%;padding:12px;background:#4caf50;color:white;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer}button:hover{background:#43a047}.error{color:#ef5350;font-size:13px;margin-bottom:16px;text-align:center}</style></head>
<body><div class="card"><div class="logo"><h1>🌳 Grafted Services</h1><p>AI Receptionist Dashboard</p></div>
#{ req.query.error ? '<p class="error">Invalid credentials</p>' : ''}
<form method="POST" action="/dashboard/login">
<label>Username</label><input type="text" name="username" autocomplete="username" required>
<label>Password</label><input type="password" name="password" autocomplete="current-password" required>
<button type="submit">Sign in</button></form></div></body></html>`);
});

router.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.DASHBOARD_USERNAME && password === process.env.DASHBOARD_PASSWORD) {
    req.session.authenticated = true;
    res.redirect('/dashboard');
  } else { res.redirect('/dashboard/login?error=1'); }
});

router.get('/logout', (req, res) => { req.session = null; res.redirect('/dashboard/login'); });
router.get('/', requireAuth, (req, res) => { res.sendFile(require('path').join(__dirname, 'public', 'dashboard.html')); });

router.get('/api/status', requireAuth, (req, res) => { const t=getSetting('google_tokens'); res.json({botEnabled:getSetting('bot_enabled')!=='false',calendarConnected:!!t}); });
router.get('/api/conversations', requireAuth, (req,res)=>res.json(getRecentConversations(50)));
router.get('/api/conversations/:phone',requireAuth,(req,res)=>{res.json(getConversationHistory(decodeURIComponent(req.params.phone),50));});
router.get('/api/appointments',requireAuth,(req,res)=>res.json(getRecentAppointments(20)));
router.get('/api/settings',requireAuth,(req,res)=>{const s=getAllSettings();delete s.google_tokens;res.json(s);});
router.post('/api/settings',requireAuth,express.json(),(req,res)=>{const a=['bot_enabled','day_rate','half_day_rate','small_job_rate'];for(const [k,v] of Object.entries(req.body))if(a.includes(k))setSettink(k,v);res.json({ok:true});});
module.exports=router;
