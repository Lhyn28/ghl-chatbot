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
      ghlIdCreated: false,
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

  // 🧠 NAME
  if (!leadData[contactId].name) {
    const name = extractName(userMessage);
    if (name) leadData[contactId].name = name;
  }

  // 🧠 EMAIL
  if (!leadData[contactId].email) {
    const email = extractEmail(userMessage);
    if (email) leadData[contactId].email = email;
  }

  // 🧠 DATE
  const date = detectDate(userMessage);
  if (date) leadData[contactId].booking.date = date;

  // 🧠 TIME
  const timeMatch = userMessage.match(/\d{1,2}\s?(am|pm)/i);
  if (timeMatch) leadData[contactId].booking.time = timeMatch[0];

  let reply = "Got it 😊";

  try {

    // FLOW
    if (leadData[contactId].stage === "ask_name") {
      reply = "Hey 😊 welcome! What’s your name?";
      leadData[contactId].stage = "get_name";
    }

    else if (leadData[contactId].stage === "get_name") {
      if (leadData[contactId].name) {
        leadData[contactId].stage = "ask_email";
        reply = `Nice to meet you, ${leadData[contactId].name} 😊 What’s your email? I’ll send you the details after.`;
      } else {
        reply = "Sorry I didn’t catch your name 😅";
      }
    }

    else if (leadData[contactId].stage === "ask_email") {
      if (leadData[contactId].email) {
        leadData[contactId].stage = "assist";
        reply = "Got it! 😊 What are you trying to improve or build?";
      } else {
        reply = "Could you share your email? 😊";
      }
    }

    else if (leadData[contactId].stage === "assist") {

      // Missing info check (human-like)
      if (!leadData[contactId].name) {
        reply = "By the way 😊 what’s your name?";
      }

      else if (!leadData[contactId].email) {
        reply = "Got it 👍 where should I send the details? (your email)";
      }

      else {
        reply = await safeAIReply(contactId);

        // Soft booking trigger
        if (/help|build|funnel|automation|marketing/i.test(userMessage)) {
          reply += "\n\nIf you want, I can walk you through it on a quick call 😊";
        }

        // Direct booking intent
        if (/call|schedule|book|available/i.test(userMessage)) {
          reply += `\n\nHere are available slots:\n${suggestDates()}\n\nJust tell me what works for you 😊`;
        }
      }
    }

  } catch (err) {
    console.log("❌ FLOW ERROR:", err);
  }

  // NOT AVAILABLE HANDLER
  if (userMessage.toLowerCase().includes("not available")) {
    reply = `No worries 😊 totally get it.

Here are a few other options:
${suggestDates()}

Let me know what works best 👍`;
  }

  // Suggest time if only date
  if (
    leadData[contactId].booking.date &&
    !leadData[contactId].booking.time
  ) {
    reply += `\n\nAvailable times:\n${suggestDates()}`;
  }

  // BOOKING (STRICT + SAFE)
  if (
    leadData[contactId].booking.date &&
    leadData[contactId].booking.time &&
    leadData[contactId].email &&
    leadData[contactId].name &&
    !leadData[contactId].booking.saved
  ) {
    leadData[contactId].booking.saved = true;

    // Ensure contact exists
    if (!leadData[contactId].ghlIdCreated) {
      const id = await createContact(leadData[contactId]);
      if (id) {
        leadData[contactId].ghlId = id;
        leadData[contactId].ghlIdCreated = true;
      }
    }

    await updateContact(leadData[contactId]);
    await createAppointment(leadData[contactId]);

    const formatted = formatDate(
      leadData[contactId].booking.date,
      leadData[contactId].booking.time
    );

    reply = `Perfect 😊 you're booked for ${formatted}. You'll receive a confirmation email shortly!`;
  }

  // Prevent loop reset
  if (reply.toLowerCase().includes("how are you")) {
    reply = "Got it 😊 tell me more about what you need help with.";
  }

  await sendMessage(contactId, reply);
  conversationHistory[contactId].push({ role: 'assistant', content: reply });

  processAsync(contactId);
});


// 🤖 AI
async function safeAIReply(contactId) {
  try {
    const history = conversationHistory[contactId];
    const lead = leadData[contactId];

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
            content: `
You are Lhyn, a friendly human assistant.

Goal: guide user to book a call.

Style:
- Natural
- Not pushy
- Helpful

Rules:
- Never reject
- Never restart conversation
- Ask questions naturally
`
          },
          ...history
        ]
      })
    });

    const data = await res.json();
    return data?.choices?.[0]?.message?.content || "Got it 😊";

  } catch {
    return "Got it 😊 let me help you.";
  }
}


// 📅 BOOK
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
      title: `Call with ${lead.name}`
    })
  });
}


// 🧠 HELPERS

function extractEmail(text) {
  const match = text.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  return match ? match[0] : null;
}

function extractName(text) {
  const patterns = [
    /my name is ([a-zA-Z]+)/i,
    /i am ([a-zA-Z]+)/i,
    /i'm ([a-zA-Z]+)/i
  ];

  for (let p of patterns) {
    const m = text.match(p);
    if (m) return m[1];
  }

  const words = text.trim().split(" ");
  if (words.length === 1 && words[0].length < 20) {
    return words[0];
  }

  return null;
}

function detectDate(text) {
  const today = new Date();
  text = text.toLowerCase();

  let d = new Date(today);

  if (text.includes("day after tomorrow")) d.setDate(d.getDate() + 2);
  else if (text.includes("tomorrow")) d.setDate(d.getDate() + 1);
  else return null;

  return d;
}

function buildDateTime(dateObj, timeStr) {
  const date = new Date(dateObj);

  let [hour, mod] = timeStr.toLowerCase().split(/(am|pm)/);
  hour = parseInt(hour.trim());

  if (mod === "pm" && hour !== 12) hour += 12;
  if (mod === "am" && hour === 12) hour = 0;

  date.setHours(hour, 0, 0);
  return date.toISOString();
}

function formatDate(date, time) {
  return new Date(date).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric"
  }) + ` at ${time}`;
}

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


// 🔥 GHL

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
  console.log("🔥 SALES + BOOKING CHATBOT LIVE");
});
