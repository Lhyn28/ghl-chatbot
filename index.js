import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

// ============================================================
// ENV
// ============================================================
const GHL_API_KEY        = process.env.GHL_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const RESEND_API_KEY     = process.env.RESEND_API_KEY;
const CALENDAR_ID        = process.env.CALENDAR_ID;
const NOTIFY_EMAIL       = process.env.NOTIFY_EMAIL || 'yourteam@lhynworks.com';

// ============================================================
// STATE
// ============================================================
const leads     = {};  // { contactId: LeadObject }
const convos    = {};  // { contactId: [{role, content}] }
const timers    = {};  // { contactId: {t1, t2} }
const processing = {}; // { contactId: boolean } — prevents double firing

// ============================================================
// LHYNWORKS KNOWLEDGE
// ✏️ Update this with your real info
// ============================================================
const KNOWLEDGE = `
You are Lhyn, a warm and confident sales assistant for LhynWorks — a Filipino-led digital agency.

SERVICES:
- GHL (GoHighLevel) Setup & Automation: CRM, pipelines, workflows, chatbots, funnels — starts at $297
- AI Chatbot Development: custom bots for websites/CRMs — starts at $197
- Funnel & Website Design: landing pages, portfolio sites — starts at $297
- Social Media & Content Strategy: content plans, captions, brand voice
- Bookkeeping & Admin VA: financial tracking, invoicing, reporting

PROBLEMS WE SOLVE:
- Losing leads → GHL automation + AI bot
- Website not converting → Funnel redesign
- No content ideas → Content strategy
- Need a booking bot → AI Chatbot + GHL
- Money tracking mess → Bookkeeping VA

BOOKING: Free 30-minute discovery call. No credit card. No pressure.

PERSONALITY:
- Text like a smart friend, not a robot
- MAX 2 sentences per reply
- One question at a time
- Light emojis occasionally 😊
- Never ask about timezone — just confirm the date and time they pick
- Never say "as an AI" or "I cannot"
- If unsure about something specific, say "let's talk about that on the call!"
`.trim();

// ============================================================
// WEBHOOK
// ============================================================
app.post('/webhook/ghl-chat', async (req, res) => {
  res.sendStatus(200);

  const contactId = req.body.contact_id;
  const rawMsg    = req.body.message;

  if (!contactId) return;

  // ── PREVENT DOUBLE PROCESSING ─────────────────────────────
  if (processing[contactId]) {
    console.log(`⚠️ Already processing for ${contactId}, skipping`);
    return;
  }
  processing[contactId] = true;

  try {
    const userMsg = (typeof rawMsg === 'string' ? rawMsg : rawMsg?.body || '').trim();
    if (!userMsg) return;

    // ── INIT LEAD ──────────────────────────────────────────
    if (!leads[contactId]) {
      leads[contactId] = {
        name:    null,
        email:   null,
        ghlId:   contactId,
        service: null,
        stage:   'need_name',
        booking: { date: null, time: null, saved: false }
      };
      convos[contactId] = [];
    }

    const lead = leads[contactId];
    console.log(`📩 [${contactId}] stage=${lead.stage} msg="${userMsg}"`);

    // ── EXTRACT DATA ───────────────────────────────────────
    // Name (only while we still need it)
    if (!lead.name) {
      const n = extractName(userMsg);
      if (n) {
        lead.name = n;
        console.log(`✅ Name captured: ${n}`);
      }
    }

    // Email (only while we still need it)
    if (!lead.email) {
      const emailFound = userMsg.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
      if (emailFound) {
        lead.email = emailFound[0].toLowerCase();
        console.log(`✅ Email captured: ${lead.email}`);
        // Save to GHL immediately
        const ghlId = await createContact(lead);
        if (ghlId) lead.ghlId = ghlId;
      }
    }

    // Service/problem — capture as soon as we're in need_service stage
    if (lead.stage === 'need_service' && !lead.service) {
      const fillers = new Set(['yes','no','ok','okay','sure','thanks','yep','nope',
                               'hi','hello','hey','good','fine','great','cool']);
      const clean = userMsg.toLowerCase().trim();
      if (!fillers.has(clean) && userMsg.length > 3) {
        lead.service = userMsg.slice(0, 300);
        console.log(`✅ Service captured: ${lead.service}`);
      }
    }

    // Date + time — capture in booking stage OR if they mention it anytime after need_service
    if ((lead.stage === 'booking' || lead.stage === 'need_service') && lead.service) {
      if (!lead.booking.date) {
        const d = extractDate(userMsg);
        if (d) { lead.booking.date = d; console.log(`✅ Date: ${d}`); }
      }
      if (!lead.booking.time) {
        const t = extractTime(userMsg);
        if (t) { lead.booking.time = t; console.log(`✅ Time: ${t}`); }
      }
    }

    // ── ADVANCE STAGE ──────────────────────────────────────
    if (lead.stage === 'need_name' && lead.name) {
      lead.stage = 'need_email';
    }
    if (lead.stage === 'need_email' && lead.email) {
      lead.stage = 'need_service';
    }
    if (lead.stage === 'need_service' && lead.service) {
      lead.stage = 'booking';  // ← now this actually triggers because service is set above
    }
    if (lead.stage === 'booking' && lead.booking.date && lead.booking.time && !lead.booking.saved) {
      lead.stage = 'confirming';
      lead.booking.saved = true;
      await saveBooking(lead);
      await sendEmailSummary(contactId, lead);
    }

    // ── BUILD REPLY ────────────────────────────────────────
    convos[contactId].push({ role: 'user', content: userMsg });
    const reply = await buildReply(contactId, lead, userMsg);
    convos[contactId].push({ role: 'assistant', content: reply });

    // ── SEND ───────────────────────────────────────────────
    await sendMsg(contactId, reply);
    resetTimers(contactId, lead);

  } finally {
    processing[contactId] = false;
  }
});


// ============================================================
// BUILD REPLY — hardcoded for critical stages, AI for sales
// ============================================================
async function buildReply(contactId, lead, userMsg) {
  const { stage, name, email, service, booking } = lead;

  // --- HARDCODED STAGES (never touch AI) ---

  if (stage === 'need_name') {
    return `Hi there! 😊 I'm Lhyn. May I know your name?`;
  }

  if (stage === 'need_email') {
    return `Nice to meet you, ${name}! 😊 What's your email so I can send you a confirmation?`;
  }

  if (stage === 'need_service') {
    // Email was just given — ask about their problem
    return `Got it! 😊 So ${name}, what's the biggest challenge you're trying to solve right now?`;
  }

  if (stage === 'confirming') {
    return `You're all set, ${name}! 📅 ${booking.date} at ${booking.time} — I'll send the details to ${email}. Can't wait to chat! 😊`;
  }

  if (stage === 'done') {
    return `You're booked, ${name}! 😊 Check your email for details. Feel free to message anytime!`;
  }

  // --- AI STAGE: booking — AI answers their problem + pushes to schedule ---
  if (stage === 'booking') {
    return await callAI(contactId, lead);
  }

  // Fallback
  return await callAI(contactId, lead);
}


// ============================================================
// AI CALL — short, strict, sales-focused
// ============================================================
async function callAI(contactId, lead) {
  const history = convos[contactId] || [];

  // Build a very specific, strict system prompt
  const today = new Date();
  const options = [1,2,3].map(i => {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  });

  let stageInstruction = '';

  if (!lead.service) {
    stageInstruction = `Ask ${lead.name} what problem they need help with. One short question. That's it.`;
  } else if (!lead.booking.date || !lead.booking.time) {
    stageInstruction = `${lead.name} needs help with: "${lead.service}". 
In ONE sentence, acknowledge and say you can help.
Then offer these exact time slots: ${options[0]} at 2pm, ${options[1]} at 10am, or ${options[2]} at 3pm.
Ask which one works. Nothing else. Do NOT ask for timezone.`;
  } else {
    stageInstruction = `Continue helping ${lead.name}. Keep it under 2 sentences.`;
  }

  const systemPrompt = `${KNOWLEDGE}

RIGHT NOW YOUR ONLY JOB:
${stageInstruction}

STRICT RULES — NO EXCEPTIONS:
- Maximum 2 sentences total. If you write more, you fail.
- Do NOT ask for timezone
- Do NOT ask multiple questions
- Do NOT explain yourself
- Sound like a human text message`;

  const models = [
    'meta-llama/llama-3.3-70b-instruct:free',
    'mistralai/mistral-7b-instruct:free',
    'openrouter/free'
  ];

  for (const model of models) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://portfolio.lhynworks.com',
          'X-Title': 'LhynWorks Bot'
        },
        body: JSON.stringify({
          model,
          max_tokens: 80,       // very short — forces brief replies
          temperature: 0.5,
          messages: [
            { role: 'system', content: systemPrompt },
            ...history.slice(-6) // only last 6 messages
          ]
        })
      });

      const data = await res.json();
      const text = data.choices?.[0]?.message?.content?.trim();

      if (text) {
        console.log(`✅ AI (${model}): ${text}`);
        return text;
      }

      console.warn(`⚠️ Empty from ${model}:`, JSON.stringify(data).slice(0, 200));

    } catch (err) {
      console.error(`❌ ${model} error:`, err.message);
    }
  }

  // All AI models failed — hardcoded smart fallback
  return hardcodedFallback(lead);
}

function hardcodedFallback(lead) {
  const today = new Date();
  const slots = [1,2,3].map(i => {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  });

  if (!lead.service) {
    return `What's the main thing you're trying to fix or improve right now? 😊`;
  }
  if (!lead.booking.date || !lead.booking.time) {
    return `We can definitely help with that! 😊 Does ${slots[0]} at 2pm, ${slots[1]} at 10am, or ${slots[2]} at 3pm work for a quick call?`;
  }
  return `Awesome, you're all set! 😊 Check your email for the details.`;
}


// ============================================================
// GHL — CREATE CONTACT
// ============================================================
async function createContact(lead) {
  if (!GHL_API_KEY) {
    console.error('❌ GHL_API_KEY not set!');
    return null;
  }

  const body = {
    firstName: lead.name || 'Guest',
    email:     lead.email,
    tags:      ['chatbot-lead']
  };

  console.log(`📤 GHL createContact:`, body);

  try {
    const res  = await fetch('https://services.leadconnectorhq.com/contacts/', {
      method:  'POST',
      headers: {
        Authorization: `Bearer ${GHL_API_KEY}`,
        'Content-Type': 'application/json',
        Version:        '2021-04-15'
      },
      body: JSON.stringify(body)
    });

    const text = await res.text();
    console.log(`📥 GHL response (${res.status}):`, text.slice(0, 300));

    const data = JSON.parse(text);
    const id   = data?.contact?.id || data?.id || null;

    if (id) console.log(`✅ GHL Contact created: ${id}`);
    else    console.warn(`⚠️ No ID in GHL response`);

    return id;

  } catch (err) {
    console.error('❌ GHL createContact error:', err.message);
    return null;
  }
}


// ============================================================
// GHL — SAVE BOOKING
// ============================================================
async function saveBooking(lead) {
  const id = lead.ghlId;
  if (!id || !GHL_API_KEY) return;

  // Update contact custom fields
  try {
    await fetch(`https://services.leadconnectorhq.com/contacts/${id}`, {
      method:  'PUT',
      headers: {
        Authorization: `Bearer ${GHL_API_KEY}`,
        'Content-Type': 'application/json',
        Version:        '2021-04-15'
      },
      body: JSON.stringify({
        customFields: [
          { key: 'booking_date',     field_value: lead.booking.date  },
          { key: 'booking_time',     field_value: lead.booking.time  },
          { key: 'service_interest', field_value: lead.service || '' }
        ]
      })
    });
    console.log('✅ GHL contact updated with booking');
  } catch (err) {
    console.error('❌ GHL update error:', err.message);
  }

  // Create calendar event
  if (CALENDAR_ID) {
    try {
      const iso = buildISO(lead.booking.date, lead.booking.time);
      await fetch('https://services.leadconnectorhq.com/calendars/events', {
        method:  'POST',
        headers: {
          Authorization: `Bearer ${GHL_API_KEY}`,
          'Content-Type': 'application/json',
          Version:        '2021-04-15'
        },
        body: JSON.stringify({
          calendarId: CALENDAR_ID,
          contactId:  id,
          startTime:  iso,
          title:      `Discovery Call — ${lead.name}`
        })
      });
      console.log('✅ GHL Calendar event created');
    } catch (err) {
      console.error('❌ Calendar error:', err.message);
    }
  }
}


// ============================================================
// GHL — SEND MESSAGE
// ============================================================
async function sendMsg(contactId, message) {
  if (!GHL_API_KEY) return;
  try {
    await fetch('https://services.leadconnectorhq.com/conversations/messages', {
      method:  'POST',
      headers: {
        Authorization: `Bearer ${GHL_API_KEY}`,
        'Content-Type': 'application/json',
        Version:        '2021-04-15'
      },
      body: JSON.stringify({ type: 'Live_Chat', contactId, message })
    });
  } catch (err) {
    console.error('❌ sendMsg error:', err.message);
  }
}


// ============================================================
// RESEND — EMAIL SUMMARY
// ============================================================
async function sendEmailSummary(contactId, lead) {
  if (!RESEND_API_KEY) return;

  const history   = convos[contactId] || [];
  const transcript = history.map(m =>
    `${m.role === 'user' ? '👤' : '🤖'} ${m.content}`
  ).join('\n\n');

  try {
    await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from:    'Lhyn <hello@lhynworks.com>',
        to:      [NOTIFY_EMAIL],
        subject: `📅 New Booking — ${lead.name} | ${lead.booking.date} at ${lead.booking.time}`,
        text:    `Name: ${lead.name}\nEmail: ${lead.email}\nService: ${lead.service}\nDate: ${lead.booking.date}\nTime: ${lead.booking.time}\n\n---\n\n${transcript}`
      })
    });
    console.log('✅ Email sent');
  } catch (err) {
    console.error('❌ Resend error:', err.message);
  }
}


// ============================================================
// FOLLOW-UP TIMERS
// ============================================================
function resetTimers(contactId, lead) {
  if (timers[contactId]) {
    clearTimeout(timers[contactId].t1);
    clearTimeout(timers[contactId].t2);
  }
  timers[contactId] = {};

  // 2 min: check-in
  timers[contactId].t1 = setTimeout(() => {
    sendMsg(contactId, `Hey ${lead.name || 'there'} 😊 still around? No rush!`);
  }, 2 * 60 * 1000);

  // 5 min: close chat
  timers[contactId].t2 = setTimeout(async () => {
    await sendMsg(contactId, `No worries ${lead.name || ''} 😊 I'll close this for now — feel free to message anytime! Have a great day! 🌟`);
    if (!lead.booking.saved) await sendEmailSummary(contactId, lead);
    delete timers[contactId];
    delete convos[contactId];
    delete leads[contactId];
  }, 5 * 60 * 1000);
}


// ============================================================
// HELPERS
// ============================================================
function extractName(text) {
  // Pattern matches
  const patterns = [
    /my name is ([A-Za-z]+)/i,
    /i(?:'m| am) ([A-Za-z]+)/i,
    /call me ([A-Za-z]+)/i,
    /this is ([A-Za-z]+)/i,
    /it'?s ([A-Za-z]+)/i
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return cap(m[1]);
  }
  // Single word fallback
  const fillers = new Set(['hi','hello','hey','ok','yes','no','sure','thanks','okay',
    'yep','nope','good','fine','great','nice','cool']);
  const words = text.trim().split(/\s+/);
  if (words.length === 1 && !fillers.has(words[0].toLowerCase()) && !text.includes('@')) {
    return cap(words[0]);
  }
  return null;
}

function extractDate(text) {
  const t    = text.toLowerCase();
  const today = new Date();
  const days  = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const months = ['january','february','march','april','may','june',
                  'july','august','september','october','november','december'];

  if (t.includes('day after tomorrow')) return fmtDate(addDays(today, 2));
  if (t.includes('tomorrow'))           return fmtDate(addDays(today, 1));
  if (t.includes('today'))              return fmtDate(today);

  for (let i = 0; i < days.length; i++) {
    if (t.includes(days[i])) return fmtDate(nextWeekday(i));
  }
  for (let mi = 0; mi < months.length; mi++) {
    if (t.includes(months[mi])) {
      const dm = t.match(/(\d{1,2})/);
      if (dm) {
        const d = new Date(today.getFullYear(), mi, parseInt(dm[1]));
        if (d < today) d.setFullYear(d.getFullYear() + 1);
        return fmtDate(d);
      }
    }
  }
  return null;
}

function extractTime(text) {
  const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (m) {
    const h    = m[1];
    const min  = m[2] ? `:${m[2]}` : '';
    const ampm = m[3].toLowerCase();
    return `${h}${min}${ampm}`;
  }
  // 24h format
  const m2 = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m2) {
    let h = parseInt(m2[1]);
    const ampm = h >= 12 ? 'pm' : 'am';
    if (h > 12) h -= 12;
    if (h === 0) h = 12;
    return `${h}:${m2[2]}${ampm}`;
  }
  return null;
}

function buildISO(dateLabel, timeStr) {
  const base  = new Date(dateLabel);
  const match = timeStr.match(/(\d{1,2})(?::(\d{2}))?(am|pm)/i);
  if (!match) return base.toISOString();
  let h       = parseInt(match[1]);
  const min   = match[2] ? parseInt(match[2]) : 0;
  const ampm  = match[3].toLowerCase();
  if (ampm === 'pm' && h !== 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  base.setHours(h, min, 0, 0);
  return base.toISOString();
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function nextWeekday(target) {
  const today = new Date();
  let diff = target - today.getDay();
  if (diff <= 0) diff += 7;
  return addDays(today, diff);
}

function fmtDate(date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}


// ============================================================
// START
// ============================================================
app.listen(process.env.PORT || 3000, () => {
  console.log('🔥 Lhyn AI Sales Bot — READY');
  console.log('ENV CHECK:');
  console.log('  GHL_API_KEY:        ', GHL_API_KEY        ? '✅' : '❌ MISSING');
  console.log('  OPENROUTER_API_KEY: ', OPENROUTER_API_KEY  ? '✅' : '❌ MISSING');
  console.log('  RESEND_API_KEY:     ', RESEND_API_KEY      ? '✅' : '⚠️  optional');
  console.log('  CALENDAR_ID:        ', CALENDAR_ID         ? '✅' : '⚠️  optional');
  console.log('  NOTIFY_EMAIL:       ', NOTIFY_EMAIL);
});
