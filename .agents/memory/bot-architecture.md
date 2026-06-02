---
name: Bot architecture decisions
description: Key non-obvious decisions for the Telegram podcast bot
---

- ESM project (`"type": "module"`) — all imports inside bot must use `.js` extension even for `.ts` source files
- `@swc/helpers` must be in `dependencies` (not devDependencies) because `pdfkit` → `fontkit` requires it at runtime
- `@swc/helpers` missing = `MODULE_NOT_FOUND` crash at startup, not at build time
- Bot uses polling (`polling: true`), not webhooks — simpler for both dev and prod
- Sessions stored in in-memory Map — fine for single-process; not HA-safe
- `openai` package used for both Whisper (OpenAI key) and DeepSeek (DeepSeek key + custom baseURL)

**Why:** pdfkit/fontkit are CJS packages that use SWC helpers at runtime. Missing them causes a crash that looks unrelated to PDF.

**How to apply:** If adding any new CJS package that crashes on start with `Cannot find module '@swc/helpers/...'`, add `@swc/helpers` to dependencies.
