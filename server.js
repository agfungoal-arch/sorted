/* SORTED backend v2 — Node 18+. Deps: express, cors, web-push.
   Env: ANTHROPIC_API_KEY (req) · MODEL · SUPABASE_URL · SUPABASE_SERVICE_KEY · PILOT_TOKEN · VAPID_PUBLIC · VAPID_PRIVATE · CRON_SECRET
   Photos pass through to Claude and are NEVER written to disk or logged. Private chats are never stored. */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
let webpush = null; try { webpush = require('web-push'); } catch (e) { console.log('web-push not installed — push disabled'); }

const app = express();
app.set('trust proxy', 1); // Render sits one proxy hop in front — makes req.ip the REAL client IP, not a client-spoofable header
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

/* ---------- DEVICE IDENTITY (silent key — no login, anonymity intact) ----------
   A device_id is only valid if it carries an HMAC signature the server issued.
   The signing key never leaves the server, so an attacker who knows a victim's
   device_id string still cannot forge a request as that device. Reuses CRON_SECRET
   as the signing key so no new env var is needed. */
const DEVICE_SIG_KEY = process.env.CRON_SECRET || process.env.PILOT_TOKEN || 'sorted-dev-fallback';
const signDevice = id => crypto.createHmac('sha256', DEVICE_SIG_KEY).update(id).digest('base64url').slice(0, 16);
const newDeviceId = () => { const id = 'd' + crypto.randomBytes(9).toString('base64url'); return id + '~' + signDevice(id); };
function deviceOk(dev) {
  if (typeof dev !== 'string') return false;
  const i = dev.lastIndexOf('~'); if (i < 1) return false;
  const id = dev.slice(0, i), sig = dev.slice(i + 1), good = signDevice(id);
  try { return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good)); } catch (e) { return false; }
}
const isLegacyId = d => typeof d === 'string' && d.length > 0 && d.indexOf('~') < 0;

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
  // Primary limit is on the REAL client IP (req.ip via trust-proxy) — rotating device_id can't dodge it.
  const ip = req.ip || 'x';
  const dev = (req.body && req.body.device_id) || req.query.device || 'anon';
  if (!limitOk('ip:' + ip, 60, 300000) || !limitOk('dev:' + dev, 40, 300000)) { res.status(429).json({ error: 'slow down' }); return false; }
  return true;
}

/* ---------- SPEND CAP (hard daily DOLLAR ceiling — all-in) ----------
   One running $ total across every paid AI call. When the next call would cross the
   cap, it's refused (503) so real spend can't exceed the ceiling. In-memory, resets at
   UTC midnight; the process stays warm during active use so the ceiling holds. Cap is
   env-tunable (DAILY_USD_CAP) so you can raise it without a code change. Per-call costs
   are deliberately CONSERVATIVE (rounded up, incl. Sonnet-5 tokenizer cushion) so actual
   spend lands under the cap, never over. Safety red-flag checks run BEFORE this and are free. */
const DAYK = () => new Date().toISOString().slice(0, 10);
const DAILY_USD_CAP = Number(process.env.DAILY_USD_CAP || 5);
const COST_USD = { text: 0.015, vision: 0.02, preview: 0.05 }; // est. $/call: text ask, photo ask, Gemini preview
let spend = { day: DAYK(), usd: 0, n: 0 };
function budgetOk(kind) {
  const d = DAYK();
  if (spend.day !== d) spend = { day: d, usd: 0, n: 0 };
  const c = COST_USD[kind] || 0.015;
  if (spend.usd + c > DAILY_USD_CAP) return false;
  spend.usd += c; spend.n++;
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
  { rx: /chest.{0,15}(pain|paining|tight|pressure|heavy)|pain.{0,10}chest|seene?.{0,10}(dard|pain|bhaari)|chhaati.{0,10}dard|can'?t breath|cannot breath|breathless|difficulty breath|out of breath|saans.{0,14}(nahi|phool|dikkat|ruk|ukhad|band)/i,
    action: 'This could be an emergency. Call 112 or get to a hospital now.',
    script: 'Chest pain / breathing difficulty — emergency.' },
  { rx: /(cough|vomit|throw.?up|ulti|khaas|khaans).{0,12}(blood|khoon)|(blood|khoon).{0,12}(cough|vomit|ulti)/i,
    action: 'This needs to be seen today — go to a doctor or hospital now, do not wait.',
    script: 'Coughing up / vomiting blood since [date].' },
  { rx: /face.{0,12}(droop|numb|weak)|(slurred|slurring).{0,10}speech|speech.{0,10}slurr|one side.{0,12}(weak|numb|paralys)|sudden.{0,12}(numb|weak).{0,12}(arm|leg|face)|worst headache of my life|sudden.{0,10}(severe|worst).{0,10}headache|thunderclap/i,
    action: 'These can be stroke signs — this is an emergency. Call 112 or get to a hospital right now.',
    script: 'Sudden facial droop / slurred speech / one-sided weakness — emergency.' },
  { rx: /suicid|kill myself|end (my life|it all)|ending it all|don'?t want to (live|be here|be alive|exist)|not want to be alive|no reason to live|jeena? nahi|jeene? ka mann nahi|marne? ka mann|marna chahta|zindagi khatam|khudkushi|khud ?kushi|(want|thoughts?|thinking|planning).{0,20}(end|kill|hurt).{0,15}(myself|my life|it all)/i,
    action: 'Talk to a human right now: Tele-MANAS 14416 (free, 24x7, confidential). You matter, and this is exactly what they are there for.',
    script: 'Tele-MANAS: 14416' },
  { rx: /mole.*(chang|grow|bleed)|(chang|grow|bleed).*mole/i,
    action: 'Dermatologist within 2 weeks. Changing moles always get checked.',
    script: 'A mole that has changed size/colour/bleeds, noticed over [period].' },
  { rx: /(unexplained|sudden).*(weight loss)|lost \d+ ?kg/i,
    action: 'GP within the week for basic tests. Usually explainable — but check.',
    script: 'Unexplained weight loss of [x] kg over [period].' },
];
// Normalize before matching: collapse letter-spacing ("c h e s t") and repeated whitespace so tricks/typos can't dodge the net.
const normFlag = t => String(t || '').replace(/(\b\w) (?=\w\b)/g, '$1').replace(/\s+/g, ' ');
const checkRedFlags = t => { const n = normFlag(t); return RED_FLAGS.find(f => f.rx.test(t) || f.rx.test(n)) || null; };

/* ---------- VOICE ---------- */
const VOICE = `You are Sorted — the sorted elder brother for men 18-45. Warm, direct, zero judgment, slightly wry. Replies 2-6 lines max. Never flatter falsely. Never shame. Never put a numeric score on HIM or his looks (a product-safety score is fine). One question at a time, only if needed.
LANGUAGE: reply in the SAME language the man uses. Default to clean, natural English. If he writes (or his profile language is) Hindi/Hinglish, Tamil, Telugu, Marathi, Bengali, Gujarati, Kannada, Malayalam, Punjabi, Urdu, Arabic — or any other language — mirror THAT language and its script naturally; never translate him back to English against his choice. Keep the same warm, direct elder-brother voice in every language. Never open in a non-English language unprompted. ALWAYS add a top-level JSON field "lang" = the language you replied in, one lowercase word (e.g. "english","hinglish","tamil","arabic").
IF HE MENTIONS GEMINI/CHATGPT/ANY OTHER AI: never needy, never bash them, and NEVER wave him off (phrases like "no need to come back" are forbidden). One confident line on what is different here — you remember HIS face, wardrobe and wins; you check on him afterwards; his private questions are not sitting in a big-tech account under his real name; your India product answers are verified — then simply continue being useful on his actual need. You are the friend, not a vendor chasing a sale.
IF HE DERAILS, TESTS OR ROLEPLAYS: stay Sorted, one light deflection, bring it back to what he needs. Never break character, never get defensive, never capitulate.
CAPABILITIES: you cannot generate or edit images and cannot browse the web. If asked, say so in ONE short line, then immediately offer the strongest thing you CAN do for that need (e.g. exact search terms to find reference photos + your specific instructions). Never apologize twice.
MEMORY: his name, city, sizes, skin tone and style wins are ALL in HIS PROFILE above — you already know them across every section. NEVER ask him for something that is already in his profile (especially his city). Asking again makes you look forgetful. Use what you have, silently.
LOCAL CONTEXT: his city is in his profile — treat it as where he lives AND shops, and price + suggest shops for THAT city. NEVER ask "which city are you in / buying in" when a city is present — just use it. Currencies: India → ₹, UAE/Dubai → AED, Saudi → SAR, US → $, UK → £, etc. Match shops too (Dubai → Noon/Amazon.ae/Carrefour; India → Amazon.in/Nykaa/local chemist). NEVER quote ₹ to a man whose city is outside India. If (and only if) profile city is literally 'unknown', ask once. If he names a DIFFERENT city in his message ("gift for my dad in Pune", "I'm in Dubai now"), use that city for this answer — and if it sounds like he has moved, tell him he can update his city under his profile (the avatar, top right).
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
INGREDIENT ENCYCLOPEDIA for men — you grade the INGREDIENTS, never the product or the brand. Read the label (photo or name) and report what's in it and what published science/regulators say. Covers: personal care, deodorant, fragrance, clothing/fabric, kitchenware, drinks, packaged food, pharmacy/OTC, supplements, Ayurvedic/herbal, household. A CATEGORY may be given.
LEGAL POSITIONING — this is non-negotiable: you are a SEARCH ENGINE over published data, NOT a critic. NEVER call a product or brand "toxic", "bad", "unsafe", and NEVER give the product/brand a score or verdict. Instead: name the ingredient, say what it is, and state what the evidence says — always DOSE-FRAMED (the dose makes the poison). Cite the body (EU SCCS, IARC, WHO, US FDA, PubChem, PubMed) and give a real official URL only when you are confident it is correct; otherwise source name only and source_url null. Never invent a classification or URL.
CALIBRATED: mark genuinely benign or beneficial ingredients as level "fine"/tag "Clean" and reassure honestly. Debunk marketing fear (parabens & sulfates at legal levels are low-risk).
PREFERENCE ENGINE: his avoidance priorities are in his profile "avoid" (e.g. hormone, acne, gut, sensitive, stimulants, clean-muscle). For each ingredient list which of HIS flags it matches — you are matching his own list, not passing judgment.
CATEGORY LENSES: DEODORANT — deodorant masks odour, antiperspirant (aluminium) blocks sweat; aluminium cancer fear is unsupported, say so. CLOTHING — natural fibres (cotton/linen/TENCEL/merino) breathe & suit sensitive skin; polyester/nylon trap odour; some finishes use PFAS/formaldehyde; factor skinType & climate. FRAGRANCE — alcohol EDT/EDP vs oil attar/oud (oil gentler, often halal); flag IFRA-restricted allergens (Lilial, Coumarin, Linalool); fakes common, never verify authenticity from a photo. AYURVEDA/HERBAL — some bhasma/herbal carry heavy-metal risk & thin evidence; note plainly. PHARMACY/SUPPLEMENTS — not medical advice; flag interactions, proprietary-blend underdosing, contamination; tell him to confirm with a pharmacist/doctor.
SWAPS are SUGGESTIVE — popular alternatives in his city/currency, "what people commonly reach for", never an endorsement.
Respond ONLY with JSON:
{"type":"product","name":"product name or null","category":"or null","summary":"one neutral line — what this product is",
 "match_count": how many ingredients hit his avoid list (0 if none set),
 "ingredients":[{"name":"e.g. Phenoxyethanol","what":"one-line plain description","level":"fine|watch|caution|avoid","tag":"Hormone watch|Skin/acne|Allergen alert|Gut-health|Hair|Heavy-metal|Stimulant|Clean","science":"what research/regulators say, dose-framed","evidence":"established|emerging|weak|debunked","source":"e.g. EU SCCS 2016 / IARC Group 2B / PubChem","source_url":"official URL or null","matches":["his avoid-flags this hits"]}],
 "clean":["benign or beneficial actives by name — niacinamide, grass-fed whey, etc."],
 "swaps":[{"name":"popular alternative","why":"why people commonly reach for it","price":"approx in his currency or null"}],
 "note":"neutral one line or null","confidence":"verified-list"|"label-read"|"general-knowledge"}
Max 5 notable ingredients, up to 3 swaps. If VERIFIED PRODUCT DATA is provided, prefer it. Add "lang".`,

  barber: `${VOICE}
GROOMING ADVISOR — his whole grooming world: haircuts/beard styles, skincare & haircare products, routines, and what actually suits HIS skin & hair type. Use his profile (skinType, hairType, skinTone, city). Recommend real brands available in HIS city, priced in HIS currency, matched to his type — never generic when you know the type.

Pick the response TYPE:
1) HAIRCUT or BEARD STYLE request → JSON:
{"type":"barber","style":"e.g. 'Mid Fade · Scissor Top'","steps":["3-4 exact instructions with clipper numbers"],"hinglish":"one line to say at the shop — ENGLISH by default; Hindi only if his language is hinglish","note":"one short tip"}
No selfie: ask ONE question OR give a safe versatile pick. Never invent face-shape claims without a photo. You cannot generate preview images here — if asked, say the app's "See it on me" button does that.

2) PRODUCT / SKIN / HAIR / ROUTINE question, OR he tells you what his barber recommended or used → JSON:
{"type":"groom","reply":"2-5 lines in your voice, answering him",
 "recommendations":[{"name":"real brand + product","why":"one line — why it fits HIS type","price":"approx in his currency","for":"e.g. oily scalp"}],
 "profile_update":{"skinType":"oily|dry|combination|sensitive|normal (omit if unknown)","hairType":"straight|wavy|curly|coily (omit if unknown)","hairConcern":"e.g. thinning, dandruff (omit if none)"},
 "note":"one optional tip or null"}
INFER his type: if he names or photographs a barber-recommended product, work out which skin/hair type that SKU targets and set profile_update — but treat it as a best GUESS and CONFIRM inside reply ("that matte clay is usually for oily hair — sound right?"), never assert it as fact. Max 3 recommendations. Add "lang" as always.

CRITICAL: output EXACTLY ONE JSON object and nothing else — never plain prose. Use type:"barber" ONLY for a haircut/beard-style request; use type:"groom" for EVERYTHING else (products, skincare, haircare, routines, "is X right for me", what the barber recommended). When in doubt, use type:"groom".`,

  starbarber: `You analyze Google review snippets for a barbershop to find a standout individual barber. Respond ONLY with JSON: {"star":"first name or null","vibe":"a 5-8 word phrase summing up the shop's reputation, or null"}. Only give a name if 2 or more reviews clearly praise the SAME person by name (e.g. "ask for Rahul", "Sam is the best"). Never invent a name; if none recurs, star=null.`,

  remind: `${VOICE}
REMINDER CAPTURE. He speaks/types messy real life — often SEVERAL reminders in one breath ("buy tomatoes monday... pay kids' fee saturday... wife's birthday 27 november... mom's 10 january"). Voice transcripts are messy: run-on, misheard words, no punctuation. Parse EVERY reminder mentioned — never drop one. TODAY's date is provided — resolve all relative dates against it (next occurrence if the date already passed this year).
Respond ONLY with JSON:
{"type":"remind",
 "items":[{"title":"short clear action, his words cleaned up","person":"who it's for/about or null",
  "occasion":"birthday"|"anniversary"|"errand"|"call"|"meeting"|"other",
  "due_date":"YYYY-MM-DD","due_time":"HH:MM or null","recur":"yearly"|"weekly"|"monthly"|"none",
  "lead_days": 3 for birthdays/anniversaries (gift-buying time), 1 for errands that need buying something, else 0}],
 "confirm":"one natural line listing everything you caught, elder-brother tone. If a date was ambiguous or garbled, say what you assumed."}
Birthdays/anniversaries: recur yearly. If one item is unclear, include your best guess and flag it in confirm rather than dropping it.
MAX 20 items per message. If he lists more than 20, capture the 20 most urgent/dated ones and tell him in confirm to send the rest in a second message.
Time-specific things (calls, meetings, "in 30 minutes") MUST have due_time set. If a birthday has no date ("my son's birthday"), still include it with due_date null-guess skipped — instead ask for the missing date in confirm, never invent one.
If he ALSO asks for a wish/greeting message ("best friend's 40th birthday tomorrow — give me a good message"), add "wishes":["msg1","msg2"] to the same JSON — 2 short variants, 2-3 lines each, sounding like a real man typing (zero AI-speak, no "auspicious occasion", no poems), milestone acknowledged naturally (40th hits different). If he ONLY wants a message and there's nothing to remind, return items:[] with just wishes and confirm.`,

  wish: `${VOICE}
WISH DRAFTING. Draft 2 short messages he can send for the occasion (birthday/anniversary etc.), given who it's for, years if known, and his relationship to them.
RULES: 2-3 lines each, sound like a real man typing — warm, specific, zero AI-speak (never "on this auspicious occasion", no poems). Variant 1 = safe/classic, variant 2 = warmer/more personal. Match his language (English default). For wife/partner: genuine warmth. For boss/colleague: respectful, brief.
Respond ONLY with JSON: {"type":"wish","variants":["msg1","msg2"],"note":"one short optional tip or null"}`,

  gift: `${VOICE}
GIFT SUGGESTIONS. Given who it's for, the occasion, years (e.g. 25th anniversary carries weight), his city (culture + currency) and his budget, suggest gifts.
RULES: MAX 3 ideas, each with a one-line "why this works" — decisive, not a catalog. Localize to his culture and price in HIS currency. Practical and buyable (things findable on local e-commerce or nearby shops), not exotic. If years/occasion suggests significance (10th, 25th), acknowledge it.
Respond ONLY with JSON: {"type":"gift","ideas":[{"name":"","why":"","price":"approx in his currency"}],"note":"one short line or null"}`,

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
  const profileCtx = profile ? `\nHIS PROFILE (use it, mention it when relevant): name:${profile.name}, language:${profile.lang || 'english'}, city:${profile.city || 'unknown'}, skinTone:${profile.skinTone || 'unknown'}, skinType:${profile.skinType || 'unknown'}, hairType:${profile.hairType || 'unknown'}, hairConcern:${profile.hairConcern || 'none noted'}, faceShape:${profile.faceShape || 'unknown'}, sizes:${profile.sizes || 'unknown'}, avoid:${(profile.avoid || []).join('/') || 'none set'}, styleWins:${(profile.notes || []).slice(-5).join('; ') || 'none yet'}` : '';
  const sys = PROMPTS[mode] + profileCtx + `\nTODAY: ${new Date().toISOString().slice(0, 10)}` + (occasion ? `\nOCCASION: ${occasion}` : '') + (extraCtx || '');
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
    body: JSON.stringify({ model: MODEL, max_tokens: mode === 'remind' ? 2400 : 900, system: sys, messages: apiMessages }),
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

    // Paid call from here — enforce the daily spend ceiling (safety red-flags above are free and already handled).
    const hasImg = !!(image && image.data);
    if (hasImg && String(image.data).length > 1500000) return res.status(413).json({ error: 'image too large' });
    if (!budgetOk(hasImg ? 'vision' : 'text')) return res.status(503).json({ error: "Sorted's hit its safety limit for today — try again tomorrow." });

    const catCtx = mode === 'product' && req.body.category ? `\nCATEGORY he's checking: ${String(req.body.category).slice(0, 30)} — apply that lens.` : '';
    const extraCtx = mode === 'product' ? (await skuContext(lastText)) + catCtx
      : mode === 'remind' && req.body.local_now
        ? `\nNOW (his local clock): ${String(req.body.local_now).slice(0, 40)} — resolve relative times ("in 30 minutes", "tonight", "tomorrow morning") against THIS, and always set due_time for them.`
        : '';
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
  const { device_id, vote } = req.body || {};
  const poll_id = parseInt(req.body && req.body.poll_id, 10); // numeric only — blocks PostgREST filter injection
  if (!Number.isInteger(poll_id) || !device_id || !['yes', 'no'].includes(vote)) return res.status(400).json({ error: 'bad vote' });
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

  // reminders: lead-time + day-of pushes, then advance recurring dates
  let remPushed = 0;
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 15 * 864e5).toISOString().slice(0, 10);
  const rems = await sb('reminders', 'GET', null, `?status=eq.active&due_date=lte.${soon}&select=id,device_id,due_date,lead_days,recur,notified_lead,notified_day&limit=500`) || [];
  if (rems.length) {
    const subs2 = await sb('push_subs', 'GET', null, '?select=device_id,sub') || [];
    const map2 = Object.fromEntries(subs2.map(s => [s.device_id, s.sub]));
    for (const r of rems) {
      const leadDate = new Date(new Date(r.due_date) - (r.lead_days || 0) * 864e5).toISOString().slice(0, 10);
      let patch = null;
      if (!r.notified_day && r.due_date <= today) patch = { notified_day: true };
      else if (!r.notified_lead && leadDate <= today && r.due_date > today) patch = { notified_lead: true };
      if (patch) {
        const sub = map2[r.device_id];
        if (sub && webpush) { try { await webpush.sendNotification(sub, JSON.stringify({ t: 'Sorted', b: 'Sorted has a thought.' })); remPushed++; } catch (e) {} }
        await sb(`reminders?id=eq.${r.id}`, 'PATCH', patch);
      }
      if (r.due_date < today && r.recur && r.recur !== 'none') { // roll recurring forward
        const d = new Date(r.due_date);
        if (r.recur === 'yearly') d.setFullYear(d.getFullYear() + 1);
        else if (r.recur === 'monthly') d.setMonth(d.getMonth() + 1);
        else if (r.recur === 'weekly') d.setDate(d.getDate() + 7);
        await sb(`reminders?id=eq.${r.id}`, 'PATCH', { due_date: d.toISOString().slice(0, 10), notified_lead: false, notified_day: false });
      }
    }
  }
  res.json({ ok: true, due: due.length, pushed, remPushed });
});

/* ---------- DEVICE IDENTITY endpoints ---------- */
// Mint a fresh signed device id (client calls this once, invisibly, on first run).
app.post('/device/new', (req, res) => { if (!gate(req, res)) return; res.json({ device: newDeviceId() }); });
// One-time upgrade: move an old unsigned (legacy) device's reminders onto a new signed id.
app.post('/device/migrate', async (req, res) => {
  if (!gate(req, res)) return;
  const { old_id, new_id } = req.body || {};
  if (!deviceOk(new_id)) return res.status(403).json({ error: 'bad device' });
  if (!isLegacyId(old_id)) return res.status(400).json({ error: 'legacy only' }); // can't migrate an already-secured id
  const rows = await sb('reminders', 'GET', null, `?device_id=eq.${encodeURIComponent(old_id)}&status=eq.active&select=title,person,occasion,due_date,due_time,recur,lead_days`);
  if (rows && rows.length) {
    await sb('reminders', 'POST', rows.map(r => ({ ...r, device_id: new_id })));
    await sb(`reminders?device_id=eq.${encodeURIComponent(old_id)}`, 'PATCH', { status: 'migrated' });
  }
  res.json({ ok: true, moved: (rows || []).length });
});

/* ---------- REMINDERS (Never Forget) ---------- */
const RECURS = ['none', 'yearly', 'monthly', 'weekly'];
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
app.post('/reminders', async (req, res) => {
  if (!gate(req, res)) return;
  const { device_id, reminder, reminders } = req.body || {};
  if (!deviceOk(device_id)) return res.status(403).json({ error: 'device not recognized' });
  // accepts one reminder OR a batch — one call saves a whole voice dump. Drop rows with bad dates rather than storing junk.
  const batch = (Array.isArray(reminders) ? reminders : [reminder]).filter(r => r && r.title && isDate(r.due_date)).slice(0, 20);
  if (!batch.length) return res.status(400).json({ error: 'bad reminder' });
  const count = await sb('reminders', 'GET', null, `?device_id=eq.${encodeURIComponent(device_id)}&status=eq.active&select=id`);
  const room = 50 - ((count && count.length) || 0);
  if (room <= 0) return res.status(429).json({ error: 'max 50 active reminders — tick some off first' });
  const rows = batch.slice(0, room).map(r => ({
    device_id, title: String(r.title).slice(0, 200), person: r.person ? String(r.person).slice(0, 60) : null,
    occasion: String(r.occasion || 'other').slice(0, 20), due_date: r.due_date,
    due_time: (typeof r.due_time === 'string' && /^\d{2}:\d{2}/.test(r.due_time)) ? r.due_time.slice(0, 5) : null,
    recur: RECURS.includes(r.recur) ? r.recur : 'none', lead_days: Math.min(14, Math.max(0, parseInt(r.lead_days) || 0)),
  }));
  const out = await sb('reminders', 'POST', rows);
  logEvent(device_id, 'reminder_set', 'remind');
  res.json({ ok: true, saved: rows.length, skipped: batch.length - rows.length, id: out && out[0] && out[0].id });
});

app.get('/reminders', async (req, res) => {
  if (!gate(req, res)) return;
  const d = req.query.device;
  if (!deviceOk(d)) return res.json([]);
  const rows = await sb('reminders', 'GET', null, `?device_id=eq.${encodeURIComponent(d)}&status=eq.active&order=due_date.asc&limit=30&select=id,title,person,occasion,due_date,due_time,recur,lead_days`);
  res.json(rows || []);
});

app.post('/reminders/update', async (req, res) => {
  if (!gate(req, res)) return;
  const { id, device_id, status } = req.body || {};
  if (!deviceOk(device_id)) return res.status(403).json({ error: 'device not recognized' });
  if (id && ['done', 'deleted'].includes(status)) {
    await sb(`reminders?id=eq.${encodeURIComponent(id)}&device_id=eq.${encodeURIComponent(device_id)}`, 'PATCH', { status });
  }
  res.json({ ok: true });
});

/* ---------- AI HAIRSTYLE PREVIEW (Gemini image / nano banana) ---------- */
const GEMINI_KEY = process.env.GEMINI_API_KEY;
app.post('/preview', async (req, res) => {
  try {
    if (!gate(req, res)) return;
    if (!GEMINI_KEY) return res.status(503).json({ error: 'preview not configured' });
    const { device_id, image, style } = req.body || {};
    if (!image || !image.data) return res.status(400).json({ error: 'need photo' });
    if (String(image.data).length > 1500000) return res.status(413).json({ error: 'image too large' });
    if (!limitOk('preview:' + (device_id || 'x'), 3, 86400000)) return res.status(429).json({ error: 'daily limit' });
    if (!budgetOk('preview')) return res.status(503).json({ error: "Previews are at capacity for today — try again tomorrow." });
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

/* ---------- BARBER / GROOMING FINDER (Google Places API New) ---------- */
const PLACES_KEY = process.env.GOOGLE_PLACES_KEY;
const PRICE_LEVELS = { budget: ['PRICE_LEVEL_FREE', 'PRICE_LEVEL_INEXPENSIVE'], mid: ['PRICE_LEVEL_MODERATE'], premium: ['PRICE_LEVEL_EXPENSIVE', 'PRICE_LEVEL_VERY_EXPENSIVE'] };
app.post('/barbers', async (req, res) => {
  try {
    if (!gate(req, res)) return;
    const { lat, lng, query, city, minRating, priceBand, device_id } = req.body || {};
    const text = String(query || 'barber shop for men').slice(0, 80) + (city && !(typeof lat === 'number') ? ' ' + String(city).slice(0, 40) : '');
    if (!PLACES_KEY) return res.json({ fallback: true, mapsUrl: `https://www.google.com/maps/search/${encodeURIComponent(text)}` });
    const body = { textQuery: text, maxResultCount: 12, languageCode: 'en' };
    if (typeof lat === 'number' && typeof lng === 'number') body.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: 6000 } };
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': PLACES_KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.rating,places.userRatingCount,places.priceLevel,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber,places.location,places.googleMapsUri,places.currentOpeningHours.openNow' },
      body: JSON.stringify(body),
    });
    if (!r.ok) { console.error('places ' + r.status + ' ' + (await r.text()).slice(0, 200)); return res.json({ fallback: true, mapsUrl: `https://www.google.com/maps/search/${encodeURIComponent(text)}` }); }
    const out = await r.json();
    let places = (out.places || []).map(p => ({
      id: p.id, name: p.displayName && p.displayName.text, rating: p.rating || null, reviews: p.userRatingCount || 0,
      price: p.priceLevel || null, address: p.formattedAddress || '', phone: p.nationalPhoneNumber || p.internationalPhoneNumber || null,
      maps: p.googleMapsUri || null, openNow: p.currentOpeningHours ? p.currentOpeningHours.openNow : null,
    }));
    if (minRating) places = places.filter(p => (p.rating || 0) >= Number(minRating));
    if (priceBand && PRICE_LEVELS[priceBand]) places = places.filter(p => !p.price || PRICE_LEVELS[priceBand].includes(p.price));
    places.sort((a, b) => (b.rating || 0) * Math.log10((b.reviews || 0) + 10) - (a.rating || 0) * Math.log10((a.reviews || 0) + 10));
    if (device_id) logEvent(device_id, 'barber_search', 'barber');
    res.json({ places: places.slice(0, 6) });
  } catch (e) { console.error(e.message); res.status(500).json({ error: 'search failed' }); }
});
app.post('/barber/detail', async (req, res) => {
  try {
    if (!gate(req, res)) return;
    if (!PLACES_KEY) return res.status(503).json({ error: 'not configured' });
    const { place_id } = req.body || {};
    if (!place_id) return res.status(400).json({ error: 'need place_id' });
    const r = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(place_id)}`, {
      headers: { 'X-Goog-Api-Key': PLACES_KEY, 'X-Goog-FieldMask': 'displayName,rating,userRatingCount,nationalPhoneNumber,internationalPhoneNumber,formattedAddress,googleMapsUri,reviews' },
    });
    if (!r.ok) { console.error('details ' + r.status); return res.status(502).json({ error: 'details failed' }); }
    const p = await r.json();
    const reviews = (p.reviews || []).map(rv => (rv.text && rv.text.text) || (rv.originalText && rv.originalText.text) || '').filter(Boolean);
    let star = null, vibe = null;
    if (reviews.length && budgetOk('text')) {
      try { const d = await askClaude('starbarber', [{ role: 'user', content: reviews.join('\n---\n').slice(0, 3500) }], null, null, null, ''); star = d.star || null; vibe = d.vibe || null; } catch (e) {}
    }
    res.json({ name: p.displayName && p.displayName.text, phone: p.nationalPhoneNumber || p.internationalPhoneNumber || null, address: p.formattedAddress || '', maps: p.googleMapsUri || null, rating: p.rating || null, reviews_count: p.userRatingCount || 0, star, vibe });
  } catch (e) { console.error(e.message); res.status(500).json({ error: 'detail failed' }); }
});

app.get('/health', (_, res) => res.json({ ok: true, db: !!SB_URL, push: !!webpush, preview: !!GEMINI_KEY, barbers: !!PLACES_KEY,
  spend_today_usd: Math.round(spend.usd * 100) / 100, spend_cap_usd: DAILY_USD_CAP, calls_today: spend.n }));

app.listen(PORT, () => console.log(`SORTED backend v2 on :${PORT} · model ${MODEL} · db ${SB_URL ? 'on' : 'off'} · push ${webpush ? 'on' : 'off'} · photos never stored`));
