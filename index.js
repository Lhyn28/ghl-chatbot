import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

const GHL_API_KEY = process.env.GHL_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const conversationHistory = {};

app.post('/webhook/ghl-chat', async (req, res) => {

  console.log("🔥 WEBHOOK HIT:", JSON.stringify(req.body, null, 2));

  // ❗ IMPORTANT: use contact_id first
  const contactId = req.body.contact_id;

  const message = req.body.message;
  const contact_name = req.body.contact_name || req.body.full_name;

  res.sendStatus(200);

  if (!conversationHistory[contactId]) {
    conversationHistory[contactId] = [];
  }

  const userMessage = typeof message === "string"
    ? message
    : message?.body || "";

  if (userMessage && userMessage.trim() !== "") {

    conversationHistory[contactId].push({
      role: 'user',
      content: userMessage
    });

    const aiReply = await callOpenRouter(contactId, contact_name);

    conversationHistory[contactId].push({
      role: 'assistant',
      content: aiReply
    });

    // 🔥 GET REAL CONVERSATION ID
    const realConversationId = await getConversationId(contactId);

    console.log("✅ Real Conversation ID:", realConversationId);

    if (realConversationId) {
      await sendGHLMessage(realConversationId, aiReply);
    } else {
      console.log("❌ No conversation found");
    }
  }
});


// ✅ NEW FUNCTION (IMPORTANT)
async function getConversationId(contactId) {
  const response = await fetch(
    `https://services.leadconnectorhq.com/conversations/search?contactId=${contactId}`,
    {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-04-15'
      }
    }
  );

  const data = await response.json();

  console.log("🔍 Conversation Search:", JSON.stringify(data, null, 2));

  return data.conversations?.[0]?.id;
}


async function callOpenRouter(conversationId, contactName) {
  const history = conversationHistory[conversationId] || [];

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
          content: `You are a friendly and helpful support assistant.
The customer's name is ${contactName || 'there'}.

Your job:
- Greet them warmly
- Answer clearly
- Keep replies short (2–4 sentences)
- Ask helpful follow-up questions`
        },
        ...history.filter(msg => msg.content && msg.content.trim() !== "")
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


async function sendGHLMessage(conversationId, message) {

  console.log("📤 Sending message to GHL:", conversationId, message);

  await fetch('https://services.leadconnectorhq.com/conversations/messages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Content-Type': 'application/json',
      'Version': '2021-04-15'
    },
    body: JSON.stringify({
      type: 'Live_Chat',
      conversationId,
      message
    })
  });
}

app.listen(process.env.PORT || 3000, () => {
  console.log('AI chatbot server running 🔥');
});
