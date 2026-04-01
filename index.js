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
const leads      = {};
const convos     = {};
const timers     = {};
const processing = {};

// ============================================================
// SERVICES KNOWLEDGE (for AI replies)
// ============================================================
const SERVICES = {
  funnel: {
    match: ['funnel','landing page','website','convert','page'],
    reply: `Funnels that don't convert are usually missing clear copy or a strong CTA — totally fixable! 😊 Let's hop on a FREE 30-min call and I'll show you exactly what to fix.`
  },
  ghl: {
    match: ['ghl','go high level','highlevel','crm','automation','pipeline','workflow','follow up','follow-up','leads'],
    reply: `GHL setup and automation is literally what we do best! 😊 Let's get on a quick FREE call and map out your whole system.`
  },
  chatbot: {
    match: ['chatbot','chat bot','bot','ai','assistant','booking bot'],
    reply: `A custom AI chatbot can handle your leads 24/7 — we build those! 😊 Let's jump on a FREE 30-min call and figure out exactly what you need.`
  },
  social: {
    match: ['social media','content','post','caption','instagram','facebook','tiktok'],
    reply: `Content strategy is one of our specialties! 😊 Let's hop on a quick FREE call and build you a solid plan.`
  },
  bookkeeping: {
    match: ['bookkeep','accounting','invoice','money','finance','books','report'],
    reply: `We've got a Bookkeeping VA who can sort all that out for you! 😊 Let's get on a FREE call and see what you need.`
  }
};

// ============================================================
// PREVENT DOUBLE WEBHOOK FIRES
// ============================================================
app.post('/webhook/ghl-chat', async (req, res) => {
  res.sendStatus(200);

  const contactId = req.body.contact_id;
  const rawMsg    = req.body.message;
  if (!contactId) return;

  if (processing[contactId]) return; // skip if already handling
  processing[contactId] = true;

  try {
    const userMsg = (typeof rawMsg === 'string' ? rawMsg : rawMsg?.body || '').trim();
    if (!userMsg) return;

    // ── INIT ──────────────────────────────────────────────
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
    console.log(`📩 [${lead.stage}] "${userMsg}"`);

    // ── EXTRACT NAME ──────────────────────────────────────
    if (!lead.name) {
      const n = extractName(userMsg);
      if (n) { lead.name = n; console.log(`✅ Name: ${n}`); }
    }

    // ── EXTRACT EMAIL ─────────────────────────────────────
    if (!lead.email) {
      const em = userMsg.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
      if (em) {
        lead.email = em[0].toLowerCase();
        console.log(`✅ Email: ${lead.email}`);
        await ghlCreateContact(lead, contactId); // ← original V1 style
      }
    }

    // ── EXTRACT SERVICE ───────────────────────────────────
    if (lead.stage === 'need_service' && !lead.service) {
      const fillers = new Set(['yes','no','ok','okay','sure','thanks','yep','nope','hi','hello','hey','good','cool','great','fine']);
      if (!fillers.has(userMsg.toLowerCase().trim()) && userMsg.length > 3) {
        lead.service = userMsg.slice(0, 300);
        console.log(`✅ Service: ${lead.service}`);
      }
    }

    // ── EXTRACT DATE ──────────────────────────────────────
    if (lead.stage === 'booking' && !lead.booking.date) {
      const d = extractDate(userMsg);
      if (d) { lead.booking.date = d; console.log(`✅ Date: ${d}`); }
    }

    // ── EXTRACT TIME ──────────────────────────────────────
    if (lead.stage === 'booking' && !lead.booking.time) {
      const t = extractTime(userMsg);
      if (t) { lead.booking.time = t; console.log(`✅ Time: ${t}`); }
    }

    // ── ADVANCE STAGE ─────────────────────────────────────
    if (lead.stage === 'need_name'    && lead.name)    lead.stage = 'need_email';
    if (lead.stage === 'need_email'   && lead.email)   lead.stage = 'need_service';
    if (lead.stage === 'need_service' && lead.service) lead.stage = 'booking';

    if (lead.stage === 'booking' && lead.booking.date && lead.booking.time && !lead.booking.saved) {
      lead.booking.saved = true;
      lead.stage = 'confirming';
      await ghlSaveBooking(lead, contactId);  // ← original V1 style
      await sendEmailSummary(contactId, lead);
    }

    // ── REPLY ─────────────────────────────────────────────
    const reply = buildReply(lead, userMsg);
    convos[contactId].push({ role: 'user',      content: userMsg });
    convos[contactId].push({ role: 'assistant', content: reply  });

    await ghlSendMessage(contactId, reply);
    resetTimers(contactId, lead);

  } finally {
    processing[contactId] = false;
  }
});


// ============================================================
// BUILD REPLY — 100% hardcoded, no AI dependency
// ============================================================
function buildReply(lead, userMsg) {
  const { stage, name, email, service, booking } = lead;

  // ── STAGE: need_name ──────────────────────────────────
  if (stage === 'need_name') {
    return `Hi there! 😊 I'm Lhyn from LhynWorks. May I know your name?`;
  }

  // ── STAGE: need_email ─────────────────────────────────
  if (stage === 'need_email') {
    return `Nice to meet you, ${name}! 😊 What's your email so I can send you a booking confirmation?`;
  }

  // ── STAGE: need_service ───────────────────────────────
  if (stage === 'need_service') {
    return `Got it! 😊 So ${name}, what's the main thing you need help with right now?`;
  }

  // ── STAGE: booking ────────────────────────────────────
  if (stage === 'booking') {

    // They just described their problem — acknowledge + offer slots
    if (!booking.date && !booking.time) {
      const slots = getSlots();
      const serviceReply = matchServiceReply(service || userMsg);
      return `${serviceReply}\n\nHere are some times for a FREE 30-min call:\n${slots}\n\nWhich works for you? 😊`;
    }

    // They gave a date but no time
    if (booking.date && !booking.time) {
      return `Great, ${booking.date} works! 😊 What time do you prefer — morning or afternoon?`;
    }

    // They gave a time but no date
    if (!booking.date && booking.time) {
      const slots = getSlots();
      return `${booking.time} sounds good! 😊 Which day works?\n${slots}`;
    }

    // Shouldn't reach here but handle gracefully
    return `Almost there! 😊 Just need a date and time — which of these works?\n${getSlots()}`;
  }

  // ── STAGE: confirming ─────────────────────────────────
  if (stage === 'confirming') {
    return `You're all set, ${name}! 🎉\n📅 ${booking.date} at ${booking.time}\n📧 Confirmation going to ${email}\n\nCan't wait to chat! 😊`;
  }

  // ── STAGE: done ───────────────────────────────────────
  if (stage === 'done') {
    return `You're booked, ${name}! 😊 Check your email for all the details. Feel free to message anytime!`;
  }

  // Fallback
  return `I'm here to help! 😊 What can I do for you, ${name || 'there'}?`;
}


// ============================================================
// MATCH SERVICE → SMART REPLY
// ============================================================
function matchServiceReply(text) {
  const t = text.toLowerCase();
  for (const key of Object.keys(SERVICES)) {
    if (SERVICES[key].match.some(kw => t.includes(kw))) {
      return SERVICES[key].reply;
    }
  }
  // Generic fallback
  return `That's something we can definitely help with! 😊 Let's jump on a quick FREE 30-min call so I can give you the best solution.`;
}


// ============================================================
// SLOT SUGGESTIONS
// ============================================================
function getSlots() {
  const today = new Date();
  const lines = [];
  const times = ['10am', '2pm', '4pm'];
  for (let i = 1; i <= 3; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    lines.push(`• ${label} at ${times[i - 1]}`);
  }
  return lines.join('\n');
}


// ============================================================
// GHL — CREATE CONTACT  (same as your working V1)
// ============================================================
async function ghlCreateContact(lead, fallbackId) {
  if (!GHL_API_KEY) { console.error('❌ GHL_API_KEY missing'); return; }

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
        email:     lead.email
      })
    });

    const raw = await res.text();
    console.log(`📥 GHL contact (${res.status}):`, raw.slice(0, 200));

    const data = JSON.parse(raw);
    const id   = data?.contact?.id || null;
    if (id) {
      lead.ghlId = id;
      console.log(`✅ GHL Contact ID: ${id}`);
    }
  } catch (err) {
    console.error('❌ ghlCreateContact:', err.message);
  }
}


// ============================================================
// GHL — SAVE BOOKING  (calendar event, same as your working V1)
// ============================================================
async function ghlSaveBooking(lead, fallbackId) {
  if (!GHL_API_KEY || !CALENDAR_ID) {
    console.warn('⚠️ GHL_API_KEY or CALENDAR_ID missing — skipping booking save');
    return;
  }

  const iso = buildISO(lead.booking.date, lead.booking.time);
  console.log(`📅 Saving appointment: ${iso}`);

  try {
    const res = await fetch('https://services.leadconnectorhq.com/calendars/events', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GHL_API_KEY}`,
        'Content-Type': 'application/json',
        Version: '2021-04-15'
      },
      body: JSON.stringify({
        calendarId: CALENDAR_ID,
        contactId:  lead.ghlId,
        startTime:  iso,
        title:      `Discovery Call — ${lead.name}`
      })
    });

    const raw = await res.text();
    console.log(`📥 GHL calendar (${res.status}):`, raw.slice(0, 200));
  } catch (err) {
    console.error('❌ ghlSaveBooking:', err.message);
  }
}


// ============================================================
// GHL — SEND MESSAGE
// ============================================================
async function ghlSendMessage(contactId, message) {
  if (!GHL_API_KEY) return;
  try {
    await fetch('https://services.leadconnectorhq.com/conversations/messages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GHL_API_KEY}`,
        'Content-Type': 'application/json',
        Version: '2021-04-15'
      },
      body: JSON.stringify({ type: 'Live_Chat', contactId, message })
    });
  } catch (err) {
    console.error('❌ ghlSendMessage:', err.message);
  }
}


// ============================================================
// RESEND — EMAIL SUMMARY
// ============================================================
async function sendEmailSummary(contactId, lead) {
  if (!RESEND_API_KEY) return;
  const history    = convos[contactId] || [];
  const transcript = history.map(m =>
    `${m.role === 'user' ? '👤 Customer' : '🤖 Lhyn'}: ${m.content}`
  ).join('\n\n');

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
        subject: `📅 New Booking — ${lead.name} | ${lead.booking.date} at ${lead.booking.time}`,
        text:    `Name:    ${lead.name}\nEmail:   ${lead.email}\nService: ${lead.service}\nDate:    ${lead.booking.date}\nTime:    ${lead.booking.time}\n\n---\n${transcript}`
      })
    });
    console.log('✅ Email summary sent');
  } catch (err) {
    console.error('❌ sendEmailSummary:', err.message);
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

  timers[contactId].t1 = setTimeout(() => {
    ghlSendMessage(contactId, `Hey ${lead.name || 'there'} 😊 just checking — still around?`);
  }, 2 * 60 * 1000);

  timers[contactId].t2 = setTimeout(async () => {
    await ghlSendMessage(contactId, `No worries ${lead.name || ''} 😊 I'll close this for now — feel free to message anytime! Have a great day! 🌟`);
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
  const fillers = new Set(['hi','hello','hey','ok','yes','no','sure','thanks',
    'okay','yep','nope','good','fine','great','nice','cool','what','how','when',
    'why','who','where','is','are','can','do','my','the','a','an','i']);
  const words = text.trim().split(/\s+/);
  if (words.length === 1 && !fillers.has(words[0].toLowerCase()) && !text.includes('@')) {
    return cap(words[0]);
  }
  return null;
}

function extractDate(text) {
  const t     = text.toLowerCase();
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
  if (m) return `${m[1]}${m[2] ? ':' + m[2] : ''}${m[3].toLowerCase()}`;
  const m2 = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m2) {
    let h = parseInt(m2[1]);
    const ap = h >= 12 ? 'pm' : 'am';
    if (h > 12) h -= 12;
    if (h === 0) h = 12;
    return `${h}:${m2[2]}${ap}`;
  }
  return null;
}

function buildISO(dateLabel, timeStr) {
  const base  = new Date(dateLabel);
  const match = timeStr.match(/(\d{1,2})(?::(\d{2}))?(am|pm)/i);
  if (!match) return base.toISOString();
  let h      = parseInt(match[1]);
  const min  = match[2] ? parseInt(match[2]) : 0;
  const ampm = match[3].toLowerCase();
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
  console.log('🔥 Lhyn Sales Bot — READY (no AI dependency)');
  console.log('  GHL_API_KEY:    ', GHL_API_KEY     ? '✅' : '❌ MISSING');
  console.log('  CALENDAR_ID:    ', CALENDAR_ID     ? '✅' : '❌ MISSING — bookings wont save!');
  console.log('  RESEND_API_KEY: ', RESEND_API_KEY  ? '✅' : '⚠️  optional');
  console.log('  NOTIFY_EMAIL:   ', NOTIFY_EMAIL);
});
