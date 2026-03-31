import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

const GHL_API_KEY = process.env.GHL_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const CALENDAR_ID = process.env.CALENDAR_ID;

const conversationHistory = {};
const leadData = {};

app.post('/webhook/ghl-chat', async (req, res) => {

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
  const name = extractName(userMessage);
  if (name) leadData[contactId].name = name;

  // 🧠 EMAIL
  if (userMessage.includes("@")) {
    leadData[contactId].email = userMessage;
  }

  // 🧠 DATE + TIME
  const date = detectDate(userMessage);
  if (date) leadData[contactId].booking.date = date;

  const timeMatch = userMessage.match(/\d{1,2}\s?(am|pm)/i);
  if (timeMatch) leadData[contactId].booking.time = timeMatch[0];

  let reply;

  // 🎯 FLOW

  if (leadData[contactId].stage === "ask_name") {
    reply = "Hi 😊 how are you today? May I know your name?";
    leadData[contactId].stage = "get_name";
  }

  else if (leadData[contactId].stage === "get_name") {
    if (leadData[contactId].name) {
      leadData[contactId].stage = "ask_email";
      reply = `Nice to meet you, ${leadData[contactId].name} 😊 What's your email so I can send details?`;
    } else {
      reply = "Sorry I didn’t catch your name 😊";
    }
  }

  else if (leadData[contactId].stage === "ask_email") {
    if (leadData[contactId].email) {
      leadData[contactId].stage = "ask_goal";
      reply = "Perfect 😊 What are you trying to improve or achieve?";
    } else {
      reply = "Could you share your email? 😊";
    }
  }

  else if (leadData[contactId].stage === "ask_goal") {
    leadData[contactId].stage = "assist";

    reply = await generateReply(contactId);

    reply += "\n\nIf you want, we can go through it on a quick call 😊";
  }

  else {
    reply = await generateReply(contactId);
  }

  // 🔥 FINAL BOOKING (REAL DATE FIX)
  if (
    leadData[contactId].booking.date &&
    leadData[contactId].booking.time &&
    leadData[contactId].email &&
    !leadData[contactId].booking.saved
  ) {
    leadData[contactId].booking.saved = true;

    await createAppointment(contactId, leadData[contactId]);

    const formatted = formatDate(
      leadData[contactId].booking.date,
      leadData[contactId].booking.time
    );

    reply = `Perfect 😊 you're booked for ${formatted}. 

I'll send you a confirmation email shortly. Looking forward to speaking with you!`;
  }

  await sendMessage(contactId, reply);
  conversationHistory[contactId].push({ role: 'assistant', content: reply });

  processAsync(contactId);
});


// 🤖 HUMAN RESPONSE
async function generateReply(contactId) {
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
          content: `You are Lhyn, a friendly human assistant.

- Answer clearly
- Suggest solutions
- Give estimates if asked
- Be natural, not pushy
- Keep replies short`
        },
        ...history
      ]
    })
  });

  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "Got it 😊";
}


// 🧠 BUILD REAL DATETIME
function buildDateTime(dateObj, timeStr) {
  const date = new Date(dateObj);

  let [hour, modifier] = timeStr.toLowerCase().split(/(am|pm)/);
  hour = parseInt(hour.trim());

  if (modifier === "pm" && hour !== 12) hour += 12;
  if (modifier === "am" && hour === 12) hour = 0;

  date.setHours(hour, 0, 0);

  return date.toISOString();
}


// 🔥 CREATE REAL APPOINTMENT
async function createAppointment(contactId, lead) {

  const isoTime = buildDateTime(
    lead.booking.date,
    lead.booking.time
  );

  console.log("📅 BOOKING:", isoTime);

  await fetch('https://services.leadconnectorhq.com/calendars/events', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      'Content-Type': 'application/json',
      Version: '2021-04-15'
    },
    body: JSON.stringify({
      calendarId: CALENDAR_ID,
      contactId: contactId,
      startTime: isoTime,
      title: `Call with ${lead.name || "Client"}`
    })
  });
}


// 🧠 FORMAT DATE
function formatDate(date, time) {
  return new Date(date).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric"
  }) + ` at ${time}`;
}


// 🧠 DATE DETECT
function detectDate(text) {
  const today = new Date();
  text = text.toLowerCase();

  let d = new Date(today);

  if (text.includes("day after tomorrow")) d.setDate(d.getDate() + 2);
  else if (text.includes("tomorrow")) d.setDate(d.getDate() + 1);
  else return null;

  return d;
}


// 🧠 NAME
function extractName(text) {
  const clean = text.trim();

  if (!clean.includes("@") && clean.split(" ").length === 1) return clean;

  const patterns = [/my name is (.+)/i, /i am (.+)/i, /i'm (.+)/i];

  for (let p of patterns) {
    const m = clean.match(p);
    if (m) return m[1].split(" ")[0];
  }

  return null;
}


// 🔥 BACKGROUND
async function processAsync(contactId) {
  const lead = leadData[contactId];

  if (lead.email && !lead.ghlId) {
    const id = await createContact(lead);
    if (id) lead.ghlId = id;
  }

  await updateContact(contactId, lead);
}


// 🔥 CONTACT
async function createContact(lead) {
  const res = await fetch('https://services.leadconnectorhq.com/contacts/', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      'Content-Type': 'application/json',
      Version: '2021-04-15'
    },
    body: JSON.stringify({
      firstName: lead.name,
      email: lead.email
    })
  });

  const data = await res.json();
  return data.contact?.id;
}

async function updateContact(contactId, lead) {
  await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      'Content-Type': 'application/json',
      Version: '2021-04-15'
    },
    body: JSON.stringify({
      firstName: lead.name,
      email: lead.email
    })
  });
}


// 📤 SEND MESSAGE
async function sendMessage(contactId, message) {
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

app.listen(process.env.PORT || 3000, () => {
  console.log("🔥 REAL BOOKING SYSTEM LIVE");
});
