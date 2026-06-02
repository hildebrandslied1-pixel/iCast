---
name: Railway deployment
description: How to deploy to Railway
---

- `Dockerfile` at repo root — multi-stage build, copies only needed artifacts
- `railway.json` — references Dockerfile, healthcheck at `/api/healthz`, restart on failure
- Required env vars on Railway: `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `PORT` (set automatically by Railway)
- Optional: `OPENAI_API_KEY` (Whisper), `DEEPSEEK_API_KEY` (summaries), `SESSION_SECRET`
- `.env.example` documents all variables
- Railway sets `PORT` automatically — the app already reads `process.env.PORT`

**Why:** Railway needs explicit Dockerfile path and healthcheck path to manage the service.

**How to apply:** Push to GitHub, connect repo in Railway dashboard, set env vars, deploy.
