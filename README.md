# TosVerify backend

Small Express API that connects the Paper plugin to `policy.html`. Stores
data in a single JSON file (`data.json`) — good enough for a single
Minecraft server; swap `loadDB`/`saveDB` in `server.js` for a real database
if you need more.

## Run locally

```bash
npm install
API_KEY=some-long-random-string PORT=3000 node server.js
```

## Deploy on Render (matches your existing setup)

1. Push this `backend/` folder to a GitHub repo (or a subfolder of one).
2. New Web Service on Render → connect the repo → set the root directory to `backend` if it's a subfolder.
3. Build command: `npm install`
4. Start command: `npm start`
5. Environment variables:
   - `API_KEY` — a long random string. Must match `api-key` in the plugin's `config.yml`.
   - `PORT` — Render sets this automatically, no need to set it yourself.
6. Put this service behind your `khoichon.dev` domain via Cloudflare/nginx at
   `https://khoichon.dev/mcserver/api/*`, matching the `API_BASE` used in
   `policy.html` and `api-base-url` in the plugin config.

## Routes

**Plugin-facing (require header `X-API-Key`):**
- `POST /api/plugin/session` `{uuid, username}` → `{verified}` or `{verified:false, code}`
- `GET /api/plugin/status/:uuid` → `{verified}`
- `POST /api/plugin/reset` `{uuid, username}` → `{code}` (forces unverified + fresh code)
- `POST /api/plugin/manual-verify` `{code}` → `{success, username}`

**Website-facing (public, code is the only secret):**
- `GET /api/site/lookup/:code` → `{username, quiz}` or 404
- `POST /api/site/submit` `{code, sections, answers}` → `{success}` or `{success:false, message, quiz}`

Codes expire after 30 minutes (`CODE_TTL_MS` in `server.js`). Quiz questions
live in the `QUIZ_BANK` array near the top of `server.js` — edit freely.
