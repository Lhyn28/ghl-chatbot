import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

const GHL_API_KEY = process.env.GHL_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const CALENDAR_ID = process.env.CALENDAR_ID;

const leadData = {};
const history = {};

// =============================
// 🚀 WEBHOOK
// =============================
app.post('/webhook/ghl-chat', async (req, res) => {
  res.sendStatus(200);

  console.log("🔥 BODY:", JSON.stringify(req.body));

  const contactId = req.body.contact_id;

  let message = "";
  if (typeof req.body.message === "string") {
    message = req.body.message;
  } else if (req.body.message?.body) {
    message = req.body.message.body;
  }

  if (!contactId || !message) {
    console.log("❌ Missing data");
    return;
  }

  console.log("📩 USER:", message);

  // =============================
  // 🧠 INIT USER
  // =============================
  if (!leadData[contactId]) {
    leadData[contactId] = {
      name: null,
      email: null,
      stage: "ask_name",
      booking: { date: null, time: null, saved: false },
      ghlId: contactId
    };
    history[contactId] = [];
  }

  const lead = leadData[contactId];

  // =============================
  // 🧠 CAPTURE NAME (LOCKED)
  // =============================
  if (!lead.name) {
    const name = extractName(message);
    if (name) lead.name = name;
  }

  // =============================
  // 🧠 CAPTURE EMAIL
  // =============================
  if (!lead.email && message.includes("@")) {
    lead.email = message.trim();
  }

  // =============================
  // 🧠 CAPTURE DATE
  // =============================
  const date = detectDate(message);
  if (date) lead.booking.date = date;

  // =============================
  // 🧠 CAPTURE TIME
  // =============================
  const timeMatch = message.match(/\d{1,2}\s?(am|pm)/i);
  if (timeMatch) lead.booking.time = timeMatch[0];

  let reply = "Got it 😊";

  try {

    // =============================
    // 🎯 STRICT FLOW
    // =============================

    if (lead.stage === "ask_name") {
      reply = "Hi 😊 how are you today? May I know your name?";
      lead.stage = "get_name";
    }

    else if (lead.stage === "get_name") {
      if (lead.name) {
        reply = `Nice to meet you, ${lead.name} 😊 What's your email so I can send details?`;
        lead.stage = "get_email";
      } else {
        reply = "Sorry I didn’t catch your name 😊";
      }
    }

    else if (lead.stage === "get_email") {
      if (lead.email) {
        reply = "Perfect 😊 What are you trying to improve?";
        lead.stage = "assist";

        await createOrUpdateContact(lead);
      } else {
        reply = "Could you share your email? 😊";
      }
    }

    else {
      reply = await safeAI(message);
      reply += "\n\nIf you want, we can go through this properly on a quick call 😊";
    }

  } catch (err) {
    console.log("❌ FLOW ERROR:", err);
    reply = "Sorry 😅 something went wrong. Can you try again?";
  }

  // =============================
  // 🔥 HANDLE NOT AVAILABLE
  // =============================
  if (message.toLowerCase().includes("not available")) {
    reply = `No problem 😊 Here are other times:\n${suggestDates()}`;
  }

  // =============================
  // 🔥 SUGGEST TIMES
  // =============================
  if (lead.booking.date && !lead.booking.time) {
    reply += `\n\nAvailable times:\n${suggestDates()}`;
  }

  // =============================
  // 🔥 FINAL BOOKING
  // =============================
  if (
    lead.booking.date &&
    lead.booking.time &&
    lead.email &&
    !lead.booking.saved
  ) {
    lead.booking.saved = true;

    await createAppointment(lead);

    const formatted = formatDate(lead.booking.date, lead.booking.time);

    reply = `Perfect ${lead.name || ""} 😊 you're booked for ${formatted}. 

You'll receive a confirmation email shortly.`;
  }

  // =============================
  // 📤 SEND MESSAGE
  // =============================
  await sendMessage(contactId, reply);

  console.log("🤖 BOT:", reply);
});


// =============================
// 🤖 SAFE AI (NEVER FAIL)
// =============================
async function safeAI(message) {
  try {
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
            content: `You are a confident sales assistant.
- Answer clearly
- Suggest solutions
- Guide toward booking`
          },
          { role: 'user', content: message }
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


// =============================
// 🔥 CREATE / UPDATE CONTACT
// =============================
async function createOrUpdateContact(lead) {
  try {
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
    if (data.contact?.id) {
      lead.ghlId = data.contact.id;
    }
  } catch (err) {
    console.log("❌ CONTACT ERROR:", err);
  }
}


// =============================
// 🔥 CREATE APPOINTMENT (REAL)
// =============================
async function createAppointment(lead) {
  const iso = buildDateTime(lead.booking.date, lead.booking.time);

  console.log("📅 BOOKING:", iso);

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


// =============================
// 🧠 HELPERS
// =============================
function extractName(text) {
  if (text.split(" ").length === 1) return text;

  const match = text.match(/i am (.+)|i'm (.+)|my name is (.+)/i);
  return match ? match[1] || match[2] || match[3] : null;
}

function detectDate(text) {
  const d = new Date();
  text = text.toLowerCase();

  if (text.includes("day after tomorrow")) d.setDate(d.getDate() + 2);
  else if (text.includes("tomorrow")) d.setDate(d.getDate() + 1);
  else return null;

  return d;
}

function buildDateTime(date, time) {
  const d = new Date(date);

  let [hour, mod] = time.toLowerCase().split(/(am|pm)/);
  hour = parseInt(hour);

  if (mod === "pm" && hour !== 12) hour += 12;
  if (mod === "am" && hour === 12) hour = 0;

  d.setHours(hour, 0, 0);
  return d.toISOString();
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


// =============================
// 📤 SEND MESSAGE
// =============================
async function sendMessage(contactId, message) {
  try {
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
  } catch (err) {
    console.log("❌ SEND ERROR:", err);
  }
}


// =============================
app.listen(process.env.PORT || 3000, () => {
  console.log("🔥 FINAL SALES + BOOKING AI READY");
});
