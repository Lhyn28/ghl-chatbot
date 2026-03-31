import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

const GHL_API_KEY = process.env.GHL_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const conversationHistory = {};

app.post('/webhook/ghl-chat', async (req, res) => {

  console.log("🔥 WEBHOOK HIT:", JSON.stringify(req.body, null, 2));

  // ✅ Extract conversation ID safely
  let conversation_id =
    req.body.conversation_id ||
    req.body.conversationId ||
    req.body.customData?.conversation_id;

  // 🔥 FIX: handle object case
  if (typeof conversation_id === "object") {
    conversation_id = conversation_id.id || conversation_id._id || "";
  }

  // ❌ Catch invalid values
  if (!conversation_id || conversation_id === "[object Object]") {
    console.log("❌ Invalid conversation_id:", conversation_id);
    return res.sendStatus(200);
  }

  const message = req.body.message;
  const contact_name = req.body.contact_name || req.body.full_name;

  res.sendStatus(200);

  if (!conversationHistory[conversation_id]) {
    conversationHistory[conversation_id] = [];
  }

  // ✅ Safe message extraction
  const userMessage = typeof message === "string"
    ? message
    : message?.body || "";

  if (!userMessage || userMessage.trim() === "") {
    console.log("❌ Empty message");
    return;
  }

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
});


// ✅ OpenRouter call
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


// ✅ Send message to GHL
async function sendGHLMessage(conversationId, message) {

  console.log("📤 Sending message to GHL:", conversationId, message);

  try {
    const response = await fetch('https://services.leadconnectorhq.com/conversations/messages', {
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

    const result = await response.json();
    console.log("✅ GHL RESPONSE:", result);

  } catch (err) {
    console.log("❌ GHL SEND ERROR:", err);
  }
}


app.listen(process.env.PORT || 3000, () => {
  console.log('AI chatbot server running 🔥');
});
