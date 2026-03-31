import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

const GHL_API_KEY = process.env.GHL_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const conversationHistory = {};
const leadData = {};
const timers = {};

app.post('/webhook/ghl-chat', async (req, res) => {

  console.log("🔥 WEBHOOK HIT:", JSON.stringify(req.body, null, 2));

  const contactId = req.body.contact_id;
  const message = req.body.message;

  res.sendStatus(200);
  if (!contactId) return;

  if (!leadData[contactId]) {
    leadData[contactId] = {
      name: null,
      email: null,
      ghlId: null,
      stage: "ask_name",
      booking: { date: null, time: null, saved: false }
    };
    conversationHistory[contactId] = [];
  }

  const userMessage = typeof message === "string"
    ? message
    : message?.body || "";

  if (!userMessage) return;

  conversationHistory[contactId].push({ role: 'user', content: userMessage });

  // 🧠 DETECT NAME
  const detectedName = extractName(userMessage);
  if (detectedName) leadData[contactId].name = detectedName;

  // 🧠 DETECT EMAIL
  if (userMessage.includes("@")) {
    leadData[contactId].email = userMessage;
  }

  // 🔥 CREATE CONTACT ON EMAIL
  if (leadData[contactId].email && !leadData[contactId].ghlId) {
    const newId = await createContact(leadData[contactId]);
    if (newId) leadData[contactId].ghlId = newId;
  }

  // 🔥 ALWAYS UPDATE CONTACT
  await updateContact(contactId, leadData[contactId]);

  // 🧠 DATE + TIME
  const detectedDate = getDateFromText(userMessage);
  if (detectedDate) leadData[contactId].booking.date = detectedDate;

  const match = userMessage.match(/\d{1,2}\s?(am|pm)/i);
  if (match) leadData[contactId].booking.time = match[0];

  // 🔥 SAVE BOOKING
  if (
    leadData[contactId].booking.date &&
    leadData[contactId].booking.time &&
    !leadData[contactId].booking.saved
  ) {
    leadData[contactId].booking.saved = true;
    await saveBookingToGHL(contactId);
  }

  // 🎯 FLOW CONTROL
  let reply;

  if (leadData[contactId].stage === "ask_name") {
    reply = "Hi 😊 may I know your name?";
    leadData[contactId].stage = "get_name";
  }

  else if (leadData[contactId].stage === "get_name" && !leadData[contactId].name) {
    reply = "Sorry I didn’t catch your name 😊";
  }

  else if (leadData[contactId].stage === "get_name" && leadData[contactId].name) {
    leadData[contactId].stage = "ask_email";
    reply = `Nice to meet you, ${leadData[contactId].name} 😊 What's your email so I can send details?`;
  }

  else if (leadData[contactId].stage === "ask_email" && !leadData[contactId].email) {
    reply = "Could you share your email? 😊";
  }

  else {
    // 🤖 SALES AI MODE
    try {
      const ai = await callOpenRouter(contactId);
      reply = ai || "Got it 😊 let me help you.";
    } catch {
      reply = "Sorry 😅 something went wrong — can you try again?";
    }
  }

  conversationHistory[contactId].push({ role: 'assistant', content: reply });

  await sendGHLMessage(contactId, reply);

  handleFollowUp(contactId);
});


// 🧠 NAME
function extractName(text) {
  const lower = text.toLowerCase();

  if (lower.includes("my name is")) return text.split("my name is")[1].trim();
  if (lower.includes("i am")) return text.split("i am")[1].trim();
  if (lower.includes("i'm")) return text.split("i'm")[1].trim();

  if (text.split(" ").length === 1 && !text.includes("@")) {
    return text.trim();
  }

  return null;
}

// 🧠 DATE
function getDateFromText(text) {
  const today = new Date();
  text = text.toLowerCase();

  let d = new Date(today);

  if (text.includes("day after tomorrow")) d.setDate(d.getDate() + 2);
  else if (text.includes("tomorrow")) d.setDate(d.getDate() + 1);
  else return null;

  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
}

// 🤖 SALES AI
async function callOpenRouter(contactId) {
  const history = conversationHistory[contactId];

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
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
          content: `You are Lhyn, a friendly but confident sales assistant.

Your goal is to guide users toward booking a call.

- Always answer then guide
- Never reject clients
- Always offer help
- Move toward booking naturally`
        },
        ...history
      ]
    })
  });

  const data = await res.json();
  return data?.choices?.[0]?.message?.content;
}

// 🔥 CREATE CONTACT
async function createContact(lead) {
  const res = await fetch('https://services.leadconnectorhq.com/contacts/', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      'Content-Type': 'application/json',
      'Version': '2021-04-15'
    },
    body: JSON.stringify({
      firstName: lead.name || "Guest",
      email: lead.email
    })
  });

  const data = await res.json();
  return data.contact?.id;
}

// 🔥 UPDATE CONTACT
async function updateContact(contactId, lead) {
  const id = lead.ghlId || contactId;

  await fetch(`https://services.leadconnectorhq.com/contacts/${id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      'Content-Type': 'application/json',
      'Version': '2021-04-15'
    },
    body: JSON.stringify({
      firstName: lead.name,
      email: lead.email,
      customFields: [
        { key: "booking_date", field_value: lead.booking.date },
        { key: "booking_time", field_value: lead.booking.time }
      ]
    })
  });
}

// 🔥 SAVE BOOKING TAG
async function saveBookingToGHL(contactId) {
  await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      'Content-Type': 'application/json',
      'Version': '2021-04-15'
    },
    body: JSON.stringify({
      tags: ["booking_request"]
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
      'Version': '2021-04-15'
    },
    body: JSON.stringify({
      type: 'Live_Chat',
      contactId,
      message
    })
  });
}

// ⏱ FOLLOW UPS
function handleFollowUp(contactId) {

  if (timers[contactId]) {
    clearTimeout(timers[contactId].first);
    clearTimeout(timers[contactId].second);
  }

  timers[contactId] = {};

  timers[contactId].first = setTimeout(() => {
    sendGHLMessage(contactId, "Hey 😊 just checking — are you still there?");
  }, 120000);

  timers[contactId].second = setTimeout(() => {
    sendGHLMessage(contactId, "No worries if you're busy 😊 feel free to come back anytime!");
    delete timers[contactId];
  }, 300000);
}

app.listen(process.env.PORT || 3000, () => {
  console.log("🔥 Lhyn AI SALES SYSTEM READY");
});
