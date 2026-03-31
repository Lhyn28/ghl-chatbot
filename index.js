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

  const contactId = req.body.contact_id;
  const message = req.body.message;

  console.log("🔥 WEBHOOK HIT:", JSON.stringify(req.body, null, 2));

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

  // 🧠 NAME DETECTION (INSTANT + FIXED)
  const detectedName = extractName(userMessage);
  if (detectedName) leadData[contactId].name = detectedName;

  // 🧠 EMAIL
  if (userMessage.includes("@")) {
    leadData[contactId].email = userMessage;
  }

  // 🧠 DATE + TIME
  const detectedDate = getDateFromText(userMessage);
  if (detectedDate) leadData[contactId].booking.date = detectedDate;

  const match = userMessage.match(/\d{1,2}\s?(am|pm)/i);
  if (match) leadData[contactId].booking.time = match[0];

  // 🎯 FLOW (HUMANIZED)
  let reply;

  if (leadData[contactId].stage === "ask_name") {
    reply = "Hi 😊 how are you today? May I know your name?";
    leadData[contactId].stage = "get_name";
  }

  else if (leadData[contactId].stage === "get_name") {
    if (leadData[contactId].name) {
      leadData[contactId].stage = "qualify";
      reply = `Nice to meet you, ${leadData[contactId].name} 😊 What are you currently working on or trying to improve?`;
    } else {
      reply = "Sorry I didn’t catch your name 😊";
    }
  }

  else {
    // 🤖 HUMAN SALES AI
    reply = await generateHumanReply(contactId);
  }

  // 📅 FIX DATE TEXT OUTPUT
  if (leadData[contactId].booking.date && leadData[contactId].booking.time) {
    const formatted = formatBookingDate(
      leadData[contactId].booking.date,
      leadData[contactId].booking.time
    );

    reply = reply.replace(/\[DATE_TIME\]/g, formatted);
  }

  // 🚀 SEND FAST RESPONSE
  await sendGHLMessage(contactId, reply);
  conversationHistory[contactId].push({ role: 'assistant', content: reply });

  // ⚡ BACKGROUND TASKS
  processAsync(contactId);
});


// 🧠 HUMAN SALES RESPONSE (CONTROLLED)
async function generateHumanReply(contactId) {
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

IMPORTANT:
- Talk like a real person
- Never sound robotic
- Never sound scripted
- Keep replies short (2–3 sentences max)

STYLE:
- Warm
- Natural
- Conversational

SALES BEHAVIOR:
- Help first
- Suggest solutions
- Do NOT push booking too early
- Only suggest call when needed

EXAMPLE:

User: "How much?"
You:
"It really depends on what you're trying to achieve 😊

Some clients focus on getting more leads, others on automating their workflow.

What are you mainly trying to improve right now?"

If booking happens:
"Perfect 😊 I'll set that up for [DATE_TIME]. Looking forward to speaking with you!"`
        },
        ...history
      ]
    })
  });

  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "Got it 😊 let me help you.";
}


// 🚀 BACKGROUND TASKS
async function processAsync(contactId) {
  const lead = leadData[contactId];

  if (lead.email && !lead.ghlId) {
    const id = await createContact(lead);
    if (id) lead.ghlId = id;
  }

  await updateContact(contactId, lead);

  if (lead.booking.date && lead.booking.time && !lead.booking.saved) {
    lead.booking.saved = true;
    await saveBookingToGHL(contactId);
  }
}


// 🧠 NAME FIXED
function extractName(text) {
  const clean = text.trim();

  if (!clean.includes("@") && clean.split(" ").length === 1) {
    return clean;
  }

  const patterns = [
    /my name is (.+)/i,
    /i am (.+)/i,
    /i'm (.+)/i
  ];

  for (let p of patterns) {
    const m = clean.match(p);
    if (m && m[1]) return m[1].split(" ")[0];
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

  return d;
}


// 📅 FORMAT DATE
function formatBookingDate(date, time) {
  return new Date(date).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric"
  }) + ` at ${time}`;
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
      firstName: lead.name,
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
        { key: "booking_date", field_value: lead.booking.date?.toISOString() },
        { key: "booking_time", field_value: lead.booking.time }
      ]
    })
  });
}


// 🔥 TAG TRIGGER
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

app.listen(process.env.PORT || 3000, () => {
  console.log("🔥 FINAL HUMAN AI SALES READY");
});
