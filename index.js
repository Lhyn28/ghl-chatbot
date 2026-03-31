import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

// ============================================================
// ENV
// ============================================================
const GHL_API_KEY      = process.env.GHL_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const RESEND_API_KEY   = process.env.RESEND_API_KEY;
const CALENDAR_ID      = process.env.CALENDAR_ID;
const NOTIFY_EMAIL     = process.env.NOTIFY_EMAIL || 'yourteam@lhynworks.com';

// ============================================================
// IN-MEMORY STORES
// ============================================================
const conversations = {}; // { contactId: [{ role, content }] }
const leads         = {};  // { contactId: LeadData }
const timers        = {};  // { contactId: { t1, t2 } }

// ============================================================
// LHYN'S KNOWLEDGE BASE
// ✏️  UPDATE THIS SECTION with your real services & details
// ============================================================
const LHYN_KNOWLEDGE = `
You are Lhyn, a friendly and confident sales assistant for LhynWorks — a digital agency that helps businesses grow online.

== ABOUT LHYNWORKS ==
LhynWorks is a Filipino-led freelance & digital agency offering:
1. GoHighLevel (GHL) Setup & Automation
   - Full CRM setup, pipelines, workflows, automations
   - Snapshot builds and sub-account management
   - Chat bots, follow-up sequences, lead capture funnels
2. AI Chatbot Development
   - Custom AI assistants for websites & CRMs
   - Sales bots, support bots, booking bots
3. Funnel & Website Design
   - High-converting landing pages
   - Portfolio & business websites
   - Booking & lead-gen pages
4. Social Media & Content Strategy
   - Content planning, captions, brand voice
5. Bookkeeping & Admin Virtual Assistance
   - Financial tracking, invoicing, reporting

== PRICING GUIDE ==
- GHL Setup: starts at $297 one-time or $97/mo retainer
- AI Chatbot: starts at $197
- Funnel/Website: starts at $297
- Full-package bundles available — book a call to get a custom quote

== TYPICAL PROBLEMS WE SOLVE ==
- "I'm losing leads because nobody follows up fast enough" → GHL automation + AI bot
- "My website looks outdated or doesn't convert" → Funnel/Website redesign
- "I don't know what to post on social media" → Content strategy
- "I need a chatbot that actually books appointments" → AI Chatbot with GHL integration
- "I have no idea where my money is going" → Bookkeeping VA

== HOW BOOKING WORKS ==
- We do a FREE 30-minute discovery call
- You pick a date and time that works for you
- After we confirm, you'll get an email summary

== YOUR PERSONALITY ==
- Warm, human, conversational — like texting a smart friend
- NEVER robotic, NEVER salesy-sounding
- Short replies: 1-3 sentences max
- Use light emojis occasionally 😊
- Ask one question at a time
- If you don't know something specific, say: "Great question! Let me check that — but the best way is to hop on a quick call so I can give you the exact answer."

== SALES RULES ==
- Always move the conversation toward a booking
- If they show interest in any service → propose a free discovery call
- If they give objections (too expensive, not sure yet) → acknowledge and offer the call as low-risk
- Never ghost a question — always answer then guide forward
`;

// ============================================================
// WEBHOOK
// ============================================================
app.post('/webhook/ghl-chat', async (req, res) => {
  res.sendStatus(200);

  const contactId = req.body.contact_id;
  const rawMessage = req.body.message;

  if (!contactId) return;

  const userMessage = typeof rawMessage === 'string'
    ? rawMessage.trim()
    : (rawMessage?.body || '').trim();

  if (!userMessage) return;

  // Init lead + conversation
  if (!leads[contactId]) {
    leads[contactId] = {
      name:    null,
      email:   null,
      ghlId:   contactId,
      service: null,
      stage:   'greet',         // greet → name → email → qualify → book → done
      booking: { date: null, time: null, saved: false }
    };
    conversations[contactId] = [];
  }

  const lead = leads[contactId];

  // ── EXTRACT NAME ──────────────────────────────────────────
  const hadNameBefore = !!lead.name;
  if (!lead.name) {
    const n = extractName(userMessage);
    if (n) lead.name = n;
  }
  const justGotName = !hadNameBefore && !!lead.name;

  // ── EXTRACT EMAIL ─────────────────────────────────────────
  const emailMatch = userMessage.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  const justGotEmail = !lead.email && !!emailMatch; // true only on the message where email is first given
  if (justGotEmail) {
    lead.email = emailMatch[0].toLowerCase();
    lead.stage = 'qualify';
    const newId = await createOrUpdateContact(lead);
    if (newId) lead.ghlId = newId;
  }

  // ── EXTRACT DATE ──────────────────────────────────────────
  if (!lead.booking.date) {
    const d = extractDate(userMessage);
    if (d) lead.booking.date = d;
  }

  // ── EXTRACT TIME ──────────────────────────────────────────
  if (!lead.booking.time) {
    const t = extractTime(userMessage);
    if (t) lead.booking.time = t;
  }

  // ── SAVE BOOKING ──────────────────────────────────────────
  if (
    lead.booking.date &&
    lead.booking.time &&
    lead.email &&
    !lead.booking.saved
  ) {
    lead.booking.saved = true;
    await saveBookingToGHL(lead);
    await sendEmailSummary(contactId, lead, 'booking');
  }

  // ── ADD USER MESSAGE TO HISTORY ──────────────────────────
  conversations[contactId].push({ role: 'user', content: userMessage });

  // ── STAGE-BASED REPLY ─────────────────────────────────────
  let reply = null;

  // STAGE: need name (no name yet AND name wasn't just given)
  if (!lead.name && !justGotName) {
    reply = `Hi there! 😊 I'm Lhyn. Before anything else, may I know your name?`;
    lead.stage = 'get_name';
  }

  // STAGE: name was just given this message
  else if (justGotName && !lead.email) {
    reply = `Nice to meet you, ${lead.name}! 😊 Could I get your email address? I'll use it to send you a booking confirmation later.`;
    lead.stage = 'get_email';
  }

  // STAGE: still waiting for email (name already known from before)
  else if (!lead.email && !justGotEmail) {
    reply = `I just need your email address to continue 😊 What is it?`;
    lead.stage = 'get_email';
  }

  // STAGE: email was just given this message — hardcode acknowledgement
  else if (justGotEmail) {
    reply = `Got it, thanks! 😊 So ${lead.name}, what's been the biggest challenge in your business lately — or is there something specific you're looking to improve?`;
  }

  // STAGE: have name + email — AI takes over
  else {
    // Capture service/problem from their reply (not from the email message itself)
    if (!lead.service && userMessage.length > 5) {
      const fillers = ['yes','no','ok','okay','sure','thanks','hi','hello','hey','yep','nope'];
      if (!fillers.includes(userMessage.toLowerCase().trim())) {
        lead.service = userMessage.slice(0, 200);
      }
    }

    // Update stage
    if (lead.booking.saved) {
      lead.stage = 'done';
    } else if (lead.booking.date && lead.booking.time) {
      lead.stage = 'confirming';
    } else if (lead.service) {
      lead.stage = 'booking';
    } else {
      lead.stage = 'qualify';
    }

    const stageHint = buildStageHint(lead);
    reply = await callAI(contactId, stageHint);
  }

  conversations[contactId].push({ role: 'assistant', content: reply });

  // ── SEND REPLY ────────────────────────────────────────────
  await sendGHLMessage(contactId, reply);

  // ── RESET FOLLOW-UP TIMER ─────────────────────────────────
  resetFollowUpTimer(contactId, lead);
});


// ============================================================
// AI CALL
// ============================================================
async function callAI(contactId, stageHint) {
  const history = conversations[contactId] || [];

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-3.3-70b-instruct:free',
        // 💡 Fallback: if Llama hits rate limits, openrouter/free picks the next best free model
        // To use the auto-router instead, change model to: 'openrouter/free'
        messages: [
          {
            role: 'system',
            content: `${LHYN_KNOWLEDGE}

== CURRENT STAGE INSTRUCTION ==
${stageHint}

IMPORTANT: Keep your reply SHORT (1-3 sentences). One question at a time. Sound human.`
          },
          ...history
        ]
      })
    });

    const data = await res.json();
    const aiText = data.choices?.[0]?.message?.content?.trim();
    if (!aiText) {
      console.error("Empty AI response. Full response:", JSON.stringify(data));
      return "Sorry, I didn't catch that 😅 Could you say that again?";
    }
    return aiText;

  } catch (err) {
    console.error('AI error:', err);
    return "Sorry, I hit a small glitch 😅 Give me a sec — what were you saying?";
  }
}


// ============================================================
// STAGE HINTS  (guides AI for qualify → booking → confirm)
// ============================================================
function buildStageHint(lead) {
  if (lead.stage === 'qualify') {
    return `You are talking to ${lead.name} (email: ${lead.email}). 
You just collected their contact info. Now warmly ask: what problem are they trying to solve, or what kind of help are they looking for? 
Be genuinely curious. Don't list services yet — let them talk first. One question only.`;
  }

  if (lead.stage === 'booking') {
    return `You are talking to ${lead.name}. They told you: "${lead.service}".
Based on their problem, briefly explain how LhynWorks can help (1-2 sentences max), then suggest booking a FREE 30-minute discovery call.
Offer 2-3 time options like: tomorrow at 2pm, Thursday at 10am, or Friday at 3pm.
Keep it light and easy — no pressure.`;
  }

  if (lead.stage === 'confirming') {
    return `${lead.name} has selected ${lead.booking.date} at ${lead.booking.time} for the discovery call.
Confirm the booking warmly, tell them to check their email for confirmation, and say you're looking forward to chatting. Keep it short and friendly.`;
  }

  if (lead.stage === 'done') {
    return `The booking is saved. ${lead.name} is all set for ${lead.booking.date} at ${lead.booking.time}.
If they ask anything else, answer helpfully. Otherwise, give a friendly sign-off.`;
  }

  return `Continue the conversation naturally with ${lead.name}. Answer their questions helpfully using LhynWorks knowledge. Guide toward booking when the moment feels right.`;
}


// ============================================================
// HELPERS — EXTRACTION
// ============================================================
function extractName(text) {
  const patterns = [
    /my name is ([A-Za-z]+)/i,
    /i(?:'m| am) ([A-Za-z]+)/i,
    /call me ([A-Za-z]+)/i
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m) return capitalize(m[1]);
  }

  // Single word that isn't a common filler
  const fillers = ['hi','hello','hey','ok','yes','no','sure','thanks','okay','yep','nope','good','fine'];
  const words = text.trim().split(/\s+/);
  if (words.length === 1 && !fillers.includes(words[0].toLowerCase()) && !text.includes('@')) {
    return capitalize(words[0]);
  }

  return null;
}

function extractDate(text) {
  const t = text.toLowerCase();
  const today = new Date();

  const weekdays = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

  if (t.includes('day after tomorrow')) {
    return formatDateLabel(addDays(today, 2));
  }
  if (t.includes('tomorrow')) {
    return formatDateLabel(addDays(today, 1));
  }
  if (t.includes('today')) {
    return formatDateLabel(today);
  }

  // "this monday", "next friday", etc.
  for (let i = 0; i < weekdays.length; i++) {
    if (t.includes(weekdays[i])) {
      const d = nextWeekday(i);
      return formatDateLabel(d);
    }
  }

  // "June 5", "June 5th", "5 June"
  const monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  for (let mi = 0; mi < monthNames.length; mi++) {
    if (t.includes(monthNames[mi])) {
      const dayMatch = t.match(/(\d{1,2})/);
      if (dayMatch) {
        const d = new Date(today.getFullYear(), mi, parseInt(dayMatch[1]));
        if (d < today) d.setFullYear(d.getFullYear() + 1);
        return formatDateLabel(d);
      }
    }
  }

  return null;
}

function extractTime(text) {
  // Matches: 2pm, 2 pm, 2:30pm, 14:00, etc.
  const match = text.match(/\b(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b/i);
  if (match) {
    const hour = match[1];
    const min  = match[2] ? `:${match[2]}` : '';
    const ampm = match[3].toLowerCase();
    return `${hour}${min}${ampm}`;
  }

  // 24-hour: 14:00
  const milMatch = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (milMatch) {
    let h = parseInt(milMatch[1]);
    const ampm = h >= 12 ? 'pm' : 'am';
    if (h > 12) h -= 12;
    return `${h}:${milMatch[2]}${ampm}`;
  }

  return null;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function nextWeekday(targetDay) {
  const today = new Date();
  const current = today.getDay();
  let diff = targetDay - current;
  if (diff <= 0) diff += 7;
  return addDays(today, diff);
}

function formatDateLabel(date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });
}

function buildISO(dateLabel, timeStr) {
  // Parse dateLabel back to Date then apply time
  const base = new Date(dateLabel);
  const match = timeStr.match(/(\d{1,2})(?::(\d{2}))?(am|pm)/i);
  if (!match) return base.toISOString();

  let h = parseInt(match[1]);
  const min = match[2] ? parseInt(match[2]) : 0;
  const ampm = match[3].toLowerCase();

  if (ampm === 'pm' && h !== 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;

  base.setHours(h, min, 0, 0);
  return base.toISOString();
}


// ============================================================
// GHL — CREATE / UPDATE CONTACT
// ============================================================
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
        firstName: lead.name || 'Guest',
        email: lead.email
      })
    });

    const data = await res.json();
    console.log('✅ Contact:', data?.contact?.id);
    return data?.contact?.id || null;

  } catch (err) {
    console.error('❌ Contact error:', err);
    return null;
  }
}


// ============================================================
// GHL — SAVE BOOKING (Calendar Event + Custom Fields)
// ============================================================
async function saveBookingToGHL(lead) {
  const id = lead.ghlId;

  // 1. Update custom fields on the contact
  try {
    await fetch(`https://services.leadconnectorhq.com/contacts/${id}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${GHL_API_KEY}`,
        'Content-Type': 'application/json',
        Version: '2021-04-15'
      },
      body: JSON.stringify({
        customFields: [
          { key: 'booking_date', field_value: lead.booking.date },
          { key: 'booking_time', field_value: lead.booking.time },
          { key: 'service_interest', field_value: lead.service || 'Not specified' }
        ]
      })
    });
  } catch (err) {
    console.error('❌ Custom fields error:', err);
  }

  // 2. Create calendar appointment
  if (CALENDAR_ID) {
    try {
      const isoStart = buildISO(lead.booking.date, lead.booking.time);

      await fetch('https://services.leadconnectorhq.com/calendars/events', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${GHL_API_KEY}`,
          'Content-Type': 'application/json',
          Version: '2021-04-15'
        },
        body: JSON.stringify({
          calendarId: CALENDAR_ID,
          contactId:  id,
          startTime:  isoStart,
          title:      `Discovery Call — ${lead.name}`
        })
      });

      console.log('✅ Calendar event created');
    } catch (err) {
      console.error('❌ Calendar error:', err);
    }
  }
}


// ============================================================
// GHL — SEND MESSAGE
// ============================================================
async function sendGHLMessage(contactId, message) {
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
  } catch (err) {
    console.error('❌ Send message error:', err);
  }
}


// ============================================================
// RESEND — EMAIL SUMMARY
// ============================================================
async function sendEmailSummary(contactId, lead, reason = 'booking') {
  const history = conversations[contactId] || [];

  const transcript = history.map(m =>
    `${m.role === 'user' ? '👤 Customer' : '🤖 Lhyn'}: ${m.content}`
  ).join('\n\n');

  const subject = reason === 'booking'
    ? `📅 New Booking — ${lead.name} (${lead.booking.date} at ${lead.booking.time})`
    : `💬 Chat Ended — ${lead.name || 'Unknown'}`;

  const body = `
Name:    ${lead.name || 'Unknown'}
Email:   ${lead.email || 'Not provided'}
Service: ${lead.service || 'Not specified'}
Date:    ${lead.booking.date || 'Not booked'}
Time:    ${lead.booking.time || 'Not booked'}

──────────────────────────────
CONVERSATION TRANSCRIPT
──────────────────────────────
${transcript}
  `.trim();

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from:    'Lhyn <hello@lhynworks.com>',
        to:      [NOTIFY_EMAIL],
        subject,
        text:    body
      })
    });

    console.log('✅ Email sent:', subject);
  } catch (err) {
    console.error('❌ Email error:', err);
  }
}


// ============================================================
// FOLLOW-UP TIMERS
// ============================================================
function resetFollowUpTimer(contactId, lead) {
  // Clear existing timers
  if (timers[contactId]) {
    clearTimeout(timers[contactId].t1);
    clearTimeout(timers[contactId].t2);
  }

  timers[contactId] = {};

  // 2-min check-in
  timers[contactId].t1 = setTimeout(async () => {
    const name = lead.name ? `, ${lead.name}` : '';
    await sendGHLMessage(
      contactId,
      `Hey${name} 😊 just checking — still there? Take your time, no rush!`
    );
  }, 2 * 60 * 1000);

  // 5-min close
  timers[contactId].t2 = setTimeout(async () => {
    const name = lead.name ? ` ${lead.name}` : '';
    await sendGHLMessage(
      contactId,
      `No worries${name} 😊 I'll go ahead and close this chat for now. Feel free to message anytime — I'm always here to help! Have a great day! 🌟`
    );

    // Send transcript email when chat closes
    await sendEmailSummary(contactId, lead, 'closed');

    // Clean up
    delete timers[contactId];
    delete conversations[contactId];
    delete leads[contactId];
  }, 5 * 60 * 1000);
}


// ============================================================
// START
// ============================================================
app.listen(process.env.PORT || 3000, () => {
  console.log('🔥 Lhyn AI Sales Bot — READY');
});
