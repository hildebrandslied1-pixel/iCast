# بودكاست بوت — Podcast Telegram Bot

بوت تيليغرام متكامل لإدارة البودكاست — إضافة، تصفح، وتتبع الحلقات مباشرة من تيليغرام.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server + Telegram bot (port 8080)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required secret: `TELEGRAM_BOT_TOKEN` — Telegram bot token from @BotFather

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 + Telegram Bot (node-telegram-bot-api, polling mode)
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- RSS: rss-parser (podcast feed fetching)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/bot/` — Telegram bot code
  - `index.ts` — bot startup & polling
  - `handlers.ts` — all command/callback handlers
  - `formatter.ts` — message formatting utilities (progress bars, cards, dividers)
  - `rss.ts` — RSS/Atom feed fetching
- `lib/db/src/schema/podcast.ts` — DB schema (feeds, episodes, favorites, queue)

## Architecture decisions

- Bot uses long-polling (not webhook) for simplicity in dev; works in production too
- All messages use Markdown parse_mode with fixed-width dividers for consistent Telegram width
- Sessions stored in-memory Map for multi-step flows (add RSS, search)
- Episode pagination: 5 per page with inline keyboard navigation
- Each user identified by Telegram chatId (stored as text in DB)

## Product

- `/start` / `/help` — welcome & commands
- `/add` — add podcast via RSS/Atom URL (or just send the URL directly)
- `/feeds` — browse all subscribed podcasts, tap to see episodes
- `/latest` — latest 8 episodes across all feeds
- `/queue` — playback queue management
- `/favorites` — favorited episodes
- `/search` — search episodes by title
- `/stats` — listening stats with progress bar
- `/refresh` — refresh all feeds for new episodes

## User preferences

- Arabic UI with artful Telegram formatting (dividers, progress bars, emoji badges)
- Messages formatted for narrow Telegram width (~40 chars per line)

## Gotchas

- Run `pnpm --filter @workspace/db run push` after any schema changes
- Bot starts automatically when the API server starts
- RSS feeds are limited to 50 episodes per fetch to avoid DB bloat

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
