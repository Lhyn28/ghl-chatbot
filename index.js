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
      ghlId: null,
      booking: { date: null, time: null, saved: false }
    };
  }

  const userMessage = typeof message === "string"
    ? message
    : message?.body || "";

  if (!userMessage) return;

  conversationHistory[contactId].push({
    role: 'user',
    content: userMessage
  });

  // 🔥 NAME DETECTION
  if (!leadData[contactId].name && userMessage.length < 30 && !userMessage.includes("@")) {
    leadData[contactId].name = userMessage;
  }

  // 🔥 EMAIL DETECTION + CREATE CONTACT
  if (!leadData[contactId].email && userMessage.includes("@")) {
    leadData[contactId].email = userMessage;

    const newId = await createContactIfNotExists(leadData[contactId]);
    if (newId) {
      leadData[contactId].ghlId = newId;
    }
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
    await saveBookingToGHL(contactId, leadData[contactId]);
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

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'openai/gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: `You are a friendly human assistant named Lhyn.

RULES:
- Never send user to website
- Answer everything directly
- Be natural and conversational

FLOW:
- Ask name
- Ask email once
- Ask what they need
- Guide to booking

BOOKING:
- Suggest times
- Confirm
- Say you'll handle it

STYLE:
Short, friendly, human`
        },
        ...history
      ]
    })
  });

  const data = await response.json();

  if (!data.choices || !data.choices[0]) {
    return "Sorry, something went wrong.";
  }

  return data.choices[0].message.content;
}


// 🔥 CREATE CONTACT
async function createContactIfNotExists(lead) {
  try {
    const response = await fetch(`https://services.leadconnectorhq.com/contacts/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GHL_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: lead.name,
        email: lead.email
      })
    });

    const data = await response.json();
    console.log("✅ CONTACT CREATED:", data);

    return data.contact?.id;

  } catch (err) {
    console.log("❌ CREATE ERROR:", err);
  }
}


// 📅 SAVE BOOKING
async function saveBookingToGHL(contactId, lead) {

  const id = lead.ghlId || contactId;

  await fetch(`https://services.leadconnectorhq.com/contacts/${id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      customFields: [
        { key: "booking_date", field_value: lead.booking.date },
        { key: "booking_time", field_value: lead.booking.time }
      ]
    })
  });
}


// 📩 EMAIL TRANSCRIPT
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
      from: "Lhyn <onboarding@resend.dev>",
      to: ["yourteam@email.com"],
      subject: "New Chat Lead",
      text: transcript
    })
  });
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


// ⏱ FOLLOW UPS (2 ONLY)
function handleFollowUp(contactId) {

  if (timers[contactId]) clearTimeout(timers[contactId]);

  timers[contactId] = setTimeout(() => {
    sendGHLMessage(contactId, "Hey 😊 just checking — are you still there?");
  }, 120000);

  setTimeout(async () => {
    await sendGHLMessage(contactId, "No worries if you're busy 😊 I'll close this for now, but feel free to message anytime!");
    await sendConversationEmail(contactId);
  }, 300000);
}


app.listen(process.env.PORT || 3000, () => {
  console.log("🔥 Lhyn AI Assistant LIVE");
});
