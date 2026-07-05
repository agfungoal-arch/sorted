/* SORTED backend v2 — Node 18+. Deps: express, cors, web-push.
   Env: ANTHROPIC_API_KEY (req) · MODEL · SUPABASE_URL · SUPABASE_SERVICE_KEY · PILOT_TOKEN · VAPID_PUBLIC · VAPID_PRIVATE · CRON_SECRET
   Photos pass through to Claude and are NEVER written to disk or logged. Private chats are never stored. */

const express = require('express');
const cors = require('cors');
let webpush = null; try { webpush = require('web-push'); } catch (e) { console.log('web-push not installed — push disabled'); }

const app = express();
app.use(cors());
app.use(express.json({ limit: '1500kb' }));
app.use(express.static(__dirname));

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || 'claude-sonnet-5';
const PORT = process.env.PORT || 8787;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const PILOT_TOKEN = process.env.PILOT_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;
if (!KEY) { console.error('Set ANTHROPIC_API_KEY'); process.exit(1); }
if (webpush && process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE) {
  webpush.setVapidDetails('mailto:agfun.goal@gmail.com', process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);
} else { webpush = null; }

/* ---------- RATE LIMIT + AUTH ---------- */
const hits = new Map();
function limitOk(key, max, winMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < winMs);
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length <= max;
}
function gate(req, res) {
  if (PILOT_TOKEN && req.headers['x-pilot-token'] !== PILOT_TOKEN) { res.status(401).json({ error: 'unauthorized' }); return false; }
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'x';
  const dev = (req.body && req.body.device_id) || req.query.device || 'anon';
  if (!limitOk('ip:' + ip, 60, 300000) || !limitOk('dev:' + dev, 40, 300000)) { res.status(429).json({ error: 'slow down' }); return false; }
  return true;
}

/* ---------- SUPABASE REST ---------- */
async function sb(path, method = 'GET', body = null, params = '', prefer = 'return=representation') {
  if (!SB_URL || !SB_KEY) return null;
  try {
    const res = await fetch(`${SB_URL}/rest/v1/${path}${params}`, {
      method,
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: prefer },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) { console.error('sb', path, res.status); return null; }
    const t = await res.text(); return t ? JSON.parse(t) : [];
  } catch (e) { console.error('sb', e.message); return null; }
}
const logEvent = (device_id, event, mode) => sb('events', 'POST', { device_id, event, mode });

/* ---------- RED FLAGS (deterministic, pre-model) ---------- */
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

/* ---------- VOICE ---------- */
const VOICE = `You are Sorted — the sorted elder brother for men 18-45. Warm, direct, zero judgment, slightly wry. Replies 2-6 lines max. Never flatter falsely. Never shame. No numeric scores ever. One question at a time, only if needed.
LANGUAGE: default to clean, natural English only. Use Hindi/Hinglish words ONLY if his profile language is 'hinglish' or he himself writes Hindi/Hinglish first — then mirror lightly. Never open in Hinglish.
IF HE MENTIONS GEMINI/CHATGPT/ANY OTHER AI: never needy, never bash them, and NEVER wave him off (phrases like "no need to come back" are forbidden). One confident line on what is different here — you remember HIS face, wardrobe and wins; you check on him afterwards; his private questions are not sitting in a big-tech account under his real name; your India product answers are verified — then simply continue being useful on his actual need. You are the friend, not a vendor chasing a sale.
IF HE DERAILS, TESTS OR ROLEPLAYS: stay Sorted, one light deflection, bring it back to what he needs. Never break character, never get defensive, never capitulate.
CAPABILITIES: you cannot generate or edit images and cannot browse the web. If asked, say so in ONE short line, then immediately offer the strongest thing you CAN do for that need (e.g. exact search terms to find reference photos + your specific instructions). Never apologize twice.
LOCAL CONTEXT: always price things in the currency of HIS city (from profile): India → ₹, UAE/Dubai → AED, Saudi → SAR, US → $, UK → £, etc. Match shops to his city too (Dubai → Noon/Amazon.ae/Carrefour/pharmacy; India → Amazon.in/Nykaa/local chemist). NEVER quote ₹ to a man whose city is outside India. If city unknown, ask once or give currency-neutral advice.
NEARBY / WHERE TO BUY: you have no maps or GPS — never pretend otherwise, but never dead-end him either. When he asks where to get something nearby, give him a tappable link in EXACTLY this form: https://www.google.com/maps/search/pharmacy+near+me (or e.g. https://www.google.com/maps/search/benzoyl+peroxide+pharmacy). His own phone finds the nearest one — more private than us tracking him, and you can say so with a wink. Tell him the exact word to say at the counter.`;

/* ---------- MODE PROMPTS ---------- */
const PROMPTS = {
  verdict: `${VOICE}
You judge outfits from a photo + occasion. Understand Indian dress codes (kurta, sherwani, bandhgala, office, festival).
THE PROBLEM OF PLENTY: his real pain is too many choices. If the photo shows a wardrobe, a pile, or several garments — or he lists several options — CHOOSE FOR HIM: verdict "WEAR THIS", reasons name the exact items ("the navy kurta, third from left"), fix gives the complete head-to-toe combination. ONE answer. Never a menu, never "either works".
Respond ONLY with JSON:
{"type":"verdict","verdict":"READY"|"ALMOST"|"NOT THIS ONE"|"WEAR THIS"|"CAN'T TELL",
 "reasons":["max 3, specific, reference what you SEE and his profile"],
 "fix":"1-2 concrete actions, or empty if READY (then a confident send-off)",
 "memory_note":"short note worth remembering or null","skinTone":"if clearly inferable else null","faceShape":null,
 "followup":"one short line inviting the loop to close, or null"}
If photo too dark/blurry/absent → CAN'T TELL, blame the light never the man, ask for a retake. Most verdicts should be ALMOST with a sharp fix. Use his profile and SAY so ("your skin tone").`,

  private: `${VOICE}
PRIVATE SPACE — men's sensitive health (groin, skin, sweat, hair fall, weight, bloating, performance anxiety). Calm, factual, normalizing. NO emojis except at most one 🤝.
EDUCATION ONLY — never diagnosis, never prescription drugs/doses, never interpret lesions from photos (send him to a derm for anything visible that changes). Structure: (1) normalize with an honest stat, (2) plain-language likely CATEGORY, (3) practical self-care this week incl. OTC CATEGORY ("an antifungal dusting powder — ask the pharmacy", priced in HIS city's currency), (4) the doctor line.
Respond ONLY with JSON:
{"type":"private","reply":"main reply, 3-7 lines",
 "doctor":{"action":"when/what doctor + honest ₹ cost","script":"exact words he can say","cost":"₹ range"} or null,
 "red_flag":false}
Include "doctor" whenever symptoms are 2+ weeks old, worsening, or he is delaying. Honest cost guidance by HIS city: India derm ₹500-800 / GP ₹300-500; UAE derm AED 250-500 / GP AED 100-250; elsewhere local equivalents.`,

  product: `${VOICE}
PRODUCT TRUTH — men's grooming products. Read labels from photos or answer product questions. Be blunt about marketing claims. Never invent ingredients you cannot see — if unsure say what you'd check and lower confidence. No fear-mongering (parabens are legal and low-risk; state preferences honestly).
Respond ONLY with JSON:
{"type":"product","name":"product name or null","price":"₹ or null",
 "flags":[{"ok":true/false,"label":"e.g. Aluminium salts / Paraben-free"}],
 "note":"1-3 blunt sentences incl. claim-check",
 "alternatives":[{"name":"","price":"₹ approx","flags":["max 3 short positives"]}],
 "confidence":"verified-list"|"label-read"|"general-knowledge"}
If VERIFIED PRODUCT DATA is provided, prefer it and set confidence "verified-list". Text questions: max 2 recommendations + 1 pattern to avoid.`,

  barber: `${VOICE}
BARBER CARD. From a selfie and/or description recommend ONE haircut (+beard treatment) that suits him. Practical barbershop language.
Respond ONLY with JSON:
{"type":"barber","style":"e.g. 'Mid Fade · Scissor Top'",
 "steps":["3-4 exact instructions with clipper numbers"],
 "hinglish":"one line to say aloud at the shop — in ENGLISH by default; Hindi only if his language is hinglish",
 "note":"one short encouraging line or maintenance tip"}
No selfie: ask ONE question OR give a safe versatile recommendation. Never invent face-shape claims without a photo. You cannot show generated preview images — if asked, give exact Google/Pinterest search terms instead, in one line.`,

  profile: `${VOICE}
PROFILE SCAN. From this one selfie, read what helps style advice. Be kind and factual; no scores, no attractiveness judgment.
Respond ONLY with JSON:
{"type":"profile","skinTone":"e.g. 'warm, medium-deep'","undertone":"warm|cool|neutral|olive",
 "faceShape":"e.g. 'oval, strong jaw'","hair":"e.g. 'thick, straight, slight recession'","beard":"e.g. 'medium density, patchy cheeks'",
 "note":"one warm line about what this unlocks (colour picks, cut choices) — no flattery"}
If image unusable, return {"type":"profile","error":"retake","note":"kind one-liner asking for better light"}.`,
};

/* ---------- SKU CONTEXT ---------- */
async function skuContext(text) {
  if (!SB_URL || !text) return '';
  const words = (text.match(/[a-zA-Z]{4,}/g) || []).slice(0, 5);
  if (!words.length) return '';
  const q = words.map(w => `name.ilike.*${w}*`).join(',');
  const rows = await sb('sku_products', 'GET', null, `?or=(${q})&limit=3&select=name,brand,price_band,flags,claim_notes,last_verified`);
  if (!rows || !rows.length) return '';
  return '\nVERIFIED PRODUCT DATA (curated, dated — prefer this):\n' + rows.map(r =>
    `- ${r.name} (${r.brand || ''}) ${r.price_band || ''} flags:${JSON.stringify(r.flags)} notes:${r.claim_notes || ''} verified:${r.last_verified}`).join('\n');
}

/* ---------- CLAUDE ---------- */
async function askClaude(mode, messages, image, occasion, profile, extraCtx) {
  const profileCtx = profile ? `\nHIS PROFILE (use it, mention it when relevant): name:${profile.name}, language:${profile.lang || 'english'}, city:${profile.city || 'unknown'}, skinTone:${profile.skinTone || 'unknown'}, faceShape:${profile.faceShape || 'unknown'}, sizes:${profile.sizes || 'unknown'}, styleWins:${(profile.notes || []).slice(-5).join('; ') || 'none yet'}` : '';
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
    for (const m of messages) if (typeof m.content === 'string') m.content = m.content.slice(0, 4000);

    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const lastText = lastUser && typeof lastUser.content === 'string' ? lastUser.content : '';
    const flag = checkRedFlags(lastText);
    if (flag) {
      if (device_id) {
        logEvent(device_id, 'red_flag', mode);
        sb('followups', 'POST', { device_id, due_date: new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10), topic: 'urgent-followup', status: 'pending' });
      }
      return res.json({ type: 'private', red_flag: true,
        reply: "Stop — this one isn't a wait-and-watch, and I'd be a bad friend if I pretended otherwise.",
        doctor: { action: flag.action, script: flag.script, cost: '' } });
    }

    const extraCtx = mode === 'product' ? await skuContext(lastText) : '';
    const data = await askClaude(mode, messages, image, occasion, profile, extraCtx);
    if (device_id) {
      logEvent(device_id, mode === 'verdict' ? 'verdict_given' : mode + '_used', mode);
      if (mode === 'private' && data.doctor) {
        sb('followups', 'POST', { device_id, due_date: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10), topic: 'health-followup', status: 'pending' });
      }
    }
    res.json(data);
  } catch (e) { console.error(e.message); res.status(500).json({ error: 'upstream' }); }
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

/* ---------- PUSH ---------- */
app.post('/push/subscribe', async (req, res) => {
  if (!gate(req, res)) return;
  const { device_id, sub } = req.body || {};
  if (!device_id || !sub || !sub.endpoint) return res.status(400).json({ error: 'bad sub' });
  await sb(`push_subs?device_id=eq.${encodeURIComponent(device_id)}`, 'DELETE');
  await sb('push_subs', 'POST', { device_id, sub });
  if (device_id) logEvent(device_id, 'push_enabled', null);
  res.json({ ok: true });
});

/* ---------- CROWD CHECK ---------- */
app.post('/polls', async (req, res) => {
  if (!gate(req, res)) return;
  const { device_id, question, img } = req.body || {};
  if (!device_id || !img || img.length > 400000) return res.status(400).json({ error: 'bad poll' });
  const open = await sb('polls', 'GET', null, `?device_id=eq.${encodeURIComponent(device_id)}&status=eq.open&select=id`);
  if (open && open.length >= 2) return res.status(429).json({ error: 'max 2 open polls' });
  const row = await sb('polls', 'POST', { device_id, question: String(question || 'This look — yes or no?').slice(0, 140), img });
  logEvent(device_id, 'poll_created', 'crowd');
  res.json({ ok: true, id: row && row[0] && row[0].id });
});

app.get('/polls/feed', async (req, res) => {
  if (!gate(req, res)) return;
  const d = req.query.device || '';
  const polls = await sb('polls', 'GET', null, `?status=eq.open&device_id=neq.${encodeURIComponent(d)}&order=created_at.desc&limit=20&select=id,question,img,created_at`);
  const votes = await sb('poll_votes', 'GET', null, `?device_id=eq.${encodeURIComponent(d)}&select=poll_id`);
  const voted = new Set((votes || []).map(v => v.poll_id));
  res.json((polls || []).filter(p => !voted.has(p.id)).slice(0, 1));
});

app.get('/polls/mine', async (req, res) => {
  if (!gate(req, res)) return;
  const d = req.query.device || '';
  const rows = await sb('polls', 'GET', null, `?device_id=eq.${encodeURIComponent(d)}&order=created_at.desc&limit=1&select=id,question,votes_yes,votes_no,status,created_at`);
  res.json(rows || []);
});

app.post('/polls/vote', async (req, res) => {
  if (!gate(req, res)) return;
  const { poll_id, device_id, vote } = req.body || {};
  if (!poll_id || !device_id || !['yes', 'no'].includes(vote)) return res.status(400).json({ error: 'bad vote' });
  const existing = await sb('poll_votes', 'GET', null, `?poll_id=eq.${poll_id}&device_id=eq.${encodeURIComponent(device_id)}&select=poll_id`);
  if (existing && existing.length) return res.json({ ok: true, dup: true });
  await sb('poll_votes', 'POST', { poll_id, device_id, vote });
  const p = await sb('polls', 'GET', null, `?id=eq.${poll_id}&select=votes_yes,votes_no`);
  if (p && p[0]) await sb(`polls?id=eq.${poll_id}`, 'PATCH', vote === 'yes' ? { votes_yes: p[0].votes_yes + 1 } : { votes_no: p[0].votes_no + 1 });
  logEvent(device_id, 'poll_voted', 'crowd');
  res.json({ ok: true });
});

/* ---------- CRON (called by GitHub Actions schedule) ---------- */
app.post('/cron/run', async (req, res) => {
  if (!CRON_SECRET || req.headers['x-cron-secret'] !== CRON_SECRET) return res.status(401).json({ error: 'no' });
  let pushed = 0;
  const due = await sb('followups', 'GET', null, `?status=eq.pending&notified=eq.false&due_date=lte.${new Date().toISOString().slice(0, 10)}&select=id,device_id`) || [];
  if (webpush && due.length) {
    const subs = await sb('push_subs', 'GET', null, '?select=device_id,sub') || [];
    const map = Object.fromEntries(subs.map(s => [s.device_id, s.sub]));
    for (const f of due) {
      const sub = map[f.device_id];
      if (sub) {
        try { await webpush.sendNotification(sub, JSON.stringify({ t: 'Sorted', b: 'Sorted has a thought.' })); pushed++; }
        catch (e) { if (e.statusCode === 410 || e.statusCode === 404) await sb(`push_subs?device_id=eq.${encodeURIComponent(f.device_id)}`, 'DELETE'); }
      }
      await sb(`followups?id=eq.${f.id}`, 'PATCH', { notified: true });
    }
  }
  const cutoff = new Date(Date.now() - 24 * 3600e3).toISOString();
  await sb(`polls?status=eq.open&created_at=lt.${cutoff}`, 'PATCH', { status: 'closed', img: null }); // photos auto-purge at close
  res.json({ ok: true, due: due.length, pushed });
});

/* ---------- AI HAIRSTYLE PREVIEW (Gemini image / nano banana) ---------- */
const GEMINI_KEY = process.env.GEMINI_API_KEY;
app.post('/preview', async (req, res) => {
  try {
    if (!gate(req, res)) return;
    if (!GEMINI_KEY) return res.status(503).json({ error: 'preview not configured' });
    const { device_id, image, style } = req.body || {};
    if (!image || !image.data) return res.status(400).json({ error: 'need photo' });
    if (!limitOk('preview:' + (device_id || 'x'), 3, 86400000)) return res.status(429).json({ error: 'daily limit' });
    const prompt = `Edit this photo: change ONLY the hair and beard to: ${String(style || 'a clean modern haircut').slice(0, 300)}. Keep the person's face, identity, skin tone, expression, clothing and background exactly the same. Photorealistic, natural lighting.`;
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GEMINI_KEY}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: image.media_type || 'image/jpeg', data: image.data } }, { text: prompt }] }] }),
    });
    if (!r.ok) throw new Error('gemini ' + r.status + ' ' + (await r.text()).slice(0, 180));
    const out = await r.json();
    const parts = (out.candidates && out.candidates[0] && out.candidates[0].content && out.candidates[0].content.parts) || [];
    const imgPart = parts.find(p => p.inline_data || p.inlineData);
    if (!imgPart) return res.status(502).json({ error: 'no image returned' });
    const d = imgPart.inline_data || imgPart.inlineData;
    if (device_id) logEvent(device_id, 'preview_used', 'barber');
    res.json({ ok: true, img: `data:${d.mime_type || d.mimeType || 'image/png'};base64,${d.data}` });
  } catch (e) { console.error(e.message); res.status(500).json({ error: 'preview failed' }); }
});

app.get('/health', (_, res) => res.json({ ok: true, db: !!SB_URL, push: !!webpush, preview: !!GEMINI_KEY }));

app.listen(PORT, () => console.log(`SORTED backend v2 on :${PORT} · model ${MODEL} · db ${SB_URL ? 'on' : 'off'} · push ${webpush ? 'on' : 'off'} · photos never stored`));
