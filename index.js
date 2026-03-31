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

  // 🔥 NAME EXTRACTION
  const detectedName = extractName(userMessage);
  if (!leadData[contactId].name && detectedName) {
    leadData[contactId].name = detectedName;
  }

  // 🔥 EMAIL + CREATE CONTACT
  if (!leadData[contactId].email && userMessage.includes("@")) {
    leadData[contactId].email = userMessage;

    const newId = await createContact(leadData[contactId]);
    if (newId) leadData[contactId].ghlId = newId;
  }

  // 🔥 DATE
  const detectedDate = getDateFromText(userMessage);
  if (detectedDate) {
    leadData[contactId].booking.date = detectedDate;
  }

  // 🔥 TIME
  if (!leadData[contactId].booking.time) {
    const match = userMessage.match(/\d{1,2}\s?(am|pm)/i);
    if (match) {
      leadData[contactId].booking.time = match[0];
    }
  }

  // 🔥 SAVE BOOKING + TRIGGER WORKFLOW
  if (
    leadData[contactId].booking.date &&
    leadData[contactId].booking.time &&
    !leadData[contactId].booking.saved
  ) {
    leadData[contactId].booking.saved = true;

    await saveBookingToGHL(contactId, leadData[contactId]);
    await sendConversationEmail(contactId);
  }

  const aiReply = await callOpenRouter(contactId);

  conversationHistory[contactId].push({
    role: 'assistant',
    content: aiReply
  });

  await sendGHLMessage(contactId, aiReply);

  handleFollowUp(contactId);
});


// 🧠 NAME PARSER
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
async function callOpenRouter(contactId) {
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

- Ask for name naturally
- Ask for email once
- Help user book a call
- Answer clearly
- Be warm, human, not robotic`
        },
        ...history
      ]
    })
  });

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "Sorry, something went wrong.";
}


// 🔥 CREATE CONTACT
async function createContact(lead) {
  try {
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/`, {
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
    console.log("✅ CONTACT:", data);

    return data.contact?.id;

  } catch (err) {
    console.log("❌ CONTACT ERROR:", err);
  }
}


// 🔥 SAVE BOOKING (FORCE TRIGGER)
async function saveBookingToGHL(contactId, lead) {

  const id = lead.ghlId || contactId;

  await fetch(`https://services.leadconnectorhq.com/contacts/${id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      'Content-Type': 'application/json',
      'Version': '2021-04-15'
    },
    body: JSON.stringify({
      customFields: [
        { key: "booking_date", field_value: lead.booking.date },
        { key: "booking_time", field_value: lead.booking.time }
      ],
      tags: ["booking_request"]
    })
  });
}


// 📩 EMAIL (YOU)
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
      to: ["hello@lhynworks.com"],
      subject: "New AI Lead",
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
      'Version': '2021-04-15'
    },
    body: JSON.stringify({
      type: 'Live_Chat',
      contactId,
      message
    })
  });
}


// ⏱ FOLLOW-UPS (FIXED)
function handleFollowUp(contactId) {

  if (timers[contactId]) {
    clearTimeout(timers[contactId].first);
    clearTimeout(timers[contactId].second);
  }

  timers[contactId] = {};

  timers[contactId].first = setTimeout(() => {
    sendGHLMessage(contactId, "Hey 😊 just checking — are you still there?");
  }, 120000);

  timers[contactId].second = setTimeout(async () => {
    await sendGHLMessage(contactId, "No worries if you're busy 😊 I'll close this for now, feel free to come back anytime!");
    await sendConversationEmail(contactId);
    delete timers[contactId];
  }, 300000);
}


app.listen(process.env.PORT || 3000, () => {
  console.log("🔥 Lhyn AI Assistant FULLY LIVE");
});
