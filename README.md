# SIPDPS Harvester — Vercel Serverless

Refactored from Express to Vercel Serverless Functions.

## Project Structure

```
sipdps-vercel/
├── api/
│   ├── auth/
│   │   ├── login.js        POST /api/auth/login
│   │   └── [action].js     POST /api/auth/logout
│   │                       GET  /api/auth/status
│   │                       GET  /api/auth/debug
│   └── scrape/
│       ├── start.js        POST /api/scrape/start
│       └── [action].js     GET  /api/scrape/provinces
│                           GET  /api/scrape/progress/:jobId
│                           GET  /api/scrape/download/:jobId
│                           GET  /api/scrape/preview
│                           GET  /api/scrape/kabupaten/:provId
│                           GET  /api/scrape/kabupaten-select/:provId
│                           GET  /api/scrape/debug
├── lib/
│   ├── kv.js               Vercel KV wrapper + in-memory fallback
│   ├── session.js          Cookie sessions backed by KV
│   ├── scraper-helpers.js  HTTP fetch + HTML parse helpers
│   └── excel-builder.js    ExcelJS workbook builders
├── public/
│   └── index.html          (copy your existing index.html here)
├── .env.example
├── package.json
└── vercel.json
```

## What Changed from Express

| Before (Express)                   | After (Vercel)                             |
|------------------------------------|--------------------------------------------|
| `express-session` (in-memory)      | KV-backed cookie sessions (`lib/session.js`) |
| `const jobs = {}` (in-memory)      | KV store with 6-hour TTL                  |
| `index.js` single server entry     | One file per route under `api/`            |
| `routes/auth.js` + `routes/scrape.js` | `api/auth/` + `api/scrape/`             |
| `app.use(express.static(...))`     | Vercel serves `public/` automatically      |

## Deployment

### 1. Install Vercel CLI
```bash
npm i -g vercel
```

### 2. Create a Vercel KV database
In the Vercel dashboard → Storage → Create Database → KV (Redis).
Link it to your project — this auto-injects `KV_REST_API_URL` and `KV_REST_API_TOKEN`.

### 3. Set environment variables
In Vercel dashboard → Project → Settings → Environment Variables:
```
WEB_PASSWORD   your-secret-web-password
```
KV vars are injected automatically after linking the store.

### 4. Deploy
```bash
cd sipdps-vercel
vercel deploy --prod
```

### 5. Local development
```bash
cp .env.example .env.local
# Fill in WEB_PASSWORD; KV vars optional (uses in-memory fallback)
npm install
vercel dev
```

## Important: Function Duration Limits

Vercel Pro allows 300 s per function (set in `vercel.json`).
- **national / provinsi** scope: typically finishes in < 60 s → fine.
- **semua** scope (all 38 provinces × kabupaten × kecamatan): can take 10–30+ minutes — **exceeds Vercel limits**.

### Options for long-running scrapes:
1. **Reduce scope**: scrape per-province instead of all at once.
2. **Vercel Cron + Queue**: use a message queue (e.g. Upstash QStash) to break the job into province-sized chunks, each triggered by a cron or webhook.
3. **Self-hosted**: run the original Express server on a VPS/container where there are no timeouts.

## Frontend Changes Required

The frontend (`index.html`) needs one URL change for the download endpoint.
Replace:
```
/api/scrape/download/${jobId}
```
With the same path — no change needed, Vercel routes handle it.

Session cookies are now set with `HttpOnly; SameSite=Lax` — the frontend does not need to handle them manually.
