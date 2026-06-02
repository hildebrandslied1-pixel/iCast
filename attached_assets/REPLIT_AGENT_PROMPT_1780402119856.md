# iCast — مهمة كاملة لـ Replit Agent
# 100 تغيير مرتّب حسب الأولوية

أنت تعمل على مشروع **iCast** — بوت Telegram لمتابعة البودكاست.
المشروع موجود في الـ workspace الحالي. نفّذ كل التغييرات بالترتيب.

---

## ⚙️ القاعدة الأساسية قبل البدء

> كل رسالة Telegram يجب أن تتبع هذه القواعد:
> 1. خط فاصل واحد فقط في كل مكان: `──────────────`
> 2. لا توجد خطوط متعددة (`═══` أو `┄┄┄` أو غيرها)
> 3. كل سطر ≤ 32 حرف (mobile-first)
> 4. MarkdownV2 فقط — escape كل الرموز الخاصة

---

## 🔴 المرحلة 1: استبدال AI بـ Groq (أعلى أولوية)

### تغيير 1 — أزل OpenAI وDeepSeek
```bash
pnpm remove openai
# احذف أي import من "openai" أو "deepseek" في كل الملفات
```

### تغيير 2 — أضف groq-sdk
```bash
pnpm add groq-sdk
```

### تغيير 3 — أضف GROQ_API_KEY في .env.example
```
GROQ_API_KEY=gsk_your_key_here
```

### تغيير 4 — أعد كتابة lib/ai.ts كاملاً
استخدم هذا الهيكل الدقيق:

```typescript
import Groq from "groq-sdk";
import fs from "fs";
import path from "path";
import os from "os";

const MODELS = {
  transcribe: "whisper-large-v3",
  summarize: "llama-3.3-70b-versatile",
  chat: "llama-3.1-8b-instant",
} as const;

function getGroq(): Groq {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");
  return new Groq({ apiKey });
}

async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw new Error("unreachable");
}

export async function transcribeFile(filePath: string): Promise<string> {
  return withRetry(async () => {
    const groq = getGroq();
    const resp = await groq.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: MODELS.transcribe,
      response_format: "text",
    });
    return typeof resp === "string" ? resp : (resp as any).text ?? "";
  });
}

export async function transcribeUrl(audioUrl: string): Promise<string> {
  const tmpFile = path.join(os.tmpdir(), `icast-${Date.now()}.mp3`);
  try {
    const res = await fetch(audioUrl, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    fs.writeFileSync(tmpFile, Buffer.from(buf));
    return await transcribeFile(tmpFile);
  } finally {
    fs.unlink(tmpFile, () => {});
  }
}

export async function summarizeText(
  text: string, title: string, lang = "auto"
): Promise<string> {
  const langLine = lang === "ar" ? "أجب بالعربية فقط."
    : lang === "en" ? "Reply in English only."
    : "Reply in the same language as the text.";

  return withRetry(async () => {
    const groq = getGroq();
    const resp = await groq.chat.completions.create({
      model: MODELS.summarize,
      max_tokens: 300,
      messages: [{
        role: "user",
        content: `${langLine}\nSummarize in 100 words:\nTitle: ${title}\n\n${text.slice(0, 6000)}`
      }]
    });
    return resp.choices[0]?.message?.content?.trim() ?? "";
  });
}

export async function chatWithEpisode(
  question: string,
  title: string,
  transcript: string,
  history: Array<{role: "user"|"assistant", content: string}> = []
): Promise<string> {
  return withRetry(async () => {
    const groq = getGroq();
    const resp = await groq.chat.completions.create({
      model: MODELS.chat,
      max_tokens: 400,
      messages: [
        { role: "system", content: `You help with podcast episode: "${title}"\nTranscript:\n${transcript.slice(0, 8000)}` },
        ...history.slice(-6),
        { role: "user", content: question }
      ]
    });
    return resp.choices[0]?.message?.content?.trim() ?? "";
  });
}
```

### تغيير 5 — احذف كل استدعاءات OpenAI من handlers.ts
ابحث عن `openai` و `deepseek` واستبدلها بالدوال الجديدة من `ai.ts`.

---

## 🎨 المرحلة 2: أعد كتابة formatter.ts

### تغيير 6 — احذف كل ملف formatter.ts القديم وابدأ من صفر

```typescript
// lib/formatter.ts

export const DIV = `──────────────`;

export function esc(t: string): string {
  return t.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

export function trunc(t: string, n = 32): string {
  if (t.length <= n) return t;
  return t.slice(0, n).replace(/\s+\S*$/, "") + "…";
}

export function fmtDur(secs: number): string {
  if (!secs) return "?m";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function fmtDate(d: Date | string | null): string {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en", { day: "numeric", month: "short" });
}

export function bar(pct: number): string {
  const f = Math.round((pct / 100) * 8);
  return "█".repeat(f) + "░".repeat(8 - f);
}
```

### تغيير 7 — رسالة الترحيب welcomeMsg
```typescript
export function welcomeMsg(name: string): string {
  return [
    `🎙 *iCast*`,
    DIV,
    `مرحباً ${esc(name)} 👋`,
    ``,
    `استمع · اكتشف · تابع`,
    DIV,
    `📻 /feeds`,
    `🔍 /discover`,
    `▶️ /latest`,
  ].join("\n");
}
```

### تغيير 8 — feedCard
```typescript
export function feedCard(
  feed: { title: string; author?: string; episodeCount?: number; lastUpdated?: any },
  i?: number
): string {
  const num = i !== undefined ? `${i + 1}\\. ` : "";
  const lines = [`${num}📻 *${esc(trunc(feed.title, 28))}*`];
  if (feed.author) lines.push(`👤 ${esc(trunc(feed.author, 24))}`);
  const meta = [
    feed.episodeCount ? `🎧 ${feed.episodeCount}` : "",
    feed.lastUpdated ? `📅 ${fmtDate(feed.lastUpdated)}` : "",
  ].filter(Boolean).join("  ·  ");
  if (meta) lines.push(meta);
  return lines.join("\n");
}
```

### تغيير 9 — episodeCard
```typescript
export function episodeCard(ep: {
  title: string; feedTitle?: string;
  pubDate?: any; duration?: number | null;
  progress?: number; isPlayed?: boolean; isFavourite?: boolean;
}): string {
  const badges = [
    ep.isFavourite ? "❤️" : "",
    ep.isPlayed ? "✅" : ep.progress ? "▶️" : "",
  ].filter(Boolean).join(" ");

  const lines = [`🎙 *${esc(trunc(ep.title, 30))}*`];
  if (badges) lines.push(badges);

  const meta = [
    ep.pubDate ? fmtDate(ep.pubDate) : "",
    ep.duration ? fmtDur(ep.duration) : "",
  ].filter(Boolean).join("  ·  ");
  if (meta) lines.push(meta);
  if (ep.feedTitle) lines.push(`📻 ${esc(trunc(ep.feedTitle, 24))}`);
  if (ep.progress && !ep.isPlayed) lines.push(`${bar(ep.progress)} ${ep.progress}%`);

  return lines.join("\n");
}
```

### تغيير 10 — feedListMsg
```typescript
export function feedListMsg(feeds: any[]): string {
  if (!feeds.length) return [
    `📭 *لا توجد اشتراكات*`, DIV,
    `أضف بـ /add أو اكتشف بـ /discover`
  ].join("\n");

  return [
    `📻 *اشتراكاتك* \\(${feeds.length}\\)`,
    DIV,
    feeds.map((f, i) => feedCard(f, i)).join("\n" + DIV + "\n"),
  ].join("\n");
}
```

### تغيير 11 — episodeListMsg
```typescript
export function episodeListMsg(
  eps: any[], feedTitle?: string, page = 1, total = 1
): string {
  const header = feedTitle
    ? `🎙 *${esc(trunc(feedTitle, 24))}*`
    : `🎧 *آخر الحلقات*`;
  const pg = total > 1 ? `  ·  ${page}\\/${total}` : "";
  if (!eps.length) return [header, DIV, `لا توجد حلقات`].join("\n");
  return [
    `${header}${pg}`, DIV,
    eps.map(e => episodeCard(e)).join("\n" + DIV + "\n"),
  ].join("\n");
}
```

### تغيير 12 — statsMsg
```typescript
export function statsMsg(s: {
  feedCount: number; playedCount: number;
  totalMinutes: number; favouriteCount: number; streak?: number;
}): string {
  const h = Math.floor(s.totalMinutes / 60);
  const m = s.totalMinutes % 60;
  return [
    `📊 *إحصائياتك*`, DIV,
    `📻  ${s.feedCount} بودكاست`,
    `✅  ${s.playedCount} حلقة`,
    `⏱  ${h > 0 ? `${h}h ${m}m` : `${m}m`}`,
    `❤️  ${s.favouriteCount} مفضّلة`,
    s.streak ? `🔥  ${s.streak} أيام متتالية` : "",
  ].filter(Boolean).join("\n");
}
```

### تغيير 13 — queueMsg
```typescript
export function queueMsg(eps: any[]): string {
  if (!eps.length) return [`📭 *القائمة فارغة*`, DIV, `أضف حلقات من /latest`].join("\n");
  const list = eps.map((e, i) =>
    `${i + 1}\\. ${esc(trunc(e.title, 26))}${e.duration ? `  · ${fmtDur(e.duration)}` : ""}`
  ).join("\n");
  return [`🗂 *قائمة التشغيل* \\(${eps.length}\\)`, DIV, list].join("\n");
}
```

### تغيير 14 — searchResultsMsg
```typescript
export function searchResultsMsg(query: string, results: any[]): string {
  const q = esc(trunc(query, 20));
  if (!results.length) return [`🔍 *"${q}"*`, DIV, `لا توجد نتائج`].join("\n");
  const list = results.slice(0, 8).map((r, i) =>
    `${i + 1}\\. *${esc(trunc(r.title, 26))}*${r.author ? `\n   👤 ${esc(trunc(r.author, 20))}` : ""}`
  ).join("\n");
  return [`🔍 *"${q}"* — ${results.length}`, DIV, list].join("\n");
}
```

### تغيير 15 — رسائل التحميل والأخطاء
```typescript
export function loadingMsg(step: 0|1|2|3|4, label = "جاري التحديث"): string {
  return `⟳ ${label}\n${"█".repeat(step)}${"░".repeat(4 - Math.min(step, 4))}`;
}

export function doneMsg(label: string): string {
  return `✅ ${label}`;
}

export function errorMsg(msg: string, hint?: string): string {
  return [`⚠️ ${esc(msg)}`, hint ? esc(hint) : ""].filter(Boolean).join("\n");
}

export function addPromptMsg(): string {
  return [`📥 *إضافة بودكاست*`, DIV, `أرسل رابط RSS`, `مثال: https://feeds.example.com/feed.rss`].join("\n");
}

export function summaryMsg(title: string, summary: string): string {
  return [`✨ *ملخص*`, DIV, `🎙 ${esc(trunc(title, 30))}`, DIV, esc(trunc(summary, 500))].join("\n");
}
```

---

## 🗂 المرحلة 3: إنشاء keyboards.ts جديد

### تغيير 16 — أنشئ lib/keyboards.ts
```typescript
// lib/keyboards.ts
import type { InlineKeyboardButton } from "grammy/types";
type IRow = InlineKeyboardButton[];

export const HOME_ROW: IRow = [
  { text: "🏠 الرئيسية", callback_data: "home" }
];

export const MAIN_KEYBOARD = [
  [{ text: "📻 اشتراكاتي" }, { text: "🎧 آخر الحلقات" }],
  [{ text: "🔍 اكتشف" },     { text: "🗂 القائمة" }],
  [{ text: "❤️ المفضّلة" },  { text: "📊 إحصائيات" }],
  [{ text: "⚙️ الإعدادات" }],
];

export function feedActions(feedId: number): IRow[] {
  return [
    [
      { text: "▶️ الحلقات",  callback_data: `feed:eps:${feedId}` },
      { text: "🔄 تحديث",   callback_data: `feed:refresh:${feedId}` },
    ],
    [
      { text: "🗑 حذف",     callback_data: `feed:delete:${feedId}` },
      { text: "🏠 رئيسية", callback_data: "home" },
    ],
  ];
}

export function episodeActions(epId: number, opts: {
  isFav?: boolean; isQueued?: boolean;
  hasTranscript?: boolean; progress?: number;
} = {}): IRow[] {
  const { isFav, isQueued, hasTranscript, progress = 0 } = opts;
  return [
    [
      { text: isFav ? "❤️ مفضّلة" : "🤍 أضف", callback_data: `ep:fav:${epId}` },
      { text: isQueued ? "✅ في القائمة" : "🗂 أضف", callback_data: `ep:queue:${epId}` },
    ],
    [
      { text: progress > 0 ? `▶️ استكمال ${progress}%` : "▶️ تشغيل", callback_data: `ep:play:${epId}` },
      { text: "⬇️ تنزيل", callback_data: `ep:download:${epId}` },
    ],
    hasTranscript ? [
      { text: "📝 النص", callback_data: `ep:transcript:${epId}` },
      { text: "✨ ملخص", callback_data: `ep:summary:${epId}` },
    ] : [
      { text: "✨ توليد ملخص", callback_data: `ep:summarize:${epId}` },
      { text: "📝 نص AI", callback_data: `ep:transcribe:${epId}` },
    ],
    [{ text: "🔙 رجوع", callback_data: `ep:back:${epId}` }],
  ];
}

export function paginationRow(prefix: string, page: number, total: number): IRow {
  const row: IRow = [];
  if (page > 1) row.push({ text: "◀️", callback_data: `${prefix}:page:${page - 1}` });
  row.push({ text: `${page} / ${total}`, callback_data: "noop" });
  if (page < total) row.push({ text: "▶️", callback_data: `${prefix}:page:${page + 1}` });
  return row;
}

export function confirmRow(confirmData: string, cancelData = "home"): IRow[] {
  return [[
    { text: "✅ تأكيد", callback_data: confirmData },
    { text: "❌ إلغاء", callback_data: cancelData },
  ]];
}

export function queueItemActions(epId: number, pos: number, total: number): IRow[] {
  return [[
    pos > 1    ? { text: "⬆️", callback_data: `queue:up:${epId}` }   : { text: "·", callback_data: "noop" },
    { text: "▶️", callback_data: `ep:play:${epId}` },
    pos < total ? { text: "⬇️", callback_data: `queue:down:${epId}` } : { text: "·", callback_data: "noop" },
  ], [
    { text: "🗑 إزالة", callback_data: `queue:remove:${epId}` },
  ]];
}
```

---

## 🏗 المرحلة 4: تقسيم handlers.ts

### تغيير 17 — أنشئ مجلد lib/handlers/

### تغيير 18 — lib/handlers/commands.ts
انقل كل دوال `cmd*` من handlers.ts إلى هذا الملف:
- `cmdStart`, `cmdHelp`, `cmdAdd`, `cmdFeeds`
- `cmdLatest`, `cmdSearch`, `cmdStats`
- `cmdRefresh`, `cmdRefreshAll`
- `cmdQueue`, `cmdFavourites`, `cmdDiscover`
- `cmdSettings`

### تغيير 19 — lib/handlers/callbacks.ts
انقل كل دوال `cb*` و `routeCallback` إلى هذا الملف.

### تغيير 20 — lib/handlers/index.ts
```typescript
export { registerCommands } from "./commands";
export { registerCallbacks } from "./callbacks";

export function registerHandlers(bot: Bot) {
  registerCommands(bot);
  registerCallbacks(bot);
}
```

### تغيير 21 — استبدل handlers.ts الأصلي
```typescript
// lib/handlers.ts (الملف الأصلي يصبح مجرد re-export)
export { registerHandlers } from "./handlers/index";
```

---

## 🧩 المرحلة 5: تحسينات UX في handlers

### تغيير 22 — cmdStart: أضف onboarding تفاعلي
```typescript
async function cmdStart(ctx) {
  const name = ctx.from?.first_name ?? "صديق";
  await ctx.reply(welcomeMsg(name), {
    parse_mode: "MarkdownV2",
    reply_markup: { keyboard: MAIN_KEYBOARD, resize_keyboard: true, is_persistent: true }
  });
}
```

### تغيير 23 — cmdAdd: أضف URL validation قبل الحفظ
```typescript
// بعد إرسال الرابط، اعرض معاينة البودكاست قبل الحفظ
// رسالة: "هل تريد إضافة [اسم البودكاست]؟" + confirmRow
```

### تغيير 24 — cmdRefresh: أضف progress bar مرئي
```typescript
const msg = await ctx.reply(loadingMsg(0), { parse_mode: "MarkdownV2" });
// بعد كل feed: عدّل الرسالة بـ loadingMsg(1), loadingMsg(2)...
await ctx.api.editMessageText(chatId, msg.message_id, doneMsg("تم التحديث"));
```

### تغيير 25 — cmdLatest: أضف pagination
```typescript
// page = 1 by default, 8 episodes per page
// أضف paginationRow في الأسفل إن وجد أكثر من صفحة
```

### تغيير 26 — cmdQueue: أضف أزرار ⬆️⬇️ لإعادة الترتيب
استخدم `queueItemActions(epId, position, total)` من keyboards.ts

### تغيير 27 — أضف /resume command
```typescript
// يعرض آخر حلقة غير مكتملة (progress > 0 && !isPlayed)
bot.command("resume", async (ctx) => {
  // ابحث في DB عن آخر حلقة progress > 0
});
```

### تغيير 28 — أضف callback للـ "noop"
```typescript
bot.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());
```

### تغيير 29 — أضف "Continue Listening" في cmdStart
إذا وُجدت حلقة في منتصف التشغيل، أضفها في رسالة الترحيب.

### تغيير 30 — أضف زر Share للحلقة
```typescript
{ text: "🔗 مشاركة", callback_data: `ep:share:${epId}` }
// عند الضغط: أرسل رابط الحلقة كنص قابل للنسخ
```

---

## 🔒 المرحلة 6: الأمان والمتانة

### تغيير 31 — أضف timeout لكل fetch
```typescript
// في fetchFeed وكل مكان يستخدم fetch:
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 15_000);
const res = await fetch(url, { signal: controller.signal });
clearTimeout(timeout);
```

### تغيير 32 — أضف try/catch حول fetchFeed
```typescript
try {
  const feed = await fetchFeed(url);
} catch (err) {
  logger.error({ err, url }, "fetchFeed failed");
  return null;
}
```

### تغيير 33 — أضف LRU cache بدل Map مفتوح
```typescript
// استخدم lru-cache
import { LRUCache } from "lru-cache";
const podcastCache = new LRUCache<string, any>({
  max: 100,
  ttl: 1000 * 60 * 10, // 10 دقائق
});
```

### تغيير 34 — أضف TTL للـ sessions
```typescript
// كل session تنتهي بعد 30 دقيقة من آخر نشاط
const SESSION_TTL = 30 * 60 * 1000;
// أضف lastActive: Date في كل session
// في كل استخدام: if (Date.now() - session.lastActive > SESSION_TTL) clearSession
```

### تغيير 35 — أضف per-user rate limiting
```typescript
const rateLimits = new Map<number, number[]>(); // userId → timestamps

function checkRateLimit(userId: number, maxPerMin = 30): boolean {
  const now = Date.now();
  const times = (rateLimits.get(userId) ?? []).filter(t => now - t < 60_000);
  if (times.length >= maxPerMin) return false;
  times.push(now);
  rateLimits.set(userId, times);
  return true;
}
```

### تغيير 36 — أضف input sanitization للبحث
```typescript
// بدل: like(table.title, `%${query}%`)
// استخدم: like(table.title, sql`${"%" + query.replace(/[%_]/g, "\\$&") + "%"}`)
```

### تغيير 37 — أضف validation لـ RSS URL
```typescript
function isValidUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch { return false; }
}
```

### تغيير 38 — أضف config validation بـ zod
```typescript
import { z } from "zod";
const Config = z.object({
  BOT_TOKEN: z.string().min(20),
  GROQ_API_KEY: z.string().startsWith("gsk_"),
  DATABASE_URL: z.string(),
});
export const config = Config.parse(process.env);
```

### تغيير 39 — استخدم DB cascade deletes
```typescript
// في schema.ts — أضف onDelete: "cascade" لكل foreign keys
feedId: integer("feed_id").references(() => feedsTable.id, { onDelete: "cascade" }),
```

### تغيير 40 — أضف health check محسّن
```typescript
app.get("/health", async (req, res) => {
  const db = await checkDb();  // SELECT 1
  res.json({ status: "ok", db, uptime: process.uptime() });
});
```

---

## ✨ المرحلة 7: ميزات جديدة

### تغيير 41 — أضف /resume command (حلقة في المنتصف)
```typescript
bot.command("resume", async (ctx) => {
  const ep = await db.query.episodes.findFirst({
    where: and(
      eq(episodes.chatId, String(ctx.chat.id)),
      gt(episodes.progress, 0),
      eq(episodes.isPlayed, false)
    ),
    orderBy: desc(episodes.updatedAt)
  });
  if (!ep) return ctx.reply(errorMsg("لا توجد حلقة للاستكمال"));
  await ctx.reply(episodeCard(ep), { parse_mode: "MarkdownV2",
    reply_markup: { inline_keyboard: episodeActions(ep.id, { progress: ep.progress }) }
  });
});
```

### تغيير 42 — أضف /bookmarks command
```typescript
// يعرض الحلقات التي أضاف عليها المستخدم ملاحظات
```

### تغيير 43 — أضف callback ep:share
```typescript
bot.callbackQuery(/^ep:share:(\d+)$/, async (ctx) => {
  const ep = await getEpisode(Number(ctx.match[1]));
  await ctx.reply(`🔗 ${ep.url}`, { disable_web_page_preview: true });
  await ctx.answerCallbackQuery();
});
```

### تغيير 44 — أضف callback ep:summarize (توليد ملخص بـ Groq)
```typescript
bot.callbackQuery(/^ep:summarize:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery("⟳ جاري التوليد…");
  const ep = await getEpisode(Number(ctx.match[1]));
  const text = ep.transcript ?? ep.description ?? "";
  if (!text) return ctx.reply(errorMsg("لا يوجد نص لتلخيصه"));
  const summary = await summarizeText(text, ep.title, "ar");
  await ctx.reply(summaryMsg(ep.title, summary), { parse_mode: "MarkdownV2" });
});
```

### تغيير 45 — أضف callback ep:transcribe (Groq Whisper)
```typescript
bot.callbackQuery(/^ep:transcribe:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery("⟳ جاري التحويل…");
  const ep = await getEpisode(Number(ctx.match[1]));
  const transcript = await transcribeUrl(ep.audioUrl);
  // احفظ الـ transcript في DB
  await db.update(episodes).set({ transcript }).where(eq(episodes.id, ep.id));
  // أرسله كـ PDF أو نص مقسّم
  await sendLongText(ctx, transcript);
});
```

### تغيير 46 — أضف settings command
```typescript
bot.command("settings", async (ctx) => {
  const prefs = await getUserPrefs(ctx.chat.id);
  await ctx.reply("⚙️ *الإعدادات*\n" + DIV, {
    parse_mode: "MarkdownV2",
    reply_markup: { inline_keyboard: settingsRows(prefs) }
  });
});
```

### تغيير 47 — أضف toggle auto-download في الإعدادات
```typescript
bot.callbackQuery("settings:toggle:autoDownload", async (ctx) => {
  await toggleUserPref(ctx.chat.id, "autoDownload");
  // عدّل الرسالة بالإعدادات الجديدة
});
```

### تغيير 48 — أضف notifications preference
```typescript
// "all" | "none" | "digest"
// في poller.ts: تحقق من التفضيل قبل إرسال الإشعار
```

### تغيير 49 — أضف /discover مع categories كأزرار
```typescript
// بدل النص الجاف، أرسل inline keyboard بالتصنيفات:
// مثل: 🎙 تقنية | 🔬 علوم | 💼 أعمال | 🎭 ترفيه
```

### تغيير 50 — أضف episode chapters من RSS
```typescript
// في fetchFeed: ابحث عن <podcast:chapters> أو timestamps في الوصف
// احفظها في JSON في DB
```

---

## 📱 المرحلة 8: تحسينات UX إضافية

### تغيير 51 — أضف breadcrumb في العنوان
```
// مثلاً عند عرض حلقة:
🎙 The Daily › Episode 5
```

### تغيير 52 — أضف confirmation قبل حذف feed
```typescript
// عند ضغط زر حذف: أرسل confirmRow بدل الحذف المباشر
await ctx.editMessageText("هل تريد حذف هذا البودكاست؟\n" + feedName, {
  reply_markup: { inline_keyboard: confirmRow(`feed:confirmDelete:${feedId}`) }
});
```

### تغيير 53 — أضف "لا توجد نتائج" للـ /search بشكل أجمل
```typescript
// إذا لم توجد نتائج: اعرض اقتراحات بديلة
```

### تغيير 54 — أضف عدد الحلقات غير المقروءة في /feeds
```typescript
// بجانب كل بودكاست: 🔵 3 جديد
```

### تغيير 55 — أضف "آخر استماع" في /stats
```typescript
`🕐  آخر استماع: ${fmtDate(lastListened)}`
```

### تغيير 56 — حسّن رسائل الخطأ لتكون ناعمة
```typescript
// بدل: "❌ Feed Could Not Be Loaded"
// استخدم: "⚠️ تعذّر تحميل البودكاست\nتحقق من الرابط أو حاول لاحقاً"
```

### تغيير 57 — أضف رسالة نجاح عند إضافة feed
```typescript
await ctx.reply(addSuccessMsg(feed), { parse_mode: "MarkdownV2" });
```

### تغيير 58 — أضف رسالة نجاح عند إضافة للمفضّلة
```typescript
await ctx.answerCallbackQuery("❤️ تمت الإضافة للمفضّلة");
```

### تغيير 59 — أضف رسالة نجاح عند إضافة للقائمة
```typescript
await ctx.answerCallbackQuery("🗂 تمت الإضافة للقائمة");
```

### تغيير 60 — أضف /help محسّن مع أمثلة
```typescript
export function helpMsg(): string {
  return [
    `📖 *الأوامر*`, DIV,
    `/add — أضف بودكاست`,
    `/feeds — اشتراكاتك`,
    `/latest — آخر الحلقات`,
    `/search — ابحث`,
    `/queue — قائمة التشغيل`,
    `/favourites — المفضّلة`,
    `/stats — إحصائياتك`,
    `/discover — اكتشف جديد`,
    `/resume — استكمل الاستماع`,
    `/settings — الإعدادات`,
  ].join("\n");
}
```

---

## 🔧 المرحلة 9: تحسينات تقنية دقيقة

### تغيير 61 — انقل splitLong إلى lib/utils/text.ts
```typescript
// lib/utils/text.ts
export function splitLong(text: string, maxLen = 4096): string[] {
  const chunks: string[] = [];
  while (text.length > maxLen) {
    chunks.push(text.slice(0, maxLen));
    text = text.slice(maxLen);
  }
  if (text) chunks.push(text);
  return chunks;
}
```

### تغيير 62 — انقل sqlArr إلى lib/db/utils.ts
```typescript
// lib/db/utils.ts
export function sqlArr<T>(arr: T[]) { return arr; }
```

### تغيير 63 — استخدم node-schedule بدل setInterval في poller.ts
```typescript
import schedule from "node-schedule";
// كل 15 دقيقة:
schedule.scheduleJob("*/15 * * * *", pollFeeds);
```

### تغيير 64 — أضف staggered requests في poller
```typescript
// لا ترسل كل الطلبات دفعة واحدة:
for (let i = 0; i < feeds.length; i++) {
  await new Promise(r => setTimeout(r, i * 500)); // 500ms بين كل طلب
  pollFeed(feeds[i]).catch(err => logger.error(err));
}
```

### تغيير 65 — أضف structured logging
```typescript
import pino from "pino";
export const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
// استخدم: logger.info({ userId, feedId }, "feed refreshed")
```

### تغيير 66 — أضف requestId في كل log
```typescript
const reqId = crypto.randomUUID().slice(0, 8);
logger.info({ reqId, userId }, "action started");
```

### تغيير 67 — أضف dead letter queue للـ feeds الفاشلة
```typescript
// في DB: جدول failed_feeds (feedId, error, attempts, lastAttempt)
// إذا فشل feed 3 مرات: أوقف polling مؤقتاً
```

### تغيير 68 — أضف circuit breaker للـ fetch
```typescript
// إذا فشل نفس الـ URL أكثر من 5 مرات في ساعة: أوقف الطلبات لمدة ساعة
```

### تغيير 69 — استخدم stream upload للملفات الكبيرة
```typescript
// في downloader.ts: بدل Buffer كامل، استخدم createReadStream
await ctx.replyWithAudio({ source: createReadStream(filePath) });
```

### تغيير 70 — أضف file size check قبل التنزيل
```typescript
// HEAD request أولاً للتحقق من الحجم
const headRes = await fetch(url, { method: "HEAD" });
const size = Number(headRes.headers.get("content-length") ?? 0);
if (size > 50 * 1024 * 1024) {
  return ctx.reply(errorMsg("الملف كبير جداً", "الحد الأقصى 50 MB"));
}
```

---

## 📦 المرحلة 10: التنظيم النهائي

### تغيير 71 — أضف pnpm add node-schedule
```bash
pnpm add node-schedule
pnpm add -D @types/node-schedule
```

### تغيير 72 — أضف pnpm add lru-cache
```bash
pnpm add lru-cache
```

### تغيير 73 — أضف pnpm add zod (إن لم يكن موجوداً)
```bash
pnpm add zod
```

### تغيير 74 — حدّث package.json scripts
```json
{
  "scripts": {
    "dev": "tsx watch lib/index.ts",
    "start": "node dist/index.js",
    "build": "tsc",
    "lint": "eslint lib --ext .ts",
    "typecheck": "tsc --noEmit"
  }
}
```

### تغيير 75 — أضف .env.example محدّث
```
BOT_TOKEN=your_telegram_bot_token
GROQ_API_KEY=gsk_your_groq_key
DATABASE_URL=postgresql://...
PORT=3000
LOG_LEVEL=info
```

### تغيير 76 — أضف DB migration للـ transcript column
```typescript
// في schema.ts — أضف للـ episodes table:
transcript: text("transcript"),
progress: integer("progress").default(0),
isFavourite: boolean("is_favourite").default(false),
```

### تغيير 77 — أضف DB table للـ user_prefs
```typescript
export const userPrefsTable = pgTable("user_prefs", {
  chatId: text("chat_id").primaryKey(),
  autoDownload: boolean("auto_download").default(false),
  notifications: text("notifications").default("all"),
  language: text("language").default("ar"),
});
```

### تغيير 78 — أضف DB table للـ bookmarks
```typescript
export const bookmarksTable = pgTable("bookmarks", {
  id: serial("id").primaryKey(),
  chatId: text("chat_id"),
  episodeId: integer("episode_id").references(() => episodesTable.id, { onDelete: "cascade" }),
  note: text("note"),
  createdAt: timestamp("created_at").defaultNow(),
});
```

### تغيير 79 — أضف index على الأعمدة المستخدمة في البحث
```typescript
// في schema.ts:
titleIdx: index("episodes_title_idx").on(episodesTable.title),
chatIdIdx: index("episodes_chat_id_idx").on(episodesTable.chatId),
```

### تغيير 80 — نظّف imports في كل الملفات
ابحث عن imports غير مستخدمة وأزلها.

---

## 🎯 المرحلة 11: التحسينات البصرية الأخيرة

### تغيير 81 — استبدل كل dividers القديمة
ابحث عن:
- `═══`, `───`, `┄┄┄`, `▬▬▬`, `- - -`
وأبدلها كلها بـ `──────────────`

### تغيير 82 — تأكد أن كل رسالة تستخدم parse_mode: "MarkdownV2"
ابحث عن أي `parse_mode: "Markdown"` وحوّلها.

### تغيير 83 — أضف esc() لكل النصوص الديناميكية
أي متغير يدخل في رسالة MarkdownV2 يجب أن يمر بـ `esc()`.

### تغيير 84 — حسّن رسائل discover
```typescript
// بدل قائمة نصية: أرسل inline keyboard بـ 2 تصنيف في كل صف
```

### تغيير 85 — أضف episode number إذا وُجد في RSS
```typescript
// في episodeCard: إذا ep.episodeNumber → أضفه "EP.5"
```

### تغيير 86 — أضف "🆕 جديد" badge للحلقات الأحدث من 48 ساعة
```typescript
const isNew = ep.pubDate && (Date.now() - new Date(ep.pubDate).getTime()) < 48 * 3600 * 1000;
if (isNew) lines.push("🆕 جديد");
```

### تغيير 87 — أضف تنسيق جميل للـ PDF transcript
```typescript
// في generateTranscriptPdf:
// header: اسم الحلقة + التاريخ
// footer: "iCast · صفحة X"
// font: يدعم العربية
```

### تغيير 88 — أضف رسالة "لا توجد مفضّلة بعد"
```typescript
if (!favourites.length) return ctx.reply(
  [`❤️ *لا توجد مفضّلة*`, DIV, `اضغط 🤍 على أي حلقة`].join("\n"),
  { parse_mode: "MarkdownV2" }
);
```

### تغيير 89 — أضف رسالة "لا توجد حلقات جديدة" بعد /refresh
```typescript
if (newEpisodes === 0) {
  return ctx.reply(doneMsg("لا توجد حلقات جديدة"), { parse_mode: "MarkdownV2" });
}
await ctx.reply(doneMsg(`${newEpisodes} حلقة جديدة ✨`), { parse_mode: "MarkdownV2" });
```

### تغيير 90 — أضف /about command
```typescript
bot.command("about", ctx => ctx.reply([
  `🎙 *iCast v2\\.0*`,
  DIV,
  `بوت بودكاست مجاني`,
  `مدعوم بـ Groq AI`,
].join("\n"), { parse_mode: "MarkdownV2" }));
```

---

## 🚀 المرحلة 12: التحسينات الأخيرة

### تغيير 91 — أضف setMyCommands بالعربي
```typescript
await bot.api.setMyCommands([
  { command: "start",      description: "ابدأ هنا" },
  { command: "feeds",      description: "اشتراكاتي" },
  { command: "latest",     description: "آخر الحلقات" },
  { command: "add",        description: "أضف بودكاست" },
  { command: "search",     description: "بحث" },
  { command: "queue",      description: "قائمة التشغيل" },
  { command: "favourites", description: "المفضّلة" },
  { command: "stats",      description: "إحصائياتي" },
  { command: "discover",   description: "اكتشف بودكاست جديد" },
  { command: "resume",     description: "استكمل الاستماع" },
  { command: "refresh",    description: "تحديث الحلقات" },
  { command: "settings",   description: "الإعدادات" },
  { command: "help",       description: "المساعدة" },
]);
```

### تغيير 92 — أضف graceful shutdown
```typescript
process.on("SIGTERM", async () => {
  logger.info("Shutting down...");
  await bot.stop();
  process.exit(0);
});
```

### تغيير 93 — أضف error handler عام للبوت
```typescript
bot.catch((err) => {
  logger.error({ err: err.error, update: err.ctx?.update }, "Bot error");
});
```

### تغيير 94 — أضف catch لكل callback handlers
```typescript
// كل callback يجب أن يبدأ بـ:
try {
  await ctx.answerCallbackQuery();
  // ... المنطق
} catch (err) {
  logger.error(err);
  await ctx.answerCallbackQuery("⚠️ حدث خطأ");
}
```

### تغيير 95 — أضف logging لكل command
```typescript
// في بداية كل command handler:
logger.info({ userId: ctx.from?.id, command: "/start" }, "command received");
```

### تغيير 96 — أضف Dockerfile محسّن
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm i -g pnpm && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
CMD ["node", "dist/index.js"]
```

### تغيير 97 — أضف .dockerignore
```
node_modules
dist
.env
*.log
```

### تغيير 98 — تأكد من وجود SIGINT handler
```typescript
process.on("SIGINT", () => process.exit(0));
```

### تغيير 99 — أضف replit.md محدّث
```markdown
# iCast

بوت Telegram للبودكاست مدعوم بـ Groq AI.

## متغيرات البيئة المطلوبة
- BOT_TOKEN
- GROQ_API_KEY  
- DATABASE_URL

## التشغيل
pnpm dev
```

### تغيير 100 — تشغيل نهائي والتحقق
```bash
pnpm typecheck      # لا أخطاء TypeScript
pnpm build          # build ناجح
# اختبر يدوياً: /start, /add, /latest, /stats
```

---

---

## 🎨 المرحلة 13: الجمالية البصرية المتقدمة

### تغيير 101 — Cover Art عند الاشتراك
```typescript
// في cmdAdd بعد حفظ الـ feed:
// إذا وُجد feed.image أو feed.artwork:
if (feed.image?.url) {
  await ctx.replyWithPhoto(feed.image.url, {
    caption: `✅ *${esc(trunc(feed.title, 28))}*\n${DIV}\nتمت الإضافة بنجاح`,
    parse_mode: "MarkdownV2",
    reply_markup: { inline_keyboard: feedActions(savedFeed.id) }
  });
} else {
  await ctx.reply(addSuccessMsg(feed), { parse_mode: "MarkdownV2" });
}
```

### تغيير 102 — Thumbnail للحلقات عند sendAudio
```typescript
// في downloader.ts — أضف thumb عند إرسال الصوت:
await ctx.replyWithAudio(audioSource, {
  title: ep.title,
  performer: feed.title,
  duration: ep.duration ?? undefined,
  thumb: ep.image ?? feed.image?.url ?? undefined,
  caption: `🎙 *${esc(trunc(ep.title, 30))}*`,
  parse_mode: "MarkdownV2",
});
```

### تغيير 103 — ASCII Bar Chart في /stats
```typescript
// في statsMsg — أضف visual chart للأسبوع الأخير:
export function weeklyBarChart(dailyMins: number[]): string {
  // dailyMins = [sun, mon, tue, wed, thu, fri, sat]
  const days = ["ح", "ن", "ث", "ر", "خ", "ج", "س"];
  const max = Math.max(...dailyMins, 1);
  const bars = dailyMins.map(m => {
    const h = Math.round((m / max) * 5);
    return "█".repeat(h) + "░".repeat(5 - h);
  });
  return days.map((d, i) => `${d} ${bars[i]}`).join("\n");
}
// مثال الإخراج:
// ح █████
// ن ██░░░
// ث ███░░
```

### تغيير 104 — Celebration عند إتمام حلقة
```typescript
// في callback ep:markPlayed:
await ctx.answerCallbackQuery("🎉 أحسنت! حلقة مكتملة");
await ctx.reply(
  [`🎉 *أنهيت الحلقة\\!*`, DIV, `🎙 ${esc(trunc(ep.title, 28))}`].join("\n"),
  { parse_mode: "MarkdownV2" }
);
```

### تغيير 105 — Soft Error Messages
```typescript
// بدل كل رسائل الخطأ القاسية، استخدم هذا النمط:
export function softError(situation: string, action: string): string {
  return [`😕 ${esc(situation)}`, esc(action)].join("\n");
}
// أمثلة:
// softError("تعذّر تحميل البودكاست", "جرّب مرة أخرى لاحقاً")
// softError("الرابط غير صحيح", "تأكد من رابط RSS")
// softError("لا يوجد اتصال", "تحقق من الإنترنت")
```

### تغيير 106 — Spinner Loading Animation
```typescript
// في أي عملية تستغرق وقتاً (transcribe, download, refresh):
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinIdx = 0;

async function withSpinner(ctx, label: string, fn: () => Promise<void>) {
  const msg = await ctx.reply(`${SPINNER[0]} ${label}…`);
  const interval = setInterval(async () => {
    spinIdx = (spinIdx + 1) % SPINNER.length;
    await ctx.api.editMessageText(
      ctx.chat.id, msg.message_id,
      `${SPINNER[spinIdx]} ${label}…`
    ).catch(() => {});
  }, 400);
  try {
    await fn();
  } finally {
    clearInterval(interval);
    await ctx.api.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
  }
}
```

### تغيير 107 — Duration Visual في episodeCard
```typescript
// في episodeCard — حوّل المدة إلى شكل بصري:
export function durationVisual(secs: number): string {
  const total = Math.ceil(secs / 60); // دقائق
  if (total <= 30) return `⏱ ${total}m`;
  if (total <= 60) return `⏱ ${total}m ·${"·".repeat(Math.floor(total / 10))}`;
  return `⏱ ${fmtDur(secs)}`;
}
```

### تغيير 108 — Badge Row منظّمة في episodeCard
```typescript
// بدل badges عشوائية، صف واحد مرتّب:
// [🆕] [❤️] [▶️] [✅]  ← كل badge له معنى واحد
const badge = [
  isNew ? "🆕" : "",
  ep.isFavourite ? "❤️" : "",
  ep.progress > 0 && !ep.isPlayed ? `▶️${ep.progress}%` : "",
  ep.isPlayed ? "✅" : "",
].filter(Boolean).join("  ");
if (badge) lines.push(badge);
```

---

## 🔊 المرحلة 14: ميزات الاستماع المتقدمة

### تغيير 109 — Sleep Timer
```typescript
// أضف inline keyboard في episodeActions:
[
  { text: "🌙 15m", callback_data: `ep:sleep:${epId}:15` },
  { text: "🌙 30m", callback_data: `ep:sleep:${epId}:30` },
  { text: "🌙 60m", callback_data: `ep:sleep:${epId}:60` },
]

// callback handler:
bot.callbackQuery(/^ep:sleep:(\d+):(\d+)$/, async (ctx) => {
  const [, epId, mins] = ctx.match;
  // احفظ في DB: sleep_timer = Date.now() + mins * 60000
  await ctx.answerCallbackQuery(`🌙 مؤقت النوم: ${mins} دقيقة`);
});
```

### تغيير 110 — Playback Speed Selector
```typescript
// في episodeActions أضف صف السرعة:
[
  { text: "1×",   callback_data: `ep:speed:${epId}:1` },
  { text: "1.5×", callback_data: `ep:speed:${epId}:1.5` },
  { text: "2×",   callback_data: `ep:speed:${epId}:2` },
]

bot.callbackQuery(/^ep:speed:(\d+):(.+)$/, async (ctx) => {
  const [, epId, speed] = ctx.match;
  await saveUserPref(ctx.chat.id, "playbackSpeed", speed);
  await ctx.answerCallbackQuery(`▶️ السرعة: ${speed}×`);
});
```

### تغيير 111 — Playback Progress Sync في UI
```typescript
// في episodeCard — اعرض شريط التقدم إذا وُجد progress > 0:
if (ep.progress && ep.progress > 0 && !ep.isPlayed) {
  const watched = Math.round((ep.progress / 100) * (ep.duration ?? 0));
  const remaining = (ep.duration ?? 0) - watched;
  lines.push(`${bar(ep.progress)} ${fmtDur(remaining)} متبقي`);
}
```

### تغيير 112 — Episode Chapters من RSS
```typescript
// في lib/rss.ts — أضف parsing للـ chapters:
interface Chapter {
  time: number;  // ثواني
  title: string;
}

function parseChapters(item: any): Chapter[] {
  // ابحث عن <podcast:chapters> أو <psc:chapters>
  const chapters = item["podcast:chapters"] ?? item["psc:chapters"] ?? [];
  return chapters.map((c: any) => ({
    time: parseTimeCode(c.start ?? c.$.start ?? "0"),
    title: c.$.title ?? c.title ?? "",
  }));
}

function parseTimeCode(tc: string): number {
  const parts = tc.split(":").map(Number);
  if (parts.length === 3) return parts[0]*3600 + parts[1]*60 + parts[2];
  if (parts.length === 2) return parts[0]*60 + parts[1];
  return Number(tc);
}
```

### تغيير 113 — عرض Chapters كـ inline buttons
```typescript
// في callback ep:chapters:
export function chaptersKeyboard(chapters: Chapter[], epId: number): IRow[][] {
  return chapters.slice(0, 8).map(ch => [{
    text: `${fmtDur(ch.time)} — ${trunc(ch.title, 22)}`,
    callback_data: `ep:seek:${epId}:${ch.time}`
  }]);
}
```

### تغيير 114 — Show Notes Links
```typescript
// في episodeCard أو callback ep:links:
function extractLinks(html: string): string[] {
  const matches = html.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
  return [...new Set(matches)].slice(0, 5);
}

// أرسل الروابط كأزرار:
const links = extractLinks(ep.description ?? "");
if (links.length) {
  const linkBtns: IRow[] = links.map((url, i) => [{
    text: `🔗 رابط ${i + 1}`,
    url,
  }]);
  // أضفها لـ inline keyboard الحلقة
}
```

### تغيير 115 — Transcript Search
```typescript
// أضف command /tsearch للبحث في النصوص المحوّلة:
bot.command("tsearch", async (ctx) => {
  const query = ctx.match;
  if (!query) return ctx.reply(errorMsg("أرسل كلمة للبحث", "مثال: /tsearch تقنية"));

  const results = await db.query.episodes.findMany({
    where: and(
      eq(episodes.chatId, String(ctx.chat.id)),
      like(episodes.transcript, `%${query}%`)
    ),
    limit: 5,
  });

  if (!results.length) return ctx.reply(errorMsg("لا نتائج في النصوص"));

  const msg = [`🔍 *في النصوص: "${esc(trunc(query, 20))}"*`, DIV,
    results.map((r, i) => `${i+1}\\. ${esc(trunc(r.title, 28))}`).join("\n")
  ].join("\n");

  await ctx.reply(msg, { parse_mode: "MarkdownV2" });
});
```

---

## 🤖 المرحلة 15: ميزات AI المتقدمة

### تغيير 116 — AI Chat with Episode
```typescript
// أضف command /ask للتحدث مع محتوى الحلقة:
bot.command("ask", async (ctx) => {
  const session = getSession(ctx.chat.id);
  if (!session.currentEpisode) {
    return ctx.reply(errorMsg("لم تختر حلقة بعد", "افتح حلقة أولاً"));
  }
  const question = ctx.match;
  if (!question) return ctx.reply("أرسل سؤالك عن الحلقة");

  await withSpinner(ctx, "جاري البحث في الحلقة", async () => {
    const ep = session.currentEpisode!;
    const answer = await chatWithEpisode(question, ep.title, ep.transcript ?? ep.description ?? "");
    await ctx.reply([`💬 *${esc(trunc(question, 28))}*`, DIV, esc(answer)].join("\n"), {
      parse_mode: "MarkdownV2"
    });
  });
});
```

### تغيير 117 — Smart Recommendations
```typescript
// في /discover — أضف قسم "مقترح لك":
async function getSmartRecommendations(chatId: string): Promise<string[]> {
  const feeds = await getUserFeeds(chatId);
  const titles = feeds.map(f => f.title);
  return getRecommendations(titles, "ar"); // من ai.ts
}

// أضف في cmdDiscover:
const recs = await getSmartRecommendations(String(ctx.chat.id));
if (recs.length) {
  await ctx.reply(
    [`✨ *مقترح لك*`, DIV, recs.map((r, i) => `${i+1}\\. ${esc(r)}`).join("\n")].join("\n"),
    { parse_mode: "MarkdownV2",
      reply_markup: { inline_keyboard: recs.map((r, i) => [{
        text: `🔍 ${r}`, callback_data: `discover:search:${encodeURIComponent(r)}`
      }])}
    }
  );
}
```

### تغيير 118 — Podcast of the Day
```typescript
// في poller.ts — مرة يومياً الساعة 9 صباحاً:
schedule.scheduleJob("0 9 * * *", async () => {
  const users = await getAllActiveUsers();
  for (const user of users) {
    const prefs = await getUserPrefs(user.chatId);
    if (prefs.notifications === "none") continue;

    const feeds = await getUserFeeds(user.chatId);
    if (!feeds.length) continue;

    // اختر حلقة جديدة عشوائية
    const latest = await getLatestUnplayed(user.chatId, 1);
    if (!latest.length) continue;

    const ep = latest[0];
    const summary = ep.description
      ? await summarizeText(ep.description, ep.title, "ar")
      : null;

    const msg = [
      `☀️ *حلقة اليوم*`, DIV,
      episodeCard(ep),
      summary ? DIV + "\n" + esc(trunc(summary, 200)) : "",
    ].filter(Boolean).join("\n");

    await bot.api.sendMessage(user.chatId, msg, {
      parse_mode: "MarkdownV2",
      reply_markup: { inline_keyboard: episodeActions(ep.id) }
    }).catch(() => {});
  }
});
```

### تغيير 119 — Playlist Generation
```typescript
// أضف command /playlist:
bot.command("playlist", async (ctx) => {
  const input = ctx.match; // مثال: "30 دقيقة تقنية"
  if (!input) return ctx.reply([
    `🎵 *إنشاء قائمة تشغيل*`, DIV,
    `مثال: /playlist 30 دقيقة تقنية`
  ].join("\n"), { parse_mode: "MarkdownV2" });

  // استخرج المدة والموضوع
  const minsMatch = input.match(/(\d+)\s*دقيقة/);
  const targetMins = minsMatch ? Number(minsMatch[1]) : 30;

  // جلب حلقات غير مشغّلة
  const eps = await getUnplayedEpisodes(String(ctx.chat.id));

  // اختر حلقات تجمع قرابة targetMins
  let total = 0;
  const playlist: typeof eps = [];
  for (const ep of eps.sort(() => Math.random() - 0.5)) {
    if (total + (ep.duration ?? 0) / 60 > targetMins + 10) continue;
    playlist.push(ep);
    total += (ep.duration ?? 0) / 60;
    if (total >= targetMins) break;
  }

  if (!playlist.length) return ctx.reply(errorMsg("لا توجد حلقات متاحة"));

  // أضفها للقائمة
  for (const ep of playlist) await addToQueue(String(ctx.chat.id), ep.id);

  await ctx.reply([
    `🎵 *قائمة جديدة*`, DIV,
    `⏱ ${Math.round(total)} دقيقة · ${playlist.length} حلقات`,
    DIV,
    playlist.map((e, i) => `${i+1}\\. ${esc(trunc(e.title, 26))}`).join("\n"),
  ].join("\n"), { parse_mode: "MarkdownV2" });
});
```

### تغيير 120 — Voice Command Search
```typescript
// استقبل voice messages وابحث بها:
bot.on("message:voice", async (ctx) => {
  await withSpinner(ctx, "جاري تحويل الصوت", async () => {
    const file = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
    const transcript = await transcribeUrl(url);

    if (!transcript.trim()) {
      return ctx.reply(errorMsg("لم أفهم الصوت", "جرّب مرة أخرى"));
    }

    // ابحث في iTunes
    await ctx.reply(`🎙 سمعت: *${esc(trunc(transcript, 30))}*`, { parse_mode: "MarkdownV2" });
    await cmdSearchLogic(ctx, transcript);
  });
});
```

---

## 📝 المرحلة 16: Notes & Bookmarks

### تغيير 121 — إضافة Note لحلقة
```typescript
// في episodeActions — أضف زر:
{ text: "📝 إضافة ملاحظة", callback_data: `ep:addNote:${epId}` }

// callback handler:
bot.callbackQuery(/^ep:addNote:(\d+)$/, async (ctx) => {
  const epId = Number(ctx.match[1]);
  setSession(ctx.chat.id, { awaitingNote: epId });
  await ctx.reply([
    `📝 *إضافة ملاحظة*`, DIV, `أرسل ملاحظتك الآن`
  ].join("\n"), { parse_mode: "MarkdownV2" });
  await ctx.answerCallbackQuery();
});

// في message handler:
if (session.awaitingNote) {
  const note = ctx.message?.text;
  if (note) {
    await db.insert(bookmarksTable).values({
      chatId: String(ctx.chat.id),
      episodeId: session.awaitingNote,
      note,
    });
    clearSessionKey(ctx.chat.id, "awaitingNote");
    await ctx.reply(doneMsg("تم حفظ الملاحظة"));
  }
}
```

### تغيير 122 — عرض الـ Bookmarks
```typescript
bot.command("notes", async (ctx) => {
  const notes = await db.query.bookmarksTable.findMany({
    where: eq(bookmarksTable.chatId, String(ctx.chat.id)),
    with: { episode: true },
    orderBy: desc(bookmarksTable.createdAt),
    limit: 10,
  });

  if (!notes.length) return ctx.reply(
    [`📭 *لا توجد ملاحظات*`, DIV, `اضغط 📝 على أي حلقة`].join("\n"),
    { parse_mode: "MarkdownV2" }
  );

  const list = notes.map((n, i) =>
    `${i+1}\\. *${esc(trunc(n.episode?.title ?? "", 24))}*\n   📝 ${esc(trunc(n.note ?? "", 40))}`
  ).join("\n" + DIV + "\n");

  await ctx.reply([`📝 *ملاحظاتي*`, DIV, list].join("\n"), { parse_mode: "MarkdownV2" });
});
```

---

## 📊 المرحلة 17: Podcast Reviews & Ratings

### تغيير 123 — DB table للتقييمات
```typescript
// في schema.ts:
export const ratingsTable = pgTable("ratings", {
  id: serial("id").primaryKey(),
  chatId: text("chat_id").notNull(),
  feedId: integer("feed_id").references(() => feedsTable.id, { onDelete: "cascade" }),
  rating: integer("rating").notNull(), // 1-5
  review: text("review"),
  createdAt: timestamp("created_at").defaultNow(),
});
```

### تغيير 124 — تقييم البودكاست
```typescript
// في feedActions — أضف زر:
{ text: "⭐ تقييم", callback_data: `feed:rate:${feedId}` }

// keyboard للتقييم:
export function ratingKeyboard(feedId: number): IRow[] {
  return [[
    { text: "⭐",     callback_data: `feed:setRating:${feedId}:1` },
    { text: "⭐⭐",   callback_data: `feed:setRating:${feedId}:2` },
    { text: "⭐⭐⭐", callback_data: `feed:setRating:${feedId}:3` },
  ], [
    { text: "⭐⭐⭐⭐",   callback_data: `feed:setRating:${feedId}:4` },
    { text: "⭐⭐⭐⭐⭐", callback_data: `feed:setRating:${feedId}:5` },
  ]];
}
```

### تغيير 125 — عرض التقييم في feedCard
```typescript
// في feedCard — أضف التقييم إذا وُجد:
if (feed.rating) {
  const stars = "⭐".repeat(feed.rating);
  lines.push(stars);
}
```

---

## 🔧 المرحلة 18: التحسينات التقنية المتبقية

### تغيير 126 — OPML Import
```typescript
bot.command("import", async (ctx) => {
  await ctx.reply([
    `📂 *استيراد OPML*`, DIV, `أرسل ملف .opml`
  ].join("\n"), { parse_mode: "MarkdownV2" });
});

// استقبل الملف:
bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  if (!doc.file_name?.endsWith(".opml")) return;

  const file = await ctx.getFile();
  const url = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url);
  const xml = await res.text();

  // استخرج الـ feed URLs من OPML
  const urls = xml.match(/xmlUrl="([^"]+)"/g)
    ?.map(m => m.replace(/xmlUrl="|"/g, "")) ?? [];

  if (!urls.length) return ctx.reply(errorMsg("الملف فارغ أو غير صحيح"));

  await ctx.reply(`⟳ جاري استيراد ${urls.length} بودكاست…`);

  let added = 0;
  for (const url of urls.slice(0, 20)) { // حد أقصى 20
    try {
      await addFeed(String(ctx.chat.id), url);
      added++;
    } catch {}
  }

  await ctx.reply(doneMsg(`تم استيراد ${added} من ${urls.length}`));
});
```

### تغيير 127 — Unread Count في /feeds
```typescript
// في feedListMsg — أضف عدد الحلقات الجديدة:
export function feedCardWithUnread(
  feed: FeedMeta & { unreadCount?: number }, i?: number
): string {
  const card = feedCard(feed, i);
  if (feed.unreadCount && feed.unreadCount > 0) {
    return card + `\n🔵 ${feed.unreadCount} جديد`;
  }
  return card;
}
```

### تغيير 128 — Full-Text Search في /search
```typescript
// في cmdSearch — ابحث في العنوان + الوصف + transcript:
const results = await db.query.episodes.findMany({
  where: and(
    eq(episodes.chatId, String(ctx.chat.id)),
    or(
      like(episodes.title, `%${safeQuery}%`),
      like(episodes.description, `%${safeQuery}%`),
      like(episodes.transcript, `%${safeQuery}%`),
    )
  ),
  limit: 8,
});
```

### تغيير 129 — Weekly Streak في /stats
```typescript
// في statsMsg — أضف weekly streak:
async function calcStreak(chatId: string): Promise<number> {
  // ابحث عن أيام متتالية فيها حلقات مكتملة
  const played = await db.query.episodes.findMany({
    where: and(
      eq(episodes.chatId, chatId),
      eq(episodes.isPlayed, true)
    ),
    orderBy: desc(episodes.updatedAt),
    limit: 30,
  });

  let streak = 0;
  let currentDay = new Date();
  currentDay.setHours(0, 0, 0, 0);

  for (let i = 0; i < 30; i++) {
    const dayEps = played.filter(ep => {
      const d = new Date(ep.updatedAt!);
      d.setHours(0, 0, 0, 0);
      return d.getTime() === currentDay.getTime();
    });
    if (!dayEps.length) break;
    streak++;
    currentDay.setDate(currentDay.getDate() - 1);
  }

  return streak;
}
```

### تغيير 130 — Daily Digest Notification
```typescript
// في poller.ts — إذا كان المستخدم يريد "digest":
schedule.scheduleJob("0 18 * * *", async () => {
  const users = await getUsersByNotifPref("digest");
  for (const user of users) {
    const newEps = await getNewEpisodesToday(user.chatId);
    if (!newEps.length) continue;

    const msg = [
      `📅 *ملخص اليوم*`, DIV,
      `${newEps.length} حلقة جديدة\\:`,
      DIV,
      newEps.slice(0, 5).map((e, i) =>
        `${i+1}\\. ${esc(trunc(e.title, 26))}`
      ).join("\n"),
    ].join("\n");

    await bot.api.sendMessage(user.chatId, msg, {
      parse_mode: "MarkdownV2"
    }).catch(() => {});
  }
});
```

---

## 🧪 المرحلة 19: Testing & CI/CD

### تغيير 131 — أضف Vitest
```bash
pnpm add -D vitest
```

### تغيير 132 — unit tests للـ formatter
```typescript
// tests/formatter.test.ts
import { describe, it, expect } from "vitest";
import { esc, trunc, fmtDur, bar, DIV } from "../lib/formatter";

describe("formatter", () => {
  it("esc escapes markdown chars", () => {
    expect(esc("hello_world")).toBe("hello\\_world");
    expect(esc("test*bold*")).toBe("test\\*bold\\*");
  });

  it("trunc preserves whole words", () => {
    expect(trunc("hello world foo", 10)).toBe("hello…");
    expect(trunc("short", 10)).toBe("short");
  });

  it("fmtDur formats correctly", () => {
    expect(fmtDur(3600)).toBe("1h 0m");
    expect(fmtDur(90 * 60)).toBe("1h 30m");
    expect(fmtDur(45 * 60)).toBe("45m");
  });

  it("bar renders correct blocks", () => {
    expect(bar(0)).toBe("░░░░░░░░");
    expect(bar(100)).toBe("████████");
    expect(bar(50)).toBe("████░░░░");
  });

  it("DIV is exactly one style", () => {
    expect(DIV).toBe("──────────────");
  });
});
```

### تغيير 133 — unit tests للـ ai.ts
```typescript
// tests/ai.test.ts
import { describe, it, expect, vi } from "vitest";

describe("AI module", () => {
  it("throws if GROQ_API_KEY missing", async () => {
    delete process.env.GROQ_API_KEY;
    const { transcribeFile } = await import("../lib/ai");
    await expect(transcribeFile("/tmp/test.mp3")).rejects.toThrow("GROQ_API_KEY");
  });
});
```

### تغيير 134 — أضف GitHub Actions CI
```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
        with: { version: 8 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
```

### تغيير 135 — أضف vitest config
```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
```

---

## 📦 المرحلة 20: Semantic Versioning & Polish النهائي

### تغيير 136 — أضف CHANGELOG.md
```markdown
# Changelog

## [2.0.0] - 2025
### Added
- Groq AI بدل OpenAI/DeepSeek
- Episode chapters
- Voice command search
- Playlist generation
- Sleep timer
- Podcast ratings
- Notes & bookmarks
- OPML import
- Daily digest
- Weekly streak
- Transcript search
- Smart recommendations

### Changed
- formatter.ts مكتوب من صفر
- خط فاصل واحد فقط
- رسائل mobile-first
- handlers.ts مقسّم

### Removed
- openai dependency
- DeepSeek dependency
```

### تغيير 137 — حدّث version في package.json
```json
{ "version": "2.0.0" }
```

### تغيير 138 — أضف eslint config
```bash
pnpm add -D eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin
```
```json
// .eslintrc.json
{
  "parser": "@typescript-eslint/parser",
  "plugins": ["@typescript-eslint"],
  "rules": {
    "@typescript-eslint/no-unused-vars": "error",
    "@typescript-eslint/no-explicit-any": "warn"
  }
}
```

### تغيير 139 — أضف prettier config
```json
// .prettierrc
{
  "semi": true,
  "singleQuote": false,
  "tabWidth": 2,
  "printWidth": 100
}
```

### تغيير 140 — تشغيل نهائي شامل
```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
# تأكد يدوياً:
# /start → welcome + keyboard
# /add [rss url] → preview → confirm → cover art
# /latest → episode list + pagination
# /stats → stats + bar chart
# ep → transcribe → summary → ask
# /playlist 30 دقيقة
# voice message → search
# /import opml file
# /notes
# sleep timer
# playback speed
```

---

## ✅ قائمة التحقق النهائي الكاملة

**AI:**
- [ ] `openai` و `deepseek` محذوفان تماماً
- [ ] `groq-sdk` يعمل: transcribe + summarize + chat
- [ ] retry logic في كل Groq calls

**Formatter:**
- [ ] خط فاصل = `──────────────` فقط، لا غير
- [ ] كل سطر ≤ 32 حرف
- [ ] `esc()` على كل نص ديناميكي
- [ ] cover art يُرسل عند الاشتراك
- [ ] spinner للعمليات الطويلة

**Architecture:**
- [ ] handlers.ts مقسّم: commands + callbacks
- [ ] keyboards.ts مستقل
- [ ] utils/text.ts + db/utils.ts
- [ ] config validation بـ zod

**UX:**
- [ ] /resume يعمل
- [ ] /playlist يعمل
- [ ] /ask يعمل (AI chat)
- [ ] /notes يعمل
- [ ] /import يقبل OPML
- [ ] /tsearch يبحث في النصوص
- [ ] sleep timer يعمل
- [ ] playback speed يحفظ
- [ ] voice messages تُحوَّل وتُبحث

**Security:**
- [ ] rate limiting يعمل
- [ ] SQL sanitization
- [ ] URL validation
- [ ] LRU cache بدل Map
- [ ] TTL للـ sessions

**Notifications:**
- [ ] Podcast of the Day (9 صباحاً)
- [ ] Daily Digest (6 مساءً)
- [ ] تفضيلات الإشعارات تُحترم

**Testing:**
- [ ] vitest مضاف
- [ ] formatter tests تنجح
- [ ] GitHub Actions CI يعمل
- [ ] `pnpm typecheck` بلا أخطاء
- [ ] `pnpm build` ينجح
