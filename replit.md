# iCast

A Telegram bot for podcast management, powered by Groq AI.

## Features

- 📻 Subscribe to any RSS/Atom podcast feed
- 🆕 Browse and play the latest episodes
- 🌍 Discover trending podcasts by country (iTunes charts)
- 🔍 Search episodes and transcripts
- 🧠 AI transcription (Groq Whisper) and summaries (Llama)
- 💬 Chat with episode content using AI
- 📝 Notes & bookmarks per episode
- ❤️ Favourites and playback queue
- 🏷 Tags/folders for organising episodes
- 📊 Listening statistics with weekly chart
- ⚙️ User preferences (auto-download, notifications, language)
- 📂 OPML import/export
- 🎵 Smart playlist generation
- 🎙 Voice search
- ⭐ Podcast ratings

## Required Environment Variables

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `DATABASE_URL` | PostgreSQL connection string |
| `GROQ_API_KEY` | Groq API key (free at console.groq.com) |
| `PORT` | Server port (set automatically by Replit) |

## Commands

```
/start      — Start here
/feeds      — My subscriptions
/latest     — Latest episodes
/add        — Add podcast via RSS
/search     — Search episodes
/queue      — Playback queue
/favourites — Favourited episodes
/stats      — My statistics
/discover   — Discover podcasts
/resume     — Continue listening
/refresh    — Refresh all feeds
/settings   — Preferences
/notes      — My notes
/tsearch    — Search transcripts
/ask        — Ask AI about episode
/playlist   — Build playlist
/import     — Import OPML
/help       — Help
/about      — About
```

## Development

```bash
pnpm dev     # start the API server
pnpm build   # build for production
```

## User Preferences

- All messages in British English
- Mobile-first message design (lines ≤ 32 chars)
- MarkdownV2 formatting throughout
- Single divider style: ──────────────
