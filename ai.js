const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const buildSystemPrompt = () => {
  const { getSetting } = require('./db');
  const dayRate = getSetting('day_rate') || '350';
  const halfRate = getSetting('half_day_rate') || '200';
  const smallRate = getSetting('small_job_rate') || '80';
  return `You are an AI receptionist for ${process.env.BUSINESS_NAME}, a tree surgery business run by ${process.env.BUSINESS_OWNER_NAME}.\n\nA customer just tried to call and couldn't get through. You texted them first to let them know ${process.env.BUSINESS_OWNER_NAME} will call back, and now they're replying.\n\nYOUR JOB: Have a friendly text conversation to find out what they need, get their details, and either book them in or answer basic questions.\n\nBUSINESS INFO:\n- Name: ${process.env.BUSINESS_NAME}\n- Owner: ${process.env.BUSINESS_OWNER_NAME}\n- Services: ${process.env.BUSINESS_SERVICES}\n- Area: ${process.env.BUSINESS_AREA}\n\nCURRENT RATES (only share if asked):\n- Day rate: £${dayRate}\n- Half-day rate: £${halfRate}\n- Small jobs: from £${smallRate}\n- Callout: free within 10 miles of Didsbury M20, £1.50/mile beyond, no travel beyond 25 miles\n\nWHAT TO FIND OUT: job needed, location/postcode, urgency, best time for callback\svite\n\nBOOKING: When confirmed add ##BOOK:[date]|[time]|[job]|[postcode]## on a new line\n\nSTYLE: SMS-short (1-3 sentences), friendly British, no em dashes, no bullet points, sound human. Never admit you're an AI unless asked.\n\nPRICING: Never give specific prices for jobs. Say ${process.env.BUSINESS_OWNER_NAME} will give a proper quote.`;
};

const getAIReply = async (callerNumber, conversationHistory) => {
  const response = await client.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 1000, system: buildSystemPrompt(), messages: conversationHistory });
  return response.content.find(b => b.type === 'text')?.text || "Sorry, just give us a call back when you get a chance!";
};

const parseBooking = (text) => { const m=text.match(/##BOOK:(.+?)\|(.+?)\|(.+?)\|(.+?)##/);if(m)return {date:m[1].trim(),time:m[2].trim(),job:m[3].trim(),postcode:m[4].trim()};return null; };
const cleanReply = (text) => text.replace(/##BOOK:.+?##/g, '').trim();

const assessImage = async (imageUrl, mimeType='image/jpeg', caption='') => {
  const axios = require('axios');
  const imgResp = await axios.get(imageUrl, {responseType:'arraybuffer',auth:{username:process.env.TWILIO_ACCOUNT_SID,password:process.env.TWILIO_AUTH_TOKEN}});
  const b64 = Buffer.from(imgResp.data).toString('base64');
  const prompt = caption ? `Customer said: "${caption}". Assess the tree/vegetation work visible and provide a rough quote range in 2-3 SMS-short sentences.` : 'Assess the tree/vegetation work in this photo and provide a rough quote range in 2-3 SMS-short sentences.';
  const r = await client.messages.create({model:'claude-opus-4-6',max_tokens:400,system:buildSystemPrompt(),messages:[{role:'user',content:[{type:'image',source:{type:'base64',media_type:mimeType,data:b64}},{type:'text',text:prompt}]}]});
  return r.content[0].text.trim();
};

module.exports = { getAIReply, parseBooking, cleanReply, assessImage };
