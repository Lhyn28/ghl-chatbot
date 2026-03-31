import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

const GHL_API_KEY = process.env.GHL_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const conversationHistory = {};

app.post('/webhook/ghl-chat', async (req, res) => {
  const { conversation_id, message, contact_name } = req.body;
  res.sendStatus(200);

  if (!conversationHistory[conversation_id]) {
    conversationHistory[conversation_id] = [];
  }

  conversationHistory[conversation_id].push({
    role: 'user',
    content: message
  });

  const aiReply = await callOpenRouter(conversation_id, contact_name);

  conversationHistory[conversation_id].push({
    role: 'assistant',
    content: aiReply
  });

  await sendGHLMessage(conversation_id, aiReply);
});

async function callOpenRouter(conversationId, contactName) {
  const history = conversationHistory[conversationId];

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'meta-llama/llama-3.1-8b-instruct:free',
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
        ...history
      ]
    })
  });

  const data = await response.json();

  // 🔥 DEBUG LOG (IMPORTANT)
  console.log("OPENROUTER RESPONSE:", JSON.stringify(data, null, 2));

  // ✅ SAFE CHECK (prevents crash)
  if (!data.choices || !data.choices[0]) {
    return "Sorry, something went wrong. Please try again.";
  }

  return data.choices[0].message.content;
}

async function sendGHLMessage(conversationId, message) {
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
