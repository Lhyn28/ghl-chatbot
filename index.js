import express from 'express';
import fetch from 'node-fetch';
import chrono from 'chrono-node';

const app = express();
app.use(express.json());

const GHL_API_KEY = process.env.GHL_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const CALENDAR_ID = process.env.CALENDAR_ID;

const conversationHistory = {};
const leadData = {};
const lastMessageTime = {}; // Track last interaction

// 🕒 INACTIVE USER CHECK (runs every 5 minutes)
setInterval(() => {
  const now = Date.now();
  const INACTIVITY_THRESHOLD = 10 * 60 * 1000; // 10 minutes
  
  Object.keys(lastMessageTime).forEach(async (contactId) => {
    const timeSinceLastMessage = now - lastMessageTime[contactId];
    const lead = leadData[contactId];
    
    // If inactive for 10 minutes AND we haven't sent follow-up yet AND conversation started
    if (
      timeSinceLastMessage >= INACTIVITY_THRESHOLD &&
      lead &&
      !lead.followUpSent &&
      conversationHistory[contactId]?.length > 0
    ) {
      lead.followUpSent = true;
      
      const followUpMessage = lead.booking?.saved
        ? "Thanks for booking! If you have any questions before our call, feel free to message me anytime 😊"
        : "Hey! Just checking in. If you'd still like to chat or book a call, I'm here! Otherwise, feel free to reach out anytime you're ready 😊";
      
      await sendMessage(contactId, followUpMessage);
      conversationHistory[contactId].push({ role: 'assistant', content: followUpMessage });
      
      console.log(`📨 Sent follow-up to inactive user: ${contactId}`);
    }
  });
}, 5 * 60 * 1000); // Check every 5 minutes


app.post('/webhook/ghl-chat', async (req, res) => {
  const contactId = req.body.contact_id;
  const message = req.body.message;

  res.sendStatus(200);
  if (!contactId) return;

  // Update last message time
  lastMessageTime[contactId] = Date.now();

  // Initialize lead data
  if (!leadData[contactId]) {
    leadData[contactId] = {
      name: null,
      email: null,
      ghlId: contactId,
      booking: { date: null, time: null, saved: false },
      followUpSent: false
    };
    conversationHistory[contactId] = [];
  }

  const userMessage = typeof message === "string"
    ? message
    : message?.body || "";

  if (!userMessage) return;

  conversationHistory[contactId].push({ role: 'user', content: userMessage });

  // 🧠 EXTRACT NAME (smarter detection)
  const name = extractName(userMessage);
  if (name && !leadData[contactId].name) {
    leadData[contactId].name = name;
  }

  // 🧠 EMAIL DETECTION
  const emailMatch = userMessage.match(/[\w\.-]+@[\w\.-]+\.\w+/);
  if (emailMatch && !leadData[contactId].email) {
    leadData[contactId].email = emailMatch[0];
  }

  // 🧠 SMART DATE/TIME PARSING (CHRONO)
  const parsedDate = chrono.parseDate(userMessage);
  if (parsedDate) {
    leadData[contactId].booking.date = parsedDate;
    leadData[contactId].booking.time = parsedDate.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  }

  // 🤖 GENERATE REPLY
  const reply = await generateReply(contactId, userMessage);

  // 🔥 AUTO-BOOK IF WE HAVE EVERYTHING
  if (
    leadData[contactId].name &&
    leadData[contactId].email &&
    leadData[contactId].booking.date &&
    !leadData[contactId].booking.saved
  ) {
    leadData[contactId].booking.saved = true;

    // Create/update contact first
    await updateContact(contactId, leadData[contactId]);

    // Book the appointment
    await createAppointment(contactId, leadData[contactId]);

    // Send confirmation message with calendar link
    const formatted = formatDate(leadData[contactId].booking.date);
    const confirmMessage = `Perfect! 🎉 You're all set, ${leadData[contactId].name}.\n\nYour call is booked for ${formatted}.\n\nI've sent a confirmation email to ${leadData[contactId].email}.\n\nYou can also view/manage your booking here:\nhttps://app.lhynworks.com/widget/bookings/bookacallwithlhyn\n\nTalk soon!`;
    
    await sendMessage(contactId, confirmMessage);
    conversationHistory[contactId].push({ role: 'assistant', content: confirmMessage });
    
    return;
  }

  // Send regular reply
  await sendMessage(contactId, reply);
  conversationHistory[contactId].push({ role: 'assistant', content: reply });

  // Background sync
  processAsync(contactId);
});


// 🤖 HUMAN-LIKE AI RESPONSE
async function generateReply(contactId, userMessage) {
  const history = conversationHistory[contactId];
  const lead = leadData[contactId];

  // Build context about what we know
  let context = "";
  if (!lead.name) context += "\n- You don't know their name yet";
  if (!lead.email) context += "\n- You don't have their email yet";
  if (!lead.booking.date) context += "\n- No booking time set yet";

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'anthropic/claude-3.5-sonnet',
      messages: [
        {
          role: 'system',
          content: `You are Lhyn (Richelyn Tagod), a friendly Filipino Virtual Assistant specializing in GoHighLevel automation, web development (React/Next.js), and business systems.

YOUR EXPERTISE:
- GHL funnel building and automation
- Landing pages, websites, and web apps
- QR payment integrations (GCash, MariBank, GoTyme)
- Full system setups for US and international clients
- Learn more at: https://portfolio.lhynworks.com/

YOUR GOAL:
Book a discovery call. You need 3 things:
1. Their name
2. Their email
3. A date/time for the call

CONVERSATION STYLE:
- Sound like a real person texting, not a bot
- Use casual Filipino-English warmth ("Hey!", "Sounds good!", "Got it!")
- Ask for ONE thing at a time naturally
- Don't be pushy or salesy
- Keep responses SHORT (1-2 sentences max)
- Use emojis sparingly (😊 ✨)

WHAT YOU KNOW SO FAR:${context}

IF THEY ASK ABOUT YOUR SERVICES:
Briefly mention GHL automation, landing pages, or custom web apps, then guide back to booking: "I'd love to explain more on a quick call—what time works for you?"

NATURAL EXAMPLES:
- "Hey! What's your name?" (if you don't know it)
- "Perfect! What's your email so I can send the calendar invite?" (if you have name)
- "When's good for you? I'm free most days this week" (if you have name + email)

BOOKING LINK:
If they prefer to book themselves: https://app.lhynworks.com/widget/bookings/bookacallwithlhyn

DO NOT:
- Use formal language ("I appreciate your interest")
- Write long paragraphs
- Sound robotic or corporate
- List services unless asked`
        },
        ...history
      ]
    })
  });

  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "Got it 😊";
}


// 🔥 CREATE APPOINTMENT IN GHL
async function createAppointment(contactId, lead) {
  const startTime = lead.booking.date.toISOString();

  console.log("📅 BOOKING APPOINTMENT:", {
    contact: lead.name,
    email: lead.email,
    time: startTime
  });

  const response = await fetch('https://services.leadconnectorhq.com/calendars/events/appointments', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      'Content-Type': 'application/json',
      Version: '2021-04-15'
    },
    body: JSON.stringify({
      calendarId: CALENDAR_ID,
      contactId: contactId,
      startTime: startTime,
      title: `Discovery Call - ${lead.name || "Client"}`,
      appointmentStatus: "confirmed"
    })
  });

  const result = await response.json();
  console.log("📅 Appointment created:", result);
  
  return result;
}


// 🧠 FORMAT DATE FOR DISPLAY
function formatDate(date) {
  return new Date(date).toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Manila" // PH timezone
  });
}


// 🧠 EXTRACT NAME FROM MESSAGE
function extractName(text) {
  const clean = text.trim();

  // Ignore if it's an email
  if (clean.includes("@")) return null;

  // Ignore common non-name responses
  const ignore = ["yes", "no", "ok", "sure", "hi", "hello", "hey"];
  if (ignore.includes(clean.toLowerCase())) return null;

  // Match patterns like "I'm John", "My name is John", "It's John"
  const patterns = [
    /(?:my name is|i'm|i am|it's|this is)\s+([a-z]+)/i,
    /^([A-Z][a-z]+)$/  // Single capitalized word
  ];

  for (let pattern of patterns) {
    const match = clean.match(pattern);
    if (match) return match[1];
  }

  // If it's a single word and looks like a name
  const words = clean.split(" ");
  if (words.length === 1 && words[0].length > 1) {
    return words[0];
  }

  return null;
}


// 🔥 BACKGROUND CONTACT SYNC
async function processAsync(contactId) {
  const lead = leadData[contactId];

  if (lead.name || lead.email) {
    await updateContact(contactId, lead);
  }
}


// 🔥 UPDATE CONTACT IN GHL
async function updateContact(contactId, lead) {
  const payload = {};
  
  if (lead.name) {
    // Split name into first/last if possible
    const parts = lead.name.split(" ");
    payload.firstName = parts[0];
    if (parts.length > 1) {
      payload.lastName = parts.slice(1).join(" ");
    }
  }
  
  if (lead.email) {
    payload.email = lead.email;
  }

  if (Object.keys(payload).length === 0) return;

  console.log("📝 Updating contact:", contactId, payload);

  const response = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      'Content-Type': 'application/json',
      Version: '2021-04-15'
    },
    body: JSON.stringify(payload)
  });

  const result = await response.json();
  console.log("✅ Contact updated:", result);
}


// 📤 SEND MESSAGE VIA GHL
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
  console.log("🔥 HUMAN-LIKE BOOKING BOT LIVE");
  console.log("📍 Webhook endpoint: /webhook/ghl-chat");
});
