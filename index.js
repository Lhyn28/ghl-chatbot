import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

const GHL_API_KEY = process.env.GHL_API_KEY;
const CALENDAR_ID = process.env.CALENDAR_ID;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const leadData = {};

// =============================
// 🚀 WEBHOOK
// =============================
app.post('/webhook/ghl-chat', async (req, res) => {
  res.sendStatus(200);

  const contactId = req.body.contact_id;

  let message = typeof req.body.message === "string"
    ? req.body.message
    : req.body.message?.body || "";

  if (!contactId || !message) return;

  if (!leadData[contactId]) {
    leadData[contactId] = {
      name: null,
      email: null,
      stage: "ask_name",
      availableSlots: [],
      booking: { saved: false }
    };
  }

  const lead = leadData[contactId];

  // =============================
  // 🧠 NAME
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
    await updateContact(contactId, lead);
  }

  let reply = "Got it 😊";

  try {

    // =============================
    // 🎯 FLOW
    // =============================
    if (lead.stage === "ask_name") {
      reply = "Hi 😊 how are you? May I know your name?";
      lead.stage = "get_name";
    }

    else if (lead.stage === "get_name") {
      if (lead.name) {
        reply = `Nice to meet you, ${lead.name} 😊 What's your email?`;
        lead.stage = "get_email";
      } else {
        reply = "May I get your name? 😊";
      }
    }

    else if (lead.stage === "get_email") {
      if (lead.email) {
        reply = "Perfect 😊 What do you need help with?";
        lead.stage = "assist";
      } else {
        reply = "Please share your email 😊";
      }
    }

    else {

      // 🤖 AI
      reply = await aiReply(message);

      // 🔥 FETCH REAL SLOTS
      if (shouldSuggestBooking(message)) {
        const slots = await getAvailableSlots();

        lead.availableSlots = slots;

        if (slots.length) {
          reply += "\n\nAvailable times:\n" + slots.join("\n");
        } else {
          reply += "\n\nLet me check availability for you.";
        }
      }

      // 🔥 MATCH SLOT
      const chosen = matchSlot(message, lead.availableSlots);

      if (chosen && !lead.booking.saved) {
        lead.booking.saved = true;

        await createAppointment(contactId, chosen);

        reply = `You're booked ${lead.name} 😊\n📅 ${chosen}`;
      }
    }

  } catch (e) {
    console.log("❌ ERROR:", e);
    reply = "Sorry 😅 something went wrong.";
  }

  await sendMessage(contactId, reply);
});


// =============================
// 🤖 FREE AI
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
        model: "openrouter/auto",
        messages: [
          {
            role: "system",
            content: "Short, helpful, sales-focused replies."
          },
          { role: "user", content: message }
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
// 📅 GET REAL SLOTS
// =============================
async function getAvailableSlots() {
  try {

    const start = new Date();
    const end = new Date();
    end.setDate(end.getDate() + 3);

    const res = await fetch(
      `https://services.leadconnectorhq.com/calendars/${CALENDAR_ID}/free-slots?startTime=${start.toISOString()}&endTime=${end.toISOString()}`,
      {
        headers: {
          Authorization: `Bearer ${GHL_API_KEY}`,
          Version: "2021-04-15"
        }
      }
    );

    const data = await res.json();

    if (!data?.slots) return [];

    return data.slots.slice(0, 5).map(slot =>
      new Date(slot).toLocaleString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      })
    );

  } catch (e) {
    console.log("Slots error", e);
    return [];
  }
}


// =============================
// 📅 BOOK REAL SLOT
// =============================
async function createAppointment(contactId, slot) {
  const date = new Date(slot);

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
      startTime: date.toISOString(),
      title: "Consultation Call"
    })
  });
}


// =============================
// 📇 CONTACT
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
function matchSlot(message, slots = []) {
  return slots.find(s => message.includes(s));
}

function shouldSuggestBooking(message) {
  return ["price","cost","interested","book","call","help"].some(w =>
    message.toLowerCase().includes(w)
  );
}

function extractName(text) {
  const clean = text.toLowerCase().trim();
  if (["hi","hello","hey"].includes(clean)) return null;

  if (clean.split(" ").length === 1) return clean;

  const m = text.match(/i am (.+)|i'm (.+)/i);
  return m ? m[1] || m[2] : null;
}


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


app.listen(3000, () => console.log("🔥 REAL CALENDAR LIVE"));
