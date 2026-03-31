import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

const GHL_API_KEY = process.env.GHL_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const CALENDAR_ID = process.env.CALENDAR_ID;

// =============================
// 🧠 MEMORY
// =============================
const leadData = {};
const history = {};

// =============================
// 🌐 WEBSITE KNOWLEDGE (EDIT THIS)
// =============================
const WEBSITE_CONTEXT = `
Lhyn provides:
- Funnel building
- Automation systems
- Lead generation solutions

Pricing:
- Basic funnels: around $300+
- Automation systems: $500–$1500+

Goal:
Help businesses generate leads and automate processes efficiently.
`;

// =============================
// 🚀 MAIN WEBHOOK
// =============================
app.post('/webhook/ghl-chat', async (req, res) => {
  res.sendStatus(200);

  const contactId = req.body.contact_id;
  const message = req.body.message?.body || req.body.message;

  if (!contactId || !message) return;

  console.log("📩 USER:", message);

  if (!leadData[contactId]) {
    leadData[contactId] = {
      name: null,
      email: null,
      stage: "ask_name",
      booking: { date: null, time: null, saved: false }
    };
    history[contactId] = [];
  }

  const lead = leadData[contactId];

  // =============================
  // 🧠 CAPTURE NAME (LOCKED)
  // =============================
  if (!lead.name) {
    const name = extractName(message);
    if (name) {
      lead.name = name;
      console.log("✅ Name saved:", name);
    }
  }

  // =============================
  // 🧠 CAPTURE EMAIL (LOCKED)
  // =============================
  if (!lead.email && message.includes("@")) {
    lead.email = message.trim();
    console.log("✅ Email saved:", lead.email);
  }

  // =============================
  // 🧠 CAPTURE DATE
  // =============================
  const date = detectDate(message);
  if (date) {
    lead.booking.date = date;
    console.log("📅 Date:", date);
  }

  // =============================
  // 🧠 CAPTURE TIME
  // =============================
  const timeMatch = message.match(/\d{1,2}\s?(am|pm)/i);
  if (timeMatch) {
    lead.booking.time = timeMatch[0];
    console.log("⏰ Time:", lead.booking.time);
  }

  let reply = "Got it 😊";

  try {

    // =============================
    // 🎯 CONTROLLED SALES FLOW
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
        reply = "Perfect 😊 What are you currently trying to improve?";
        lead.stage = "assist";
      } else {
        reply = "Could you share your email? 😊";
      }
    }

    else {
      reply = await aiReply(message);

      reply += "\n\nIf you want, we can go through this properly on a quick call 😊";
    }

  } catch (err) {
    console.log("❌ ERROR:", err);
    reply = "Sorry 😅 something went wrong. Can you try again?";
  }

  // =============================
  // 🔥 HANDLE NOT AVAILABLE
  // =============================
  if (message.toLowerCase().includes("not available")) {
    reply = `No problem 😊 Here are other available times:\n${suggestDates()}`;
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

    await createAppointment(contactId, lead);
    await updateContact(contactId, lead);

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
// 🤖 AI SALES RESPONSE
// =============================
async function aiReply(message) {
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
            content: `
You are Lhyn, a confident sales assistant.

RULES:
- Be helpful and human
- Suggest solutions
- Give pricing when asked
- NEVER decline a client
- ALWAYS guide toward booking

KNOWLEDGE:
${WEBSITE_CONTEXT}
`
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
// 🔥 BOOK APPOINTMENT
// =============================
async function createAppointment(contactId, lead) {
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
      contactId,
      startTime: iso,
      title: `Call with ${lead.name || "Client"}`
    })
  });
}


// =============================
// 🔥 UPDATE CONTACT
// =============================
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


// =============================
app.listen(3000, () => {
  console.log("🔥 SALES + BOOKING AI READY");
});
