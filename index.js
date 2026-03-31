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

  // 🔥 NAME
  if (!leadData[contactId].name && userMessage.length < 30 && !userMessage.includes("@")) {
    leadData[contactId].name = userMessage;
  }

  // 🔥 EMAIL + CREATE CONTACT
  if (!leadData[contactId].email && userMessage.includes("@")) {
    leadData[contactId].email = userMessage;

    const newId = await createContactIfNotExists(leadData[contactId]);
    if (newId) leadData[contactId].ghlId = newId;
  }

  // 🔥 DATE DETECTION (SMART)
  const detectedDate = getDateFromText(userMessage);
  if (detectedDate) {
    leadData[contactId].booking.date = detectedDate;
  }

  // 🔥 TIME DETECTION
  if (!leadData[contactId].booking.time) {
    const match = userMessage.match(/\d{1,2}\s?(am|pm)/i);
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


// 🧠 DATE PARSER
function getDateFromText(text) {
  const today = new Date();
  text = text.toLowerCase();

  let d = new Date(today);

  if (text.includes("day after tomorrow")) {
    d.setDate(d.getDate() + 2);
  } else if (text.includes("tomorrow")) {
    d.setDate(d.getDate() + 1);
  } else {
    return null;
  }

  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
}


// 🤖 AI
async function callOpenRouter(contactId, lead) {
  const history = conversationHistory[contactId] || [];

  const hour = new Date().getHours();
  let greeting = "Hello";

  if (hour < 12) greeting = "Good morning 😊";
  else if (hour < 18) greeting = "Good afternoon 😊";
  else greeting = "Good evening 😊";

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
          content: `${greeting}

You are a friendly human assistant named Lhyn.

IMPORTANT:
- Never send user to website
- Always answer directly
- Always use real dates (e.g., April 3, 2026)

SERVICES:
Funnels, automation, AI chatbot, lead generation.

FLOW:
- Ask name
- Ask email once
- Ask needs
- Qualify
- Guide booking

BOOKING:
- Suggest times
- Confirm date and time clearly
- Say you'll handle booking

STYLE:
Short, warm, natural`
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
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/`, {
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

    const data = await res.json();
    return data.contact?.id;

  } catch (err) {
    console.log("❌ CONTACT ERROR:", err);
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
      from: "Lhyn <hello@lhynworks.com>",
      to: ["yourteam@email.com"],
      subject: "New Chat Conversation",
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


// ⏱ FOLLOW-UPS
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
  console.log("🔥 Lhyn AI Assistant with REAL DATE LOGIC");
});
