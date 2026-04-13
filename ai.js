const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const { buildSystemPrompt } = require('./src/systemPrompt');

const getAIReply = async (callerNumber, conversationHistory) => {
  const response = await client.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 1000, system: buildSystemPrompt(), messages: conversationHistory });
  return response.content.find(b => b.type === 'text')?.text || "Sorry, just give us a call back when you get a chance!";
};

const parseBooking = (text) => { const m=text.match(/##BOOK:(.+?)\|(.+?)\|(.+?)\|(.+?)##/);if(m)return {date:m[1].trim(),time:m[2].trim(),job:m[3].trim(),postcode:m[4].trim()};return null; };
const cleanReply = (text) => text.replace(/##BOOK:.+?##/g, '').replace(/##PHOTO_REQUEST##/g, '').trim();

// Assess an image from a Twilio MMS URL
const assessImage = async (imageUrl, mimeType='image/jpeg', caption='') => {
  const axios = require('axios');
  const imgResp = await axios.get(imageUrl, {responseType:'arraybuffer',auth:{username:process.env.TWILIO_ACCOUNT_SID,password:process.env.TWILIO_AUTH_TOKEN}});
  const b64 = Buffer.from(imgResp.data).toString('base64');
  const prompt = caption ? `Customer said: "${caption}". Assess the tree/vegetation work visible and provide a rough quote range in 2-3 SMS-short sentences.` : 'Assess the tree/vegetation work in this photo and provide a rough quote range in 2-3 SMS-short sentences.';
  const r = await client.messages.create({model:'claude-opus-4-6',max_tokens;400,system:buildSystemPrompt(),messages:[{role:'user',content:[{type:'image',source:{type:'base64',media_type:mimeType,data:b64}},{type:'text',text:prompt}]}]});
  return r.content[0].text.trim();
};

// Assess an image from raw base64 data (used by the photo upload feature)
const assessImageData = async (b64, mimeType='image/jpeg', caption='') => {
  const prompt = caption
    ? `Customer said: "${caption}". Assess the tree/vegetation work visible and provide a rough quote range in 2-3 SMS-short sentences.`
    : 'Assess the tree/vegetation work in this photo and provide a rough quote range in 2-3 SMS-short sentences.';
  const r = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 400,
    system: buildSystemPrompt(),
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: b64 } },
        { type: 'text', text: prompt }
      ]
    }]
  });
  return r.content[0].text.trim();
};

module.exports = { getAIReply, parseBooking, cleanReply, assessImage, assessImageData };
