import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

const GHL_API_KEY = process.env.GHL_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

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

  // 🧠 DATE
  const detectedDate = detectDate(userMessage);
  if (detectedDate) leadData[contactId].booking.date = detectedDate;

  // 🧠 TIME
  const match = userMessage.match(/\d{1,2}\s?(am|pm)/i);
  if (match) leadData[contactId].booking.time = match[0];

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
      reply = "Perfect 😊 What are you currently trying to improve?";
    } else {
      reply = "Could you share your email? 😊";
    }
  }

  else if (leadData[contactId].stage === "ask_goal") {
    leadData[contactId].stage = "assist";

    reply = await generateReply(contactId);

    // 🔥 Suggest booking naturally
    reply += "\n\nIf you want, I can set up a quick call and walk you through it 😊";
  }

  else {
    reply = await generateReply(contactId);
  }

  // 🔥 DATE SUGGESTION (NEW FEATURE)
  if (detectedDate && !leadData[contactId].booking.time) {
    const suggestions = suggestDates();

    reply += `\n\nI have availability on:\n${suggestions}`;
  }

  // 🔥 FINAL BOOKING CONFIRMATION
  if (
    leadData[contactId].booking.date &&
    leadData[contactId].booking.time &&
    leadData[contactId].email &&
    !leadData[contactId].booking.saved
  ) {
    leadData[contactId].booking.saved = true;

    const formatted = formatDate(
      leadData[contactId].booking.date,
      leadData[contactId].booking.time
    );

    reply = `Perfect 😊 you're booked for ${formatted}.

I'll send the confirmation to your email. Looking forward to speaking with you!`;

    await saveBooking(contactId);
  }

  await sendMessage(contactId, reply);
  conversationHistory[contactId].push({ role: 'assistant', content: reply });

  processAsync(contactId);
});


// 🤖 HUMAN REPLY
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
          content: `You are Lhyn, a human assistant.

- Be helpful and natural
- Answer clearly
- Suggest solutions
- Give estimates if asked
- Do NOT push booking too early`
        },
        ...history
      ]
    })
  });

  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "Got it 😊";
}


// 🧠 DATE DETECTION
function detectDate(text) {
  const today = new Date();
  text = text.toLowerCase();

  let d = new Date(today);

  if (text.includes("day after tomorrow")) d.setDate(d.getDate() + 2);
  else if (text.includes("tomorrow")) d.setDate(d.getDate() + 1);
  else return null;

  return d;
}


// 🧠 DATE FORMAT
function formatDate(date, time) {
  return new Date(date).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric"
  }) + ` at ${time}`;
}


// 🧠 SUGGEST MULTIPLE DATES
function suggestDates() {
  const today = new Date();

  let options = [];

  for (let i = 1; i <= 3; i++) {
    let d = new Date(today);
    d.setDate(d.getDate() + i);

    options.push(
      d.toLocaleDateString("en-US", {
        weekday: "long",
        month: "short",
        day: "numeric"
      }) + " at 2pm"
    );
  }

  return options.join("\n");
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
      'Version': '2021-04-15'
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
      'Version': '2021-04-15'
    },
    body: JSON.stringify({
      firstName: lead.name,
      email: lead.email,
      customFields: [
        { key: "booking_date", field_value: lead.booking.date?.toISOString() },
        { key: "booking_time", field_value: lead.booking.time }
      ]
    })
  });
}


// 🔥 TAG
async function saveBooking(contactId) {
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


// 📤 SEND
async function sendMessage(contactId, message) {
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

app.listen(process.env.PORT || 3000, () => {
  console.log("🔥 SMART DATE SYSTEM READY");
});
