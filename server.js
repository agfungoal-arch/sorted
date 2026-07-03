/* SORTED backend — single file. Node 18+. Deps: express, cors.
   Run:  ANTHROPIC_API_KEY=sk-... node server.js
   Optional DB (Supabase): set SUPABASE_URL + SUPABASE_SERVICE_KEY — without them, DB features no-op gracefully.
   Photos pass through to Claude and are NEVER written to disk or logged. */

const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json({ limit: '1500kb' }));
app.use(express.static(__dirname)); // serve the app itself (index.html etc.) — one origin, no CDN dependency

const KEY = process.env.ANTHROPIC_API_KEY;
const PILOT_TOKEN = process.env.PILOT_TOKEN; // if set, all routes require x-pilot-token header

/* ---------- RATE LIMIT (in-memory sliding window) + AUTH ---------- */
const hits = new Map();
function limitOk(key, max, winMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < winMs);
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) hits.clear(); // memory guard
  return arr.length <= max;
}
function gate(req, res) {
  if (PILOT_TOKEN && req.headers['x-pilot-token'] !== PILOT_TOKEN) { res.status(401).json({ error: 'unauthorized' }); return false; }
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'x';
  const dev = (req.body && req.body.device_id) || req.query.device || 'anon';
  if (!limitOk('ip:' + ip, 40, 300000) || !limitOk('dev:' + dev, 30, 300000)) { res.status(429).json({ error: 'slow down' }); return false; }
  return true;
}
const MODEL = process.env.MODEL || 'claude-sonnet-4-5';
const PORT = process.env.PORT || 8787;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!KEY) { console.error('Set ANTHROPIC_API_KEY'); process.exit(1); }

/* ---------- SUPABASE (REST, no SDK) — all functions no-op without env ---------- */
async function sb(path, method = 'GET', body = null, params = '') {
  if (!SB_URL || !SB_KEY) return null;
  try {
    const res = await fetch(`${SB_URL}/rest/v1/${path}${params}`, {
      method,
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) { console.error('sb', path, res.status); return null; }
    return await res.json();
  } catch (e) { console.error('sb', e.message); return null; }
}
const logEvent = (device_id, event, mode) => sb('events', 'POST', { device_id, event, mode });

/* ---------- DETERMINISTIC RED-FLAG LAYER (runs BEFORE the model, in code) ---------- */
const RED_FLAGS = [
  { rx: /blood.*(urine|pee|stool|semen)|(urine|pee|stool|semen).*blood|khoon.*(peshaab|urine|pee|potty)|peshaab.*khoon/i,
    action: 'Urologist or GP within 2-3 days. This is not a wait-and-watch.',
    script: 'Blood in urine/stool since [date], with/without pain.' },
  { rx: /(lump|swelling|gaanth|ganth).*(testic|groin|ball)|testic.*(lump|pain|swell)/i,
    action: 'Doctor this week. Most lumps are harmless — but only an exam can say so.',
    script: 'I found a lump/swelling in the testicle/groin area, first noticed [date].' },
  { rx: /fever.*rash|rash.*fever|bukhaar.*rash/i,
    action: 'See a doctor within 24-48 hours. Fever + rash together needs eyes on it.',
    script: 'Fever with a spreading rash since [date].' },
  { rx: /chest.{0,15}(pain|paining|tight|pressure|heavy)|pain.{0,10}chest|can'?t breathe|breathless|difficulty breathing|saans (nahi|phool)/i,
    action: 'This could be an emergency. Call 112 or get to a hospital now.',
    script: 'Chest pain / breathing difficulty — emergency.' },
  { rx: /suicid|kill myself|end (my life|it all)|don'?t want to (live|be here)|no reason to live|(want|thoughts?|thinking).*(end|kill|hurt).*(myself|my life)|marna chahta|khudkushi/i,
    action: 'Talk to a human right now: Tele-MANAS 14416 (free, 24x7, confidential). You matter, and this is exactly what they are there for.',
    script: 'Tele-MANAS: 14416' },
  { rx: /mole.*(chang|grow|bleed)|(chang|grow|bleed).*mole/i,
    action: 'Dermatologist within 2 weeks. Changing moles always get checked.',
    script: 'A mole that has changed size/colour/bleeds, noticed over [period].' },
  { rx: /(unexplained|sudden).*(weight loss)|lost \d+ ?kg/i,
    action: 'GP within the week for basic tests. Usually explainable — but check.',
    script: 'Unexplained weight loss of [x] kg over [period].' },
];
const checkRedFlags = t => RED_FLAGS.find(f => f.rx.test(t)) || null;

/* ---------- VOICE + MODE PROMPTS ---------- */
const VOICE = `You are Sorted — the "sorted elder brother" for Indian men 18-45. Warm, direct, zero judgment, slightly wry. Natural English with light Hinglish where it fits ("scene", "boss", "yaar" — sparingly). Replies are 2-6 lines max. Never flatter falsely. Never shame. No numeric scores ever. One question at a time, only if needed.`;

const PROMPTS = {
  verdict: `${VOICE}
You judge outfits from a photo + occasion. Understand Indian dress codes (kurta, sherwani, bandhgala, office, festival).
THE PROBLEM OF PLENTY: his real pain is too many choices, not too few. If the photo shows a wardrobe, a pile, or several garments — or he lists several options — your job is to CHOOSE FOR HIM. Use verdict "WEAR THIS", reasons must name the exact items you picked ("the navy kurta, third from left"), and fix gives the complete head-to-toe combination. ONE answer. Never a menu, never "either works".
Respond ONLY with JSON:
{"type":"verdict","verdict":"READY"|"ALMOST"|"NOT THIS ONE"|"WEAR THIS"|"CAN'T TELL",
 "reasons":["max 3, specific, reference what you SEE and his known profile"],
 "fix":"1-2 concrete actions, or empty if READY (then a confident send-off)",
 "memory_note":"short note worth remembering (e.g. 'navy kurta = wedding winner') or null",
 "skinTone":"only if clearly inferable from photo, else null","faceShape":null,
 "followup":"one short natural line inviting the loop to close (e.g. send a pic after the swap) or null"}
Rules: if photo too dark/blurry/absent → verdict CAN'T TELL, reasons explain kindly (blame the light, never the man), fix asks for a retake. Most verdicts should be ALMOST with a sharp fix — honest AND actionable. Use his profile (skin tone, past wins) when present and SAY so ("your skin tone").`,

  private: `${VOICE}
PRIVATE SPACE mode — men's sensitive health (groin, skin, sweat, hair fall, weight, bloating, performance anxiety). Calm, factual, normalizing. NO emojis except at most one 🤝.
You provide EDUCATION ONLY — never diagnosis, never prescription drugs/doses, never interpret lesions from photos (ask them to see a derm for anything visible on skin that changes). Structure: (1) normalize with a stat if honest, (2) plain-language explanation of the likely CATEGORY, (3) practical self-care this week incl. OTC CATEGORY (e.g. "an antifungal dusting powder — ask the chemist, ~₹120"), (4) the doctor line.
Respond ONLY with JSON:
{"type":"private","reply":"the main reply, 3-7 lines",
 "doctor":{"action":"when/what kind of doctor + honest cost in ₹","script":"exact words he can say","cost":"₹ range"} or null,
 "red_flag":false}
Include "doctor" whenever symptoms have lasted 2+ weeks, are worsening, or he seems to be delaying. India context: derm visit ₹500-800, GP ₹300-500.`,

  product: `${VOICE}
PRODUCT TRUTH mode — Indian men's grooming products. You read labels from photos or answer product questions. Be blunt about marketing claims. Never invent ingredients you cannot see — if unsure, say what you'd need to check and lower confidence. No fear-mongering: parabens are legal and low-risk; state preferences honestly.
Respond ONLY with JSON:
{"type":"product","name":"product name if identifiable or null","price":"₹ if known or null",
 "flags":[{"ok":true/false,"label":"e.g. Aluminium salts / Paraben-free"}],
 "note":"1-3 blunt sentences incl. any claim-check ('48-hr protection is marketing')",
 "alternatives":[{"name":"","price":"₹ approx","flags":["max 3 short positives"]}] (max 2, only if genuinely helpful),
 "confidence":"verified-list"|"label-read"|"general-knowledge"}
If VERIFIED PRODUCT DATA is provided below, prefer it over your own knowledge and set confidence "verified-list".
For text questions (no photo): recommend max 2 products with honest reasoning + 1 anti-recommendation pattern to avoid.`,

  barber: `${VOICE}
BARBER CARD mode. From a selfie (face shape, hair type) and/or his description, recommend ONE haircut (+beard treatment) that suits him. Practical, Indian-barbershop language.
Respond ONLY with JSON:
{"type":"barber","style":"name e.g. 'Mid Fade · Scissor Top'",
 "steps":["3-4 exact instructions with clipper numbers","e.g. Sides: 2 number, fade to 4"],
 "hinglish":"one line he can say aloud: 'Bhaiya — sides pe 2 number fade, upar scissor se, length rakhna.'",
 "note":"one short encouraging line or maintenance tip"}
If no selfie: ask ONE question OR give a safe versatile recommendation based on what he said. Never invent face-shape claims without a photo.`,
};

/* ---------- SKU CONTEXT (verified product data injection) ---------- */
async function skuContext(text) {
  if (!SB_URL || !text) return '';
  const words = (text.match(/[a-zA-Z]{4,}/g) || []).slice(0, 5);
  if (!words.length) return '';
  const q = words.map(w => `name.ilike.*${w}*`).join(',');
  const rows = await sb('sku_products', 'GET', null, `?or=(${q})&limit=3&select=name,brand,price_band,flags,claim_notes,last_verified`);
  if (!rows || !rows.length) return '';
  return '\nVERIFIED PRODUCT DATA (curated, dated — prefer this):\n' + rows.map(r =>
    `- ${r.name} (${r.brand||''}) ${r.price_band||''} flags:${JSON.stringify(r.flags)} notes:${r.claim_notes||''} verified:${r.last_verified}`).join('\n');
}

/* ---------- CLAUDE CALL ---------- */
async function askClaude(mode, messages, image, occasion, profile, extraCtx) {
  const profileCtx = profile ? `\nHIS PROFILE (use it, mention it when relevant): name:${profile.name}, city:${profile.city || 'unknown'}, skinTone:${profile.skinTone || 'unknown'}, faceShape:${profile.faceShape || 'unknown'}, sizes:${profile.sizes || 'unknown'}, styleWins:${(profile.notes || []).slice(-5).join('; ') || 'none yet'}` : '';
  const sys = PROMPTS[mode] + profileCtx + (occasion ? `\nOCCASION: ${occasion}` : '') + (extraCtx || '');

  const apiMessages = messages.filter(m => m.content).map(m => ({ role: m.role, content: m.content }));
  if (image && apiMessages.length) {
    const last = apiMessages[apiMessages.length - 1];
    last.content = [
      { type: 'image', source: { type: 'base64', media_type: image.media_type, data: image.data } },
      { type: 'text', text: typeof last.content === 'string' ? last.content : '[photo]' },
    ];
  }
  if (!apiMessages.length) apiMessages.push({ role: 'user', content: 'Hi' });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 900, system: sys, messages: apiMessages }),
  });
  if (!res.ok) throw new Error('anthropic ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const out = await res.json();
  const text = out.content.map(c => c.text || '').join('');
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  try { return JSON.parse(jsonMatch ? jsonMatch[0] : text); }
  catch { return { type: 'chat', reply: text.slice(0, 800) }; }
}

/* ---------- ROUTES ---------- */
app.post('/ask', async (req, res) => {
  try {
    if (!gate(req, res)) return;
    const { mode, messages = [], image, occasion, profile, device_id } = req.body || {};
    if (!PROMPTS[mode]) return res.status(400).json({ error: 'bad mode' });
    // cap message lengths server-side (cost + DoS guard)
    for (const m of messages) if (typeof m.content === 'string') m.content = m.content.slice(0, 4000);

    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const lastText = lastUser && typeof lastUser.content === 'string' ? lastUser.content : '';

    // deterministic red-flag check — before the model, always
    const flag = checkRedFlags(lastText);
    if (flag) {
      if (device_id) {
        logEvent(device_id, 'red_flag', mode);
        sb('followups', 'POST', { device_id, due_date: new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10), topic: 'urgent-followup', status: 'pending' });
      }
      return res.json({
        type: 'private', red_flag: true,
        reply: "Stop — this one isn't a wait-and-watch, and I'd be a bad friend if I pretended otherwise.",
        doctor: { action: flag.action, script: flag.script, cost: '' },
      });
    }

    const extraCtx = mode === 'product' ? await skuContext(lastText) : '';
    const data = await askClaude(mode, messages, image, occasion, profile, extraCtx);

    if (device_id) {
      logEvent(device_id, mode === 'verdict' ? 'verdict_given' : mode + '_used', mode);
      // schedule the day-7 nudge when health advice included a doctor line
      if (mode === 'private' && data.doctor) {
        sb('followups', 'POST', { device_id, due_date: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10), topic: 'health-followup', status: 'pending' });
      }
    }
    res.json(data);
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: 'upstream' });
  }
});

app.post('/event', async (req, res) => {
  if (!gate(req, res)) return;
  const { device_id, event, mode } = req.body || {};
  if (device_id && event && String(event).length < 40) await logEvent(String(device_id).slice(0, 60), String(event), mode ? String(mode).slice(0, 20) : null);
  res.json({ ok: true });
});

app.get('/followups', async (req, res) => {
  if (!gate(req, res)) return;
  const d = req.query.device;
  if (!d) return res.json([]);
  const rows = await sb('followups', 'GET', null, `?device_id=eq.${encodeURIComponent(d)}&status=eq.pending&due_date=lte.${new Date().toISOString().slice(0, 10)}&select=id,topic,due_date`);
  res.json(rows || []);
});

app.post('/followups/done', async (req, res) => {
  if (!gate(req, res)) return;
  const { id, device_id } = req.body || {};
  if (id && device_id) await sb(`followups?id=eq.${encodeURIComponent(id)}&device_id=eq.${encodeURIComponent(device_id)}`, 'PATCH', { status: 'done' });
  res.json({ ok: true });
});

app.get('/health', (_, res) => res.json({ ok: true, db: !!SB_URL }));

app.listen(PORT, () => console.log(`SORTED backend on :${PORT} · model ${MODEL} · db ${SB_URL ? 'connected' : 'off (no-op)'} · photos never stored`));
