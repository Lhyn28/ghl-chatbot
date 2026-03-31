import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

const GHL_API_KEY = process.env.GHL_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const CALENDAR_LINK = "https://app.lhynworks.com/widget/bookings/bookacallwithlhyn";

// 🧠 Memory
const conversationHistory = {};
const leadData = {};

app.post('/webhook/ghl-chat', async (req, res) => {

  console.log("🔥 WEBHOOK HIT:", JSON.stringify(req.body, null, 2));

  const contactId = req.body.contact_id;
  const message = req.body.message;

  res.sendStatus(200);

  if (!contactId) return;

  if (!conversationHistory[contactId]) {
    conversationHistory[contactId] = [];
    leadData[contactId] = {
      name: null,
      email: null
    };
  }

  const userMessage = typeof message === "string"
    ? message
    : message?.body || "";

  if (!userMessage || userMessage.trim() === "") return;

  // 🔥 Detect name
  if (!leadData[contactId].name && userMessage.length < 30 && !userMessage.includes("@")) {
    leadData[contactId].name = userMessage;
  }

  // 🔥 Detect email
  if (!leadData[contactId].email && userMessage.includes("@")) {
    leadData[contactId].email = userMessage;
    await updateContact(contactId, leadData[contactId]);
  }

  conversationHistory[contactId].push({
    role: 'user',
    content: userMessage
  });

  const aiReply = await callOpenRouter(contactId, leadData[contactId]);

  conversationHistory[contactId].push({
    role: 'assistant',
    content: aiReply
  });

  await sendGHLMessage(contactId, aiReply);
});


// 🤖 AI
async function callOpenRouter(contactId, lead) {
  const history = conversationHistory[contactId] || [];

  const hour = new Date().getHours();
  let greeting = "Hello";

  if (hour < 12) greeting = "Good morning 😊";
  else if (hour < 18) greeting = "Good afternoon 😊";
  else greeting = "Good evening 😊";

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'openai/gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: `${greeting}

You are a friendly, human-like assistant for Lhyn Works.

PERSONALITY:
- Warm, polite, natural
- Sounds like a real person
- Never robotic

---

FLOW:

1. If name missing:
"How are you today? May I know your name so I can assist you better?"

2. If name exists but email missing:
"Nice to meet you, ${lead.name}! May I also get your email in case we need to send details?"

3. Then:
"What can I help you with today?"

4. Ask naturally:
- Business type
- Goal
- Timeline

---

BOOKING (VERY IMPORTANT):

When user shows interest OR asks about services:

Say naturally:

"I can definitely help you with that 😊 If you'd like, we can hop on a quick call so I can understand your needs better."

Then continue:

"Here’s my calendar link: ${CALENDAR_LINK}"

---

KNOWLEDGE:

Lhyn Works helps with:
- Funnel building
- Automation
- AI chatbot setup
- Lead generation

Website:
https://portfolio.lhynworks.com/

---

MEMORY RULE:
- Use name occasionally (not always)
- Example:
"Got it, ${lead.name}"

---

STYLE:
- Short replies (2–3 sentences)
- Friendly
- Not pushy
`
        },
        ...history
      ]
    })
  });

  const data = await response.json();

  console.log("OPENROUTER RESPONSE:", JSON.stringify(data, null, 2));

  if (!data.choices || !data.choices[0]) {
    return "Sorry, something went wrong. Please try again.";
  }

  return data.choices[0].message.content;
}


// 💾 SAVE CONTACT
async function updateContact(contactId, lead) {
  try {
    await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: lead.name,
        email: lead.email
      })
    });

    console.log("✅ Contact saved");

  } catch (err) {
    console.log("❌ Contact save error:", err);
  }
}


// 📤 SEND MESSAGE
async function sendGHLMessage(contactId, message) {
  try {
    await fetch('https://services.leadconnectorhq.com/conversations/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Content-Type': 'application/json',
        'Version': '2021-04-15'
      },
      body: JSON.stringify({
        type: 'Live_Chat',
        contactId,
        message
      })
    });

  } catch (err) {
    console.log("❌ Send error:", err);
  }
}


app.listen(process.env.PORT || 3000, () => {
  console.log('🔥 AI Sales Chatbot LIVE');
});
