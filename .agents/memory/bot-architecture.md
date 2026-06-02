---
name: Bot architecture decisions
description: Key non-obvious decisions for the Telegram podcast bot
---

- ESM project (`"type": "module"`) — all imports inside bot must use `.js` extension even for `.ts` source files
- `@swc/helpers` must be in `dependencies` (not devDependencies) because `pdfkit` → `fontkit` requires it at runtime
- `@swc/helpers` missing = `MODULE_NOT_FOUND` crash at startup, not at build time
- Bot uses polling (`polling: true`), not webhooks — simpler for both dev and prod
- Sessions stored in in-memory Map — fine for single-process; not HA-safe
- AI now uses **Groq** (not OpenAI/DeepSeek): `groq-sdk` package, env var `GROQ_API_KEY`
  - Whisper: `groq.audio.transcriptions.create` + `toFile()` helper from groq-sdk
  - Chat/summaries: `llama-3.3-70b-versatile` and `llama-3.1-8b-instant`
  - Response type must be cast `as any` when `response_format: "text"` — TS thinks it's `never`
- Feed caching: `lru-cache` (100 entries, 10min TTL) in `rss.ts`; `fetchFeed(url, skipCache)` signature
- Poller uses `node-schedule` `scheduleJob("*/15 * * * *", fn)` pattern
- All Telegram messages use `parse_mode: "MarkdownV2"` — all user text must go through `esc()`
- `progress` field in DB is 0.0–1.0 float; `normEp()` helper multiplies by 100 before passing to formatter
- DB new tables: `user_prefs`, `bookmarks`, `ratings` — push with `pnpm --filter @workspace/db run push`
- Lib packages must be built (`tsc -p tsconfig.json`) before `pnpm run typecheck` works in api-server
- Keyboard arrays typed explicitly as `TelegramBot.InlineKeyboardButton[][]` when mixing map() with homeRow() push

**Why:** pdfkit/fontkit are CJS packages that use SWC helpers at runtime. Missing them causes a crash that looks unrelated to PDF.

**How to apply:** If adding any new CJS package that crashes on start with `Cannot find module '@swc/helpers/...'`, add `@swc/helpers` to dependencies.
