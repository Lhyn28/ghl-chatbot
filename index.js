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
      ghlId: contactId,
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

  // 🧠 NAME (LOCKED)
  if (!leadData[contactId].name) {
    const name = extractName(userMessage);
    if (name) leadData[contactId].name = name;
  }

  // 🧠 EMAIL
  if (!leadData[contactId].email && userMessage.includes("@")) {
    leadData[contactId].email = userMessage;
  }

  // 🧠 DATE
  const date = detectDate(userMessage);
  if (date) leadData[contactId].booking.date = date;

  // 🧠 TIME
  const timeMatch = userMessage.match(/\d{1,2}\s?(am|pm)/i);
  if (timeMatch) leadData[contactId].booking.time = timeMatch[0];

  let reply = "Got it 😊";

  // 🎯 FLOW
  try {

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
        leadData[contactId].stage = "assist";
        reply = "Perfect 😊 What are you trying to improve?";
      } else {
        reply = "Could you share your email? 😊";
      }
    }

    else {
      reply = await safeAIReply(contactId);
    }

  } catch (err) {
    console.log("❌ FLOW ERROR:", err);
  }

  // 🔥 HANDLE NOT AVAILABLE
  if (userMessage.toLowerCase().includes("not available")) {
    reply = `No problem 😊 Here are other times:\n${suggestDates()}`;
  }

  // 🔥 SUGGEST TIMES
  if (
    leadData[contactId].booking.date &&
    !leadData[contactId].booking.time
  ) {
    reply += `\n\nAvailable times:\n${suggestDates()}`;
  }

  // 🔥 BOOKING
  if (
    leadData[contactId].booking.date &&
    leadData[contactId].booking.time &&
    leadData[contactId].email &&
    !leadData[contactId].booking.saved
  ) {
    leadData[contactId].booking.saved = true;

    await createAppointment(leadData[contactId]);

    const formatted = formatDate(
      leadData[contactId].booking.date,
      leadData[contactId].booking.time
    );

    reply = `Perfect 😊 you're booked for ${formatted}. 

You'll receive a confirmation email shortly!`;
  }

  await sendMessage(contactId, reply);
  conversationHistory[contactId].push({ role: 'assistant', content: reply });

  processAsync(contactId);
});


// 🤖 SAFE AI
async function safeAIReply(contactId) {
  try {
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
            content: `You are Lhyn, a helpful human assistant. Keep it short and natural.`
          },
          ...history
        ]
      })
    });

    const data = await res.json();
    return data?.choices?.[0]?.message?.content || "Got it 😊";

  } catch (err) {
    console.log("❌ AI ERROR:", err);
    return "Got it 😊 let me help you.";
  }
}


// 🔥 BOOK APPOINTMENT
async function createAppointment(lead) {
  const iso = buildDateTime(lead.booking.date, lead.booking.time);

  await fetch('https://services.leadconnectorhq.com/calendars/events', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      'Content-Type': 'application/json',
      Version: '2021-04-15'
    },
    body: JSON.stringify({
      calendarId: CALENDAR_ID,
      contactId: lead.ghlId,
      startTime: iso,
      title: `Call with ${lead.name || "Client"}`
    })
  });
}


// 🧠 DATE
function detectDate(text) {
  const today = new Date();
  text = text.toLowerCase();

  let d = new Date(today);

  if (text.includes("day after tomorrow")) d.setDate(d.getDate() + 2);
  else if (text.includes("tomorrow")) d.setDate(d.getDate() + 1);
  else return null;

  return d;
}


// 🧠 TIME BUILD
function buildDateTime(dateObj, timeStr) {
  const date = new Date(dateObj);

  let [hour, mod] = timeStr.toLowerCase().split(/(am|pm)/);
  hour = parseInt(hour.trim());

  if (mod === "pm" && hour !== 12) hour += 12;
  if (mod === "am" && hour === 12) hour = 0;

  date.setHours(hour, 0, 0);
  return date.toISOString();
}


// 🧠 FORMAT
function formatDate(date, time) {
  return new Date(date).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric"
  }) + ` at ${time}`;
}


// 🧠 SUGGEST
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

  if (lead.email && !lead.ghlIdCreated) {
    const id = await createContact(lead);
    if (id) {
      lead.ghlId = id;
      lead.ghlIdCreated = true;
    }
  }

  await updateContact(lead);
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

async function updateContact(lead) {
  await fetch(`https://services.leadconnectorhq.com/contacts/${lead.ghlId}`, {
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


// 📤 SEND
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
  console.log("🔥 FIXED NO-CRASH SYSTEM LIVE");
});
