# SORTED — pilot web app

Private AI advisor for men. Frontend = static PWA (GitHub Pages). Backend = one Node file (holds the API key, runs the red-flag safety layer, calls Claude).

## Folder
```
app/
  index.html            ← the whole app (frontend)
  manifest.webmanifest  ← PWA manifest (Add to Home Screen)
  sw.js                 ← offline shell cache
  icon.svg              ← app icon
  server/
    server.js           ← backend: /ask endpoint, red-flag layer, Claude call
    package.json
```

## 1 · Run everything on your Mac first (10 minutes)

```bash
# backend
cd server
npm install
ANTHROPIC_API_KEY=sk-ant-...  node server.js     # http://localhost:8787

# frontend (new terminal, from the app/ folder)
python3 -m http.server 8000                       # http://localhost:8000
```
Open http://localhost:8000 on your Mac, or from your phone on the same Wi-Fi: `http://<your-mac-ip>:8000` (and set the backend, see below).

Get an API key at console.anthropic.com → API Keys. **The key lives ONLY on the server. Never put it in index.html.**

## 2 · Point the frontend at a backend

The frontend reads the backend URL from localStorage (default `http://localhost:8787`).
To change it, open the browser console on the app page once:
```js
localStorage.setItem('sorted_backend', 'https://YOUR-BACKEND-URL'); location.reload();
```

## 3 · Deploy for the 50 guys

**Frontend → GitHub Pages (free):**
1. Create repo, push the `app/` folder contents (index.html at repo root or /docs).
2. Repo Settings → Pages → deploy from branch. You get `https://you.github.io/sorted/`.

**Backend → Render.com (free tier):**
1. Push `server/` to the repo too.
2. Render → New Web Service → connect repo → root dir `server`, build `npm install`, start `node server.js`.
3. Add env var `ANTHROPIC_API_KEY`. Render gives you `https://sorted-xyz.onrender.com`.
4. Set that URL in the frontend (step 2). Done.

**Backend → your Mac instead (if you prefer self-hosting):**
```bash
brew install cloudflared
ANTHROPIC_API_KEY=sk-... node server.js &
cloudflared tunnel --url http://localhost:8787    # gives a public https URL
```
Caveats: Mac must stay awake (`caffeinate -s`), URL changes on restart (named tunnels fix this), and health-chat traffic through a home machine is worse optics than a cloud free tier. Recommended only for week-1 testing.

## 4 · Costs & safety notes
- 50 users, moderate use ≈ ₹4-10k/month in API calls (Sonnet). Set a spend limit in the Anthropic console.
- Photos: forwarded to Claude for analysis, never written to disk, never logged. Keep it that way.
- The deterministic red-flag layer in `server.js` runs BEFORE the model on every message. Do not remove it.
- Private Space chats are never persisted anywhere (client keeps them in memory only; server stores nothing).
- Before opening beyond your known 50: incorporate, get the health flows legally reviewed, and re-read blueprint tab "5. Guardrails & Compliance".

## 5 · The pilot gates (from the blueprint)
- Activation: first real question within 48h > 50%
- THE gate: D30 return with a new ask > 35%
- Health-door usage by day 60 > 20%
- Organic invites: >15% of actives share the link
Read transcripts daily (30 min), fix the worst reply of the day in `server.js` prompts. The prompts ARE the product.
