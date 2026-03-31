async function sendGHLMessage(contactId, message) {

  console.log("📤 Sending message using contactId:", contactId, message);

  try {
    const response = await fetch('https://services.leadconnectorhq.com/contacts/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contactId: contactId,
        message: message,
        type: "Live_Chat"
      })
    });

    const result = await response.json();
    console.log("✅ GHL RESPONSE:", result);

  } catch (err) {
    console.log("❌ GHL SEND ERROR:", err);
  }
}
