import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const GHL_API_KEY = process.env.GHL_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const CALENDAR_ID = process.env.CALENDAR_ID;

const conversationHistory = {};
const leadData = {};
const timers = {};

app.post('/webhook/ghl-chat', async (req, res) => {
  try {

    const contactId = req.body.contact_id;
    const message = req.body.message;

    res.sendStatus(200);
    if (!contactId) return;

    // RESET TIMERS
    if (timers[contactId]) {
      clearTimeout(timers[contactId].t1);
      clearTimeout(timers[contactId].t2);
    }

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

    // CAPTURE NAME
    if (!leadData[contactId].name) {
      const name = extractName(userMessage);
      if (name) leadData[contactId].name = name;
    }

    // CAPTURE EMAIL
    if (!leadData[contactId].email) {
      const email = extractEmail(userMessage);
      if (email) leadData[contactId].email = email;
    }

    // DATE
    const date = detectDate(userMessage);
    if (date) leadData[contactId].booking.date = date;

    // TIME
    const timeMatch = userMessage.match(/\d{1,2}\s?(am|pm)/i);
    if (timeMatch) leadData[contactId].booking.time = timeMatch[0];

    let reply = "Got it 😊";

    // FLOW
    if (leadData[contactId].stage === "ask_name") {
      reply = "Hey 😊 welcome! What’s your name?";
      leadData[contactId].stage = "get_name";
    }

    else if (leadData[contactId].stage === "get_name") {
      if (leadData[contactId].name) {
        leadData[contactId].stage = "ask_email";
        reply = `Nice to meet you, ${leadData[contactId].name} 😊 What’s your email?`;
      } else {
        reply = "Sorry I didn’t catch your name 😅";
      }
    }

    else if (leadData[contactId].stage === "ask_email") {
      if (leadData[contactId].email) {
        leadData[contactId].stage = "assist";
        reply = "Got it! 😊 What are you trying to build or improve?";
      } else {
        reply = "Where should I send the details? 😊";
      }
    }

    else {
      reply = await safeAIReply(contactId);

      if (/help|funnel|automation|marketing|build/i.test(userMessage)) {
        reply += "\n\nI can walk you through it on a quick call 😊";
      }

      if (/call|book|schedule|available/i.test(userMessage)) {
        const slots = await getAvailableSlots();

        if (slots) {
          reply += `\n\nHere are available slots:\n${slots.join("\n")}\n\nWhich works for you? 😊`;
        }
      }
    }

    // BOOKING
    if (
      leadData[contactId].booking.date &&
      leadData[contactId].booking.time &&
      leadData[contactId].email &&
      leadData[contactId].name &&
      !leadData[contactId].booking.saved
    ) {
      leadData[contactId].booking.saved = true;

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

      reply = `Perfect 😊 you're booked for ${formatted}. I’ll send confirmation to your email!`;
    }

    await sendMessage(contactId, reply);
    conversationHistory[contactId].push({ role: 'assistant', content: reply });

    processAsync(contactId);

    // FOLLOW UPS
    timers[contactId] = {
      t1: setTimeout(() => {
        sendMessage(contactId, "Hey 😊 just checking in — still interested?");
      }, 2 * 60 * 1000),

      t2: setTimeout(() => {
        sendMessage(contactId, "No worries 😊 I know you're busy. I’ll close this for now — feel free to message anytime!");
      }, 5 * 60 * 1000)
    };

  } catch (err) {
    console.log("❌ ERROR:", err);
  }
});


// 🔥 YOUR SALES BRAIN (MOST IMPORTANT PART)
function getBusinessContext() {
  return `
You are Lhyn’s personal sales assistant.

ABOUT LHYN:
- Funnel builder & automation specialist
- Helps businesses get more leads and sales
- Focuses on high-converting funnels and systems

SERVICES:
- Funnel building
- Automation setup
- Lead generation systems
- CRM workflows (GoHighLevel)

PRICING:
- Customized based on client needs
- Free consultation call offered

PERSONALITY:
- Friendly
- Natural
- Human
- Not robotic
- Not pushy

SALES BEHAVIOR:
- Ask questions to understand needs
- Recommend solutions naturally
- Guide toward booking a call
- Build trust first

IMPORTANT RULES:
- NEVER say “I don’t know”
- If unsure → guide toward a call
- Keep conversation flowing
- Sound like a real human assistant
`;
}


// AI
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
            content: getBusinessContext()
          },
          ...history
        ]
      })
    });

    const data = await res.json();
    return data?.choices?.[0]?.message?.content || "Let me help you 😊";

  } catch {
    return "Let me help you 😊";
  }
}


// CALENDAR
async function getAvailableSlots() {
  try {
    const res = await fetch(
      `https://services.leadconnectorhq.com/calendars/${CALENDAR_ID}/free-slots`,
      {
        headers: {
          Authorization: `Bearer ${GHL_API_KEY}`,
          Version: '2021-04-15'
        }
      }
    );

    const data = await res.json();
    if (!data?.slots) return null;

    return data.slots.slice(0, 3).map(slot => {
      const d = new Date(slot.startTime);
      return d.toLocaleString();
    });

  } catch {
    return null;
  }
}


// HELPERS
function extractEmail(text) {
  const match = text.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  return match ? match[0] : null;
}

function extractName(text) {
  text = text.replace(/[’‘]/g, "'");

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
  if (words.length === 1) return words[0];

  return null;
}

function detectDate(text) {
  const today = new Date();
  text = text.toLowerCase();

  let d = new Date(today);
  if (text.includes("tomorrow")) d.setDate(d.getDate() + 1);

  return d;
}

function buildDateTime(dateObj, timeStr) {
  const date = new Date(dateObj);
  let [hour, mod] = timeStr.toLowerCase().split(/(am|pm)/);
  hour = parseInt(hour.trim());
  if (mod === "pm") hour += 12;
  date.setHours(hour, 0, 0);
  return date.toISOString();
}

function formatDate(date, time) {
  return new Date(date).toLocaleDateString() + ` at ${time}`;
}


// GHL
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

async function processAsync(contactId) {
  const lead = leadData[contactId];
  if (lead.email && !lead.ghlIdCreated) {
    const id = await createContact(lead);
    if (id) lead.ghlId = id;
  }
}

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
  console.log("🔥 SALES ASSISTANT LIVE");
});
