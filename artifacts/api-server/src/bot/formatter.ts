/**
 * formatter.ts — All Telegram message formatting for iCast
 * Design: Arabic-first, artful, aesthetic, MarkdownV2
 */

export const DIV = "─────────────────────";
export const DIV_SM = "──────────────";

/** Escape all MarkdownV2 special characters */
export function esc(t: string): string {
  if (!t) return "";
  return t.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

/** Truncate with word boundary */
export function trunc(t: string, n = 32): string {
  if (!t) return "";
  if (t.length <= n) return t;
  const cut = t.slice(0, n).replace(/\s+\S*$/, "");
  return (cut.length > 2 ? cut : t.slice(0, n)) + "…";
}

/** Format seconds → "1س 23د" or "45د" */
export function fmtDur(secs: number | string | null | undefined): string {
  if (!secs) return "";
  const s = typeof secs === "string"
    ? (() => {
        const parts = secs.split(":").map(Number);
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        return Number(secs) || 0;
      })()
    : secs;
  if (!s || isNaN(s)) return "";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}س ${m}د` : `${m}د`;
}

/** Format a date in Arabic */
export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString("ar-SA", { day: "numeric", month: "short", year: "numeric" });
}

/** Progress bar 10 blocks */
export function bar(pct: number): string {
  const f = Math.round(Math.max(0, Math.min(100, pct)) / 100 * 10);
  return "█".repeat(f) + "░".repeat(10 - f);
}

export function parseDuration(dur: string | null | undefined): number {
  if (!dur) return 0;
  const parts = dur.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(dur) || 0;
}

// ─── Loading / status ─────────────────────────────────────────────────────────

export function loadingMsg(step: number, label = "جاري التحديث"): string {
  const s = Math.max(0, Math.min(4, step));
  const b = "█".repeat(s) + "░".repeat(4 - s);
  return `⟳ *${esc(label)}*\n\`${b}\``;
}

export function doneMsg(label: string): string {
  return `✅ *${esc(label)}*`;
}

export function errorMsg(msg: string, hint?: string): string {
  const lines = [`⚠️ ${esc(msg)}`];
  if (hint) lines.push(`_${esc(hint)}_`);
  return lines.join("\n");
}

export function softError(situation: string, action: string): string {
  return [`😕 *${esc(situation)}*`, `_${esc(action)}_`].join("\n");
}

// ─── Welcome ──────────────────────────────────────────────────────────────────

export function welcomeMsg(
  name: string,
  resumeEp?: { title: string; progress: number } | null
): string {
  const lines = [
    `🎙 *iCast*`,
    `════════════════════`,
    ``,
    `أهلاً *${esc(name)}* 👋`,
    ``,
    `_مدير بودكاست شخصي مدعوم بالذكاء الاصطناعي_`,
    ``,
    DIV_SM,
    `📻 بودكاستاتي  ·  🆕 آخر الحلقات`,
    `🔍 بحث  ·  🌍 اكتشاف  ·  ⚙️ الإعدادات`,
  ];
  if (resumeEp) {
    lines.push(``, DIV_SM);
    lines.push(`▶️ *تابع الاستماع*`);
    lines.push(`🎧 ${esc(trunc(resumeEp.title, 30))}`);
    lines.push(`${bar(resumeEp.progress)}  ${resumeEp.progress}%`);
  }
  return lines.join("\n");
}

// ─── Help ─────────────────────────────────────────────────────────────────────

export function helpMsg(): string {
  return [
    `📖 *الأوامر المتاحة*`,
    DIV,
    `🎙 *الأساسية*`,
    `/start  ·  /help  ·  /about`,
    ``,
    `📻 *البودكاست*`,
    `/add  ·  /feeds  ·  /latest  ·  /search`,
    `/random  ·  /digest  ·  /refresh`,
    ``,
    `🎧 *التشغيل*`,
    `/queue  ·  /resume  ·  /favourites`,
    `/playlist  ·  /stats`,
    ``,
    `🤖 *الذكاء الاصطناعي*`,
    `/ask  ·  /tsearch  ·  /recommend`,
    ``,
    `⚙️ *الإعدادات*`,
    `/settings  ·  /notes  ·  /import`,
    ``,
    `🛡 /admin  ·  /users  ·  /logs`,
  ].join("\n");
}

// ─── About ────────────────────────────────────────────────────────────────────

export function aboutMsg(): string {
  return [
    `🎙 *iCast v3\\.1*`,
    `════════════════════`,
    `_مدير البودكاست الشخصي الأذكى_`,
    DIV,
    `🌐 اكتشاف آلاف البودكاستات`,
    `🧠 تفريغ نصي بـ Whisper AI`,
    `✨ ملخصات ذكية فورية`,
    `🎓 وضع الأستاذ الجامعي`,
    `❓ 100 سؤال تفكير نقدي`,
    `📄 تصدير PDF احترافي`,
    `🛡 نظام وصول متقدم`,
    `📊 إحصائيات وتتبع الاستماع`,
    `❤️ مفضلات وملاحظات`,
    `🔖 إشارات مرجعية`,
    DIV,
    `_Powered by Groq · LLaMA · Whisper_`,
  ].join("\n");
}

// ─── Add prompt ───────────────────────────────────────────────────────────────

export function addPromptMsg(): string {
  return [
    `📥 *إضافة بودكاست*`,
    DIV,
    `أرسل رابط RSS مباشرة`,
    ``,
    `*مثال:*`,
    `\`https://feeds\\.example\\.com/feed\\.rss\``,
    ``,
    `_أو ابحث في /discover_`,
  ].join("\n");
}

export function addPreviewMsg(feed: {
  title: string;
  description?: string;
  episodeCount?: number;
}): string {
  return [
    `📻 *${esc(trunc(feed.title, 32))}*`,
    DIV,
    feed.description ? `_${esc(trunc(feed.description, 100))}_` : "",
    feed.episodeCount ? `🎧 ${feed.episodeCount} حلقة متاحة` : "",
    ``,
    `هل تريد الاشتراك في هذا البودكاست؟`,
  ].filter(Boolean).join("\n");
}

export function addSuccessMsg(feed: { title: string; episodeCount?: number }): string {
  return [
    `✅ *تم الاشتراك\\!*`,
    DIV,
    `📻 ${esc(trunc(feed.title, 32))}`,
    feed.episodeCount ? `🎧 ${feed.episodeCount} حلقة جاهزة للاستماع` : "",
  ].filter(Boolean).join("\n");
}

// ─── Feed card ────────────────────────────────────────────────────────────────

export function feedCard(feed: {
  title:         string;
  author?:       string | null;
  episodeCount?: number;
  lastUpdated?:  Date | string | null;
  unreadCount?:  number;
  rating?:       number | null;
}, i?: number): string {
  const num = i !== undefined ? `${i + 1}\\. ` : "";
  const lines = [`${num}📻 *${esc(trunc(feed.title, 28))}*`];
  if (feed.author) lines.push(`👤 ${esc(trunc(feed.author, 24))}`);

  const meta: string[] = [];
  if (feed.episodeCount) meta.push(`🎧 ${feed.episodeCount}`);
  if (feed.lastUpdated)  meta.push(`📅 ${fmtDate(feed.lastUpdated)}`);
  if (meta.length) lines.push(meta.join("  ·  "));

  if (feed.unreadCount && feed.unreadCount > 0) lines.push(`🔵 ${feed.unreadCount} جديدة`);
  if (feed.rating) lines.push("⭐".repeat(feed.rating));
  return lines.join("\n");
}

// ─── Episode card (ARTFUL) ────────────────────────────────────────────────────

export function episodeCard(ep: {
  title:          string;
  feedTitle?:     string | null;
  pubDate?:       Date | string | null;
  duration?:      number | string | null;
  progress?:      number | null;
  listened?:      boolean;
  isPlayed?:      boolean;
  isFavourite?:   boolean;
  isFav?:         boolean;
  inQueue?:       boolean;
  episodeNumber?: number | null;
  description?:   string | null;
}): string {
  const isPlayed = ep.listened || ep.isPlayed;
  const isFav    = ep.isFavourite || ep.isFav;
  const pct      = Math.round((ep.progress ?? 0) * 100);

  const isNew = ep.pubDate
    ? (Date.now() - new Date(ep.pubDate).getTime()) < 48 * 3600 * 1000
    : false;

  const dur  = ep.duration ? fmtDur(ep.duration) : "";
  const date = ep.pubDate  ? fmtDate(ep.pubDate)  : "";
  const numStr = ep.episodeNumber ? `EP${ep.episodeNumber} · ` : "";

  const lines: string[] = [
    `🎙 *iCast*`,
    `════════════════════`,
  ];

  if (ep.feedTitle) {
    lines.push(`📻 _${esc(trunc(ep.feedTitle, 30))}_`);
  }

  lines.push(``, `*${esc(numStr)}${esc(trunc(ep.title, 36))}*`, ``);

  const meta: string[] = [];
  if (dur)  meta.push(`⏱ ${esc(dur)}`);
  if (date) meta.push(`📅 ${esc(date)}`);
  if (meta.length) lines.push(meta.join("  ·  "));

  lines.push(DIV_SM);

  // Progress
  if (isPlayed) {
    lines.push(`✅ *مكتملة*`);
  } else if (pct > 0) {
    lines.push(`${bar(pct)}  *${pct}%*`);
  } else {
    lines.push(`░░░░░░░░░░  _لم يبدأ_`);
  }

  // Badges
  const badges: string[] = [];
  if (isNew)      badges.push("🆕 جديدة");
  if (isFav)      badges.push("❤️ مفضلة");
  if (ep.inQueue) badges.push("⏭ في القائمة");
  if (badges.length) lines.push(badges.join("  ·  "));

  return lines.join("\n");
}

// ─── Feed list ────────────────────────────────────────────────────────────────

export function feedListMsg(feeds: any[]): string {
  if (!feeds.length) {
    return [
      `📭 *لا توجد اشتراكات بعد*`,
      DIV,
      `أضف بودكاست بـ /add`,
      `أو اكتشف المزيد بـ /discover`,
    ].join("\n");
  }
  return [
    `📻 *بودكاستاتي \\(${feeds.length}\\)*`,
    DIV,
    feeds.map((f, i) => feedCard(f, i)).join(`\n${DIV_SM}\n`),
  ].join("\n");
}

// ─── Episode list ─────────────────────────────────────────────────────────────

export function episodeListMsg(
  eps: any[],
  feedTitle?: string,
  page = 1,
  total = 1
): string {
  const header = feedTitle
    ? `🎙 *${esc(trunc(feedTitle, 24))}*`
    : `🎧 *آخر الحلقات*`;
  const pg = total > 1 ? `  ·  ${page}\\/${total}` : "";
  if (!eps.length) return [header, DIV, `لا توجد حلقات`].join("\n");
  return [
    `${header}${pg}`,
    DIV,
    eps.map((e) => episodeCard(e)).join(`\n${DIV_SM}\n`),
  ].join("\n");
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export function statsMsg(s: {
  feedCount:         number;
  playedCount:       number;
  totalMinutes:      number;
  favouriteCount:    number;
  streak?:           number;
  lastListened?:     Date | string | null;
  queueCount?:       number;
  tagCount?:         number;
  transcribedCount?: number;
  weeklyMins?:       number[];
}): string {
  const h = Math.floor(s.totalMinutes / 60);
  const m = s.totalMinutes % 60;
  const timeStr = h > 0 ? `${h}س ${m}د` : `${m}د`;

  const lines = [
    `📊 *إحصائياتي*`,
    `════════════════════`,
    `📻  ${s.feedCount} بودكاست`,
    `✅  ${s.playedCount} حلقة مكتملة`,
    `⏱  ${esc(timeStr)} استماع`,
    `❤️  ${s.favouriteCount} في المفضلة`,
  ];
  if (s.queueCount !== undefined)  lines.push(`⏭  ${s.queueCount} في القائمة`);
  if (s.transcribedCount)          lines.push(`📝  ${s.transcribedCount} تم تفريغها`);
  if (s.tagCount !== undefined)    lines.push(`🏷  ${s.tagCount} تصنيف`);
  if (s.streak)                    lines.push(`🔥  سلسلة ${s.streak} يوم`);
  if (s.lastListened)              lines.push(`🕐  آخر استماع: ${esc(fmtDate(s.lastListened))}`);

  if (s.weeklyMins?.length === 7) {
    lines.push(DIV, weeklyBarChart(s.weeklyMins));
  }
  return lines.join("\n");
}

export function weeklyBarChart(dailyMins: number[]): string {
  const days = ["أح", "إث", "ثل", "أر", "خم", "جم", "سب"];
  const max  = Math.max(...dailyMins, 1);
  return dailyMins
    .map((m, i) => {
      const h = Math.round((m / max) * 5);
      return `${days[i]} ${"█".repeat(h)}${"░".repeat(5 - h)} ${m}د`;
    })
    .join("\n");
}

// ─── Queue ────────────────────────────────────────────────────────────────────

export function queueMsg(eps: any[]): string {
  if (!eps.length) {
    return [`📭 *القائمة فارغة*`, DIV, `أضف حلقات من /latest`].join("\n");
  }
  return [
    `⏭ *قائمة التشغيل \\(${eps.length}\\)*`,
    DIV,
    eps.map((e, i) => {
      const dur = fmtDur(e.duration);
      return `${i + 1}\\. ${esc(trunc(e.title, 26))}${dur ? `  ·  ${esc(dur)}` : ""}`;
    }).join("\n"),
  ].join("\n");
}

// ─── Search results ───────────────────────────────────────────────────────────

export function searchResultsMsg(query: string, results: any[]): string {
  const q = esc(trunc(query, 20));
  if (!results.length) {
    return [`🔍 *"${q}"*`, DIV, `لا توجد نتائج`, `_جرّب كلمة أخرى_`].join("\n");
  }
  return [
    `🔍 *"${q}"* — ${results.length} نتيجة`,
    DIV,
    results.slice(0, 8).map((r, i) =>
      `${i + 1}\\. *${esc(trunc(r.title, 26))}*${r.author ? `\n   👤 _${esc(trunc(r.author, 20))}_` : ""}`
    ).join("\n"),
  ].join("\n");
}

// ─── Summary ──────────────────────────────────────────────────────────────────

export function summaryMsg(title: string, summary: string): string {
  return [
    `✨ *ملخص الحلقة*`,
    DIV,
    `🎙 _${esc(trunc(title, 32))}_`,
    DIV,
    esc(trunc(summary, 900)),
  ].join("\n");
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export function settingsMsg(prefs: {
  autoDownload:  boolean;
  notifications: string;
  language:      string;
}): string {
  const notifLabel =
    prefs.notifications === "all"    ? "🔔 كل الإشعارات" :
    prefs.notifications === "digest" ? "📋 ملخص يومي"    : "🔕 صامت";
  return [
    `⚙️ *الإعدادات*`,
    DIV,
    `⬇️ تحميل تلقائي: ${prefs.autoDownload ? "✅ مفعّل" : "❌ معطّل"}`,
    `🔔 الإشعارات: ${esc(notifLabel)}`,
    `🌐 اللغة: ${esc(prefs.language === "ar" ? "العربية 🇸🇦" : "English 🇬🇧")}`,
  ].join("\n");
}

// ─── Notes ────────────────────────────────────────────────────────────────────

export function notesMsg(
  notes: Array<{ episodeTitle: string; note: string; createdAt: Date | string }>
): string {
  if (!notes.length) {
    return [`📭 *لا توجد ملاحظات بعد*`, DIV, `اضغط 📝 على أي حلقة`].join("\n");
  }
  return [
    `📝 *ملاحظاتي \\(${notes.length}\\)*`,
    DIV,
    notes.map((n, i) =>
      `${i + 1}\\. *${esc(trunc(n.episodeTitle, 24))}*\n   📝 _${esc(trunc(n.note, 40))}_`
    ).join(`\n${DIV_SM}\n`),
  ].join("\n");
}

// ─── Discover ─────────────────────────────────────────────────────────────────

export function discoverMsg(): string {
  return [
    `🌍 *اكتشاف البودكاستات*`,
    DIV,
    `تصفح أفضل البودكاستات حسب التصنيف أو الدولة`,
    ``,
    `اختر تصنيفاً من القائمة أدناه 👇`,
  ].join("\n");
}

// ─── Playlist ─────────────────────────────────────────────────────────────────

export function playlistMsg(eps: any[], totalMins: number): string {
  return [
    `🎵 *قائمة تشغيل جديدة*`,
    DIV,
    `⏱ ~${Math.round(totalMins)} دقيقة  ·  ${eps.length} حلقات`,
    DIV,
    eps.map((e, i) => `${i + 1}\\. ${esc(trunc(e.title, 26))}`).join("\n"),
  ].join("\n");
}

// ─── Celebration ──────────────────────────────────────────────────────────────

export function celebrationMsg(title: string): string {
  return [
    `🎉 *أحسنت\\! أكملت الحلقة*`,
    DIV,
    `🎙 _${esc(trunc(title, 32))}_`,
    ``,
    `_استمر في الاستماع والتعلم\\!_ 🚀`,
  ].join("\n");
}

// ─── Admin panel ──────────────────────────────────────────────────────────────

export function adminPanelMsg(stats?: {
  totalUsers:   number;
  pendingUsers: number;
  blockedUsers: number;
}): string {
  const lines = [
    `🛡 *لوحة تحكم الأدمن*`,
    `════════════════════`,
  ];
  if (stats) {
    lines.push(`👥 المستخدمون: *${stats.totalUsers}*`);
    lines.push(`⏳ في الانتظار: *${stats.pendingUsers}*`);
    lines.push(`🚷 محظورون: *${stats.blockedUsers}*`);
    lines.push(DIV);
  }
  lines.push(`اختر من القائمة أدناه 👇`);
  return lines.join("\n");
}

// ─── Share card ───────────────────────────────────────────────────────────────

export function shareCard(ep: {
  title:      string;
  feedTitle?: string | null;
  pubDate?:   Date | string | null;
  duration?:  number | string | null;
  description?: string | null;
}): string {
  return [
    `🎙 *iCast — حلقة مميزة*`,
    `════════════════════`,
    ep.feedTitle ? `📻 _${esc(trunc(ep.feedTitle, 30))}_` : "",
    `*${esc(trunc(ep.title, 36))}*`,
    ``,
    ep.description ? `_${esc(trunc(ep.description, 120))}_` : "",
    ``,
    [
      ep.duration ? `⏱ ${esc(fmtDur(ep.duration))}` : "",
      ep.pubDate  ? `📅 ${esc(fmtDate(ep.pubDate))}`  : "",
    ].filter(Boolean).join("  ·  "),
    ``,
    `_اكتشف المزيد مع @YourBotUsername_`,
  ].filter((l) => l !== "").join("\n");
}

// ─── Daily digest ─────────────────────────────────────────────────────────────

export function digestMsg(episodes: Array<{ title: string; feedTitle?: string | null; duration?: string | null }>): string {
  if (!episodes.length) {
    return [`🌅 *الملخص اليومي*`, DIV, `لا توجد حلقات جديدة اليوم`].join("\n");
  }
  const lines = [
    `🌅 *ملخص اليوم*`,
    `════════════════════`,
    `_${episodes.length} حلقات جديدة تنتظرك_`,
    DIV,
  ];
  for (const [i, ep] of episodes.entries()) {
    const dur = ep.duration ? `  ·  ${esc(fmtDur(ep.duration))}` : "";
    lines.push(`${i + 1}\\. *${esc(trunc(ep.title, 28))}*${dur}`);
    if (ep.feedTitle) lines.push(`   📻 _${esc(trunc(ep.feedTitle, 24))}_`);
  }
  return lines.join("\n");
}

// ─── Quote card ───────────────────────────────────────────────────────────────

export function quoteCard(quote: string, episodeTitle: string, feedTitle?: string | null): string {
  return [
    `💬 *اقتباس رائع*`,
    `════════════════════`,
    ``,
    `❝ ${esc(trunc(quote, 300))} ❞`,
    ``,
    DIV,
    `🎙 _${esc(trunc(episodeTitle, 30))}_`,
    feedTitle ? `📻 _${esc(trunc(feedTitle, 26))}_` : "",
  ].filter((l) => l !== "").join("\n");
}

// ─── Analytics card ───────────────────────────────────────────────────────────

export function analyticsCard(ep: {
  title:      string;
  duration?:  string | null;
  pubDate?:   Date | null;
  listenedAt?: Date | null;
  wordCount?: number;
  speakerCount?: number;
}): string {
  const lines = [
    `📊 *تحليل الحلقة*`,
    DIV,
    `🎙 _${esc(trunc(ep.title, 30))}_`,
    DIV,
  ];
  if (ep.duration)      lines.push(`⏱ المدة: ${esc(fmtDur(ep.duration))}`);
  if (ep.pubDate)       lines.push(`📅 نشر: ${esc(fmtDate(ep.pubDate))}`);
  if (ep.wordCount)     lines.push(`📝 الكلمات: ~${ep.wordCount.toLocaleString()}`);
  if (ep.speakerCount)  lines.push(`🎤 المتحدثون: ${ep.speakerCount}`);
  return lines.join("\n");
}

// ─── Back-compat shims ────────────────────────────────────────────────────────

export const divider      = () => DIV;
export const shortDivider = () => DIV_SM;
export const fmt          = (lines: string[]) => lines.join("\n");
export const truncate        = trunc;
export const formatDuration  = fmtDur;
export const formatDate      = fmtDate;
export const progressBar     = bar;
