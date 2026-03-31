import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

const GHL_API_KEY = process.env.GHL_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const CALENDAR_ID = process.env.CALENDAR_ID;

const leadData = {};

// =============================
// 🚀 WEBHOOK
// =============================
app.post('/webhook/ghl-chat', async (req, res) => {
  res.sendStatus(200);

  const contactId = req.body.contact_id;

  let message = "";
  if (typeof req.body.message === "string") {
    message = req.body.message;
  } else if (req.body.message?.body) {
    message = req.body.message.body;
  }

  if (!contactId || !message) return;

  if (!leadData[contactId]) {
    leadData[contactId] = {
      name: null,
      email: null,
      stage: "ask_name",
      booking: { date: null, time: null, saved: false },
      ghlId: contactId
    };
  }

  const lead = leadData[contactId];

  // =============================
  // 🧠 NAME (FIXED)
  // =============================
  if (!lead.name) {
    const name = extractName(message);
    if (name) lead.name = name;
  }

  // =============================
  // 🧠 EMAIL
  // =============================
  if (!lead.email && message.includes("@")) {
    lead.email = message.trim();
  }

  // =============================
  // 🧠 DATE
  // =============================
  const date = detectDate(message);
  if (date) lead.booking.date = date;

  // =============================
  // 🧠 TIME
  // =============================
  const timeMatch = message.match(/\d{1,2}\s?(am|pm)/i);
  if (timeMatch) lead.booking.time = timeMatch[0];

  let reply = "Got it 😊";

  try {

    // =============================
    // 🎯 FLOW
    // =============================
    if (lead.stage === "ask_name") {
      reply = "Hi 😊 how are you today? May I know your name?";
      lead.stage = "get_name";
    }

    else if (lead.stage === "get_name") {
      if (lead.name) {
        reply = `Nice to meet you, ${lead.name} 😊 What's your email?`;
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

      // 🔥 SALES PUSH
      const triggers = ["price","cost","interested","help","service","need","want"];
      if (triggers.some(w => message.toLowerCase().includes(w))) {
        reply += `\n\nWe can go over this quickly on a call.\nAvailable times:\n${suggestDates()}`;
      }
    }

  } catch (err) {
    reply = "Sorry 😅 something went wrong. Try again?";
  }

  // =============================
  // 🔥 NOT AVAILABLE HANDLER
  // =============================
  if (message.toLowerCase().includes("not available")) {
    reply = `No problem 😊 Here are other times:\n${suggestDates()}`;
  }

  // =============================
  // 🔥 SUGGEST IF DATE ONLY
  // =============================
  if (lead.booking.date && !lead.booking.time) {
    reply += `\n\nAvailable times:\n${suggestDates()}`;
  }

  // =============================
  // 🔥 BOOKING
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

    reply = `You're all set ${lead.name || ""} 😊
📅 ${formatted}

Check your email for confirmation.`;
  }

  // =============================
  // ✂️ LIMIT LENGTH
  // =============================
  if (reply.length > 200) {
    reply = reply.slice(0, 200) + "...";
  }

  await sendMessage(contactId, reply);
});


// =============================
// 🤖 AI (SHORT + SALES)
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
            content: `
You are Lhyn, a sales assistant.

Rules:
- Keep replies VERY SHORT (1-2 sentences)
- Be helpful and confident
- Guide toward booking
- No long explanations
`
          },
          { role: 'user', content: message }
        ]
      })
    });

    const data = await res.json();
    return data?.choices?.[0]?.message?.content || "Got it 😊";

  } catch {
    return "Got it 😊";
  }
}


// =============================
// 🔥 CONTACT
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
  } catch {}
}


// =============================
// 🔥 BOOK APPOINTMENT
// =============================
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


// =============================
// 🧠 HELPERS
// =============================
function extractName(text) {
  const clean = text.toLowerCase().trim();

  const invalid = ["hi","hello","hey","ok","yes","no"];
  if (invalid.includes(clean)) return null;

  if (!clean.includes("@") && clean.split(" ").length === 1) {
    return capitalize(clean);
  }

  const match = text.match(/i am (.+)|i'm (.+)|my name is (.+)/i);
  if (match) {
    return capitalize((match[1] || match[2] || match[3]).split(" ")[0]);
  }

  return null;
}

function capitalize(n) {
  return n.charAt(0).toUpperCase() + n.slice(1);
}

function detectDate(text) {
  const d = new Date();
  text = text.toLowerCase();

  if (text.includes("day after tomorrow")) d.setDate(d.getDate()+2);
  else if (text.includes("tomorrow")) d.setDate(d.getDate()+1);
  else return null;

  return d;
}

function buildDateTime(date, time) {
  const d = new Date(date);

  let [hour, mod] = time.toLowerCase().split(/(am|pm)/);
  hour = parseInt(hour);

  if (mod === "pm" && hour !== 12) hour += 12;
  if (mod === "am" && hour === 12) hour = 0;

  d.setHours(hour,0,0);
  return d.toISOString();
}

function formatDate(date, time) {
  return new Date(date).toLocaleDateString("en-US", {
    weekday:"long", month:"long", day:"numeric"
  }) + ` at ${time}`;
}

function suggestDates() {
  const today = new Date();
  let out = [];

  for (let i=1;i<=3;i++) {
    let d = new Date(today);
    d.setDate(d.getDate()+i);

    out.push(
      d.toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"}) + " at 2pm"
    );
  }

  return out.join("\n");
}


// =============================
// 📤 SEND
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
  } catch {}
}


// =============================
app.listen(process.env.PORT || 3000, () => {
  console.log("🔥 FINAL SALES BOT READY");
});
