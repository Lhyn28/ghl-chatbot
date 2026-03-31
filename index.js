import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

const GHL_API_KEY = process.env.GHL_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

const conversationHistory = {};
const leadData = {};
const timers = {};

app.post('/webhook/ghl-chat', async (req, res) => {

  const contactId = req.body.contact_id;
  const message = req.body.message;

  res.sendStatus(200);
  if (!contactId) return;

  if (!conversationHistory[contactId]) {
    conversationHistory[contactId] = [];
    leadData[contactId] = {
      name: null,
      email: null,
      booking: { date: null, time: null, saved: false }
    };
  }

  const userMessage = typeof message === "string"
    ? message
    : message?.body || "";

  if (!userMessage) return;

  // 🧠 SAVE MESSAGE
  conversationHistory[contactId].push({
    role: 'user',
    content: userMessage
  });

  // 🔥 NAME
  if (!leadData[contactId].name && userMessage.length < 30 && !userMessage.includes("@")) {
    leadData[contactId].name = userMessage;
  }

  // 🔥 EMAIL
  if (!leadData[contactId].email && userMessage.includes("@")) {
    leadData[contactId].email = userMessage;
    await updateContact(contactId, leadData[contactId]);
  }

  // 🔥 DATE
  if (!leadData[contactId].booking.date) {
    if (userMessage.toLowerCase().includes("tomorrow")) {
      leadData[contactId].booking.date = "Tomorrow";
    }
  }

  // 🔥 TIME
  if (!leadData[contactId].booking.time) {
    const match = userMessage.match(/\d{1,2}(am|pm)/i);
    if (match) {
      leadData[contactId].booking.time = match[0];
    }
  }

  // 🔥 SAVE BOOKING
  if (
    leadData[contactId].booking.date &&
    leadData[contactId].booking.time &&
    !leadData[contactId].booking.saved
  ) {
    leadData[contactId].booking.saved = true;
    await saveBookingToGHL(contactId, leadData[contactId].booking);
  }

  const aiReply = await callOpenRouter(contactId, leadData[contactId]);

  conversationHistory[contactId].push({
    role: 'assistant',
    content: aiReply
  });

  await sendGHLMessage(contactId, aiReply);

  handleFollowUp(contactId);
});


// 🤖 AI
async function callOpenRouter(contactId, lead) {
  const history = conversationHistory[contactId] || [];

  return (await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'openai/gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: `You are a human-like assistant for Lhyn Works.

RULE:
Never tell user to visit website. Answer everything directly.

SERVICES:
Funnels, automation, AI chatbot, lead generation.

FLOW:
- Ask name
- Ask email once
- Ask needs
- Qualify
- Guide booking naturally

BOOKING:
Suggest times → confirm → say "I'll book it for you"

STYLE:
Short, natural, friendly`
        },
        ...history
      ]
    })
  }).then(r => r.json())).choices[0].message.content;
}


// 💾 SAVE CONTACT
async function updateContact(contactId, lead) {
  await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: lead.name,
      email: lead.email
    })
  });
}


// 📅 SAVE BOOKING
async function saveBookingToGHL(contactId, booking) {
  await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      customFields: [
        { key: "booking_date", field_value: booking.date },
        { key: "booking_time", field_value: booking.time }
      ]
    })
  });
}


// 📩 EMAIL FULL CONVERSATION
async function sendConversationEmail(contactId) {

  const history = conversationHistory[contactId];
  if (!history) return;

  const transcript = history.map(m =>
    `${m.role.toUpperCase()}: ${m.content}`
  ).join("\n\n");

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: "AI Bot <onboarding@resend.dev>",
      to: ["yourteam@email.com"],
      subject: "New Chat Lead",
      text: transcript
    })
  });

  console.log("📩 Email sent");
}


// 📤 SEND MESSAGE
async function sendGHLMessage(contactId, message) {
  await fetch('https://services.leadconnectorhq.com/conversations/messages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      'Content-Type': 'application/json',
      Version: '2021-04-15'
    },
    body: JSON.stringify({
      type: 'Live_Chat',
      contactId,
      message
    })
  });
}


// ⏱ FOLLOW-UP + EMAIL
function handleFollowUp(contactId) {

  if (timers[contactId]) clearTimeout(timers[contactId]);

  timers[contactId] = setTimeout(() => {
    sendGHLMessage(contactId, "Hey 😊 just checking — are you still there?");
  }, 60000);

  setTimeout(async () => {
    await sendGHLMessage(contactId, "No worries if you're busy! Feel free to come back anytime 👍");
    await sendConversationEmail(contactId);
  }, 120000);
}


app.listen(process.env.PORT || 3000);
