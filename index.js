import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

const GHL_API_KEY = process.env.GHL_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const conversationHistory = {};

app.post('/webhook/ghl-chat', async (req, res) => {

  // 🔥 DEBUG incoming data
  console.log("🔥 WEBHOOK HIT:", JSON.stringify(req.body, null, 2));

  // ✅ FIX: Properly extract conversation_id
  const conversation_id =
    req.body.conversation_id ||
    req.body.workflow?.conversation_id ||
    req.body.contact_id;

  const message = req.body.message;
  const contact_name = req.body.contact_name || req.body.full_name;

  res.sendStatus(200);

  if (!conversationHistory[conversation_id]) {
    conversationHistory[conversation_id] = [];
  }

  // ✅ FIX: Handle message safely
  const userMessage = typeof message === "string"
    ? message
    : message?.body || "";

  if (userMessage && userMessage.trim() !== "") {

    conversationHistory[conversation_id].push({
      role: 'user',
      content: userMessage
    });

    const aiReply = await callOpenRouter(conversation_id, contact_name);

    conversationHistory[conversation_id].push({
      role: 'assistant',
      content: aiReply
    });

    await sendGHLMessage(conversation_id, aiReply);
  }
});

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
