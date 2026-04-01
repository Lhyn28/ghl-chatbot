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
      booking: { slot: null, saved: false },
      ghlId: contactId
    };
  }

  const lead = leadData[contactId];

  // =============================
  // 🧠 NAME (LOCK)
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
    await createOrUpdateContact(lead);
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

      // =============================
      // 🤖 AI (SHORT + SALES)
      // =============================
      reply = await aiReply(message);

      // =============================
      // 📅 FETCH REAL SLOTS
      // =============================
      if (shouldSuggestBooking(message)) {
        const slots = await getAvailableSlots();

        if (slots.length) {
          reply += "\n\nAvailable times:\n" + slots.join("\n");
        }
      }

      // =============================
      // 📅 USER PICKED SLOT
      // =============================
      const chosen = matchSlot(message, lead.availableSlots);

      if (chosen && !lead.booking.saved) {
        lead.booking.saved = true;

        await createAppointment(lead, chosen);

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
// 🤖 AI (FREE MODEL)
// =============================
async function aiReply(message) {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization
