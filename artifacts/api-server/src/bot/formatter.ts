/**
 * formatter.ts — iCast Clean English UI
 * Language: British English
 * Style: Clean, simple, professional — no ASCII art
 */

// ─── Design Tokens ────────────────────────────────────────────────────────────

export const V = {
  logo:   `🎙 iCast`,
  wave:   ``,
  line:   `━━━━━━━━━━━━━━━━━━━`,
  thin:   `─────────────────────`,
  dbl:    `━━━━━━━━━━━━━━━━━━━`,
  spark:  `✦`,
  dot:    `▸`,
  fill:   `◆`,
  empty:  `◇`,
  block:  `█`,
  shade:  `░`,
};

export const DIV    = V.line;
export const DIV_SM = `──────────────`;
export const LOGO   = V.logo;
export const WAVE   = ``;

// ─── MarkdownV2 Helpers ───────────────────────────────────────────────────────

export function esc(t: string): string {
  if (!t) return "";
  return t.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

export function trunc(t: string, n = 32): string {
  if (!t || t.length <= n) return t ?? "";
  return t.slice(0, n).replace(/\s+\S*$/, (m) => (m.length > 1 ? "" : m)).slice(0, n) + "…";
}

export function fmtDur(secs: number | string | null | undefined): string {
  if (!secs) return "";
  const s =
    typeof secs === "string"
      ? (() => {
          const p = secs.split(":").map(Number);
          if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
          if (p.length === 2) return p[0] * 60 + p[1];
          return Number(secs) || 0;
        })()
      : secs;
  if (!s || isNaN(s)) return "";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function bar(pct: number): string {
  const f = Math.round(Math.max(0, Math.min(100, pct)) / 100 * 10);
  return V.fill.repeat(f) + V.empty.repeat(10 - f);
}

export function parseDuration(dur: string | null | undefined): number {
  if (!dur) return 0;
  const p = dur.split(":").map(Number);
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return Number(dur) || 0;
}

// ─── Status messages ──────────────────────────────────────────────────────────

export function loadingMsg(step: number, label = "Loading"): string {
  const s = Math.max(0, Math.min(4, step));
  const b = V.block.repeat(s) + V.shade.repeat(4 - s);
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
    `🎙 *iCast* — Welcome back, *${esc(name)}*\\!`,
    DIV,
    ``,
    `Your AI\\-powered podcast manager is ready\\.`,
    ``,
    `${V.dot} *My Podcasts* · Browse your subscriptions`,
    `${V.dot} *Latest* · New episodes waiting`,
    `${V.dot} *Search* · Find anything`,
    `${V.dot} *Discover* · Explore new shows`,
  ];
  if (resumeEp) {
    lines.push(``, DIV, `▶️ *Continue Listening*`);
    lines.push(`🎙 _${esc(trunc(resumeEp.title, 30))}_`);
    lines.push(`${bar(resumeEp.progress)}  ${resumeEp.progress}%`);
  }
  return lines.join("\n");
}

// ─── Help ─────────────────────────────────────────────────────────────────────

export function helpMsg(): string {
  return [
    `🎙 *iCast — Commands*`,
    DIV,
    ``,
    `📻 *PODCASTS*`,
    `\`/add\` — Subscribe to RSS feed`,
    `\`/feeds\` — My subscriptions`,
    `\`/latest\` — Recent episodes`,
    `\`/search\` — Search episodes`,
    `\`/random\` — Random episode`,
    `\`/new\` — Added in last 48h`,
    `\`/popular\` — Most played`,
    `\`/recent\` — Recently played`,
    ``,
    `🤖 *AI TOOLS*`,
    `\`/digest\` — Weekly digest`,
    `\`/recommend\` — AI recommendations`,
    `\`/mentions\` — Search transcripts`,
    `\`/compare\` — Compare episodes`,
    ``,
    `📊 *TRACKING*`,
    `\`/stats\` — My statistics`,
    `\`/streak\` — Listening streak`,
    `\`/history\` — Listening history`,
    `\`/goal\` — Weekly listening goal`,
    `\`/now\` — Current episode`,
    ``,
    `🗂 *LIBRARY*`,
    `\`/queue\` — Playback queue`,
    `\`/favourites\` — Saved episodes`,
    `\`/notes\` — My notes`,
    `\`/export\` — Export library`,
    `\`/import\` — Import OPML`,
    ``,
    `⚙️ *SETTINGS*`,
    `\`/settings\` — Preferences`,
    `\`/remind\` — Set a reminder`,
    ``,
    `🛡 *ADMIN*`,
    `\`/admin\` — Admin panel`,
    `\`/adminsetup\` — Claim admin access`,
  ].join("\n");
}

// ─── About ────────────────────────────────────────────────────────────────────

export function aboutMsg(): string {
  return [
    `🎙 *iCast v3\\.2*`,
    DIV,
    ``,
    `${V.spark} Whisper AI transcription`,
    `${V.spark} Groq LLaMA summaries`,
    `${V.spark} Deep analysis & 100 questions`,
    `${V.spark} Professional PDF transcripts`,
    `${V.spark} Statistics & streak tracking`,
    `${V.spark} Sleep timer & playback speed`,
    `${V.spark} Smart playlists & queue`,
    `${V.spark} Bookmarks, notes & tags`,
    ``,
    `_Powered by Groq · Whisper · LLaMA_`,
  ].join("\n");
}

// ─── Add prompt ───────────────────────────────────────────────────────────────

export function addPromptMsg(): string {
  return [
    `➕ *Add Podcast*`,
    DIV,
    ``,
    `Send an RSS feed URL:`,
    ``,
    `\`https://feeds\\.example\\.com/podcast\\.rss\``,
    ``,
    `_Or use /discover to browse podcasts_`,
  ].join("\n");
}

export function addPreviewMsg(feed: {
  title: string; description?: string; episodeCount?: number;
}): string {
  return [
    `📻 *Podcast Found*`,
    DIV,
    ``,
    `*${esc(trunc(feed.title, 36))}*`,
    feed.description ? `_${esc(trunc(feed.description, 120))}_` : "",
    feed.episodeCount ? `🎧 ${feed.episodeCount} episodes available` : "",
    ``,
    `Would you like to subscribe?`,
  ].filter(Boolean).join("\n");
}

export function addSuccessMsg(feed: { title: string; episodeCount?: number }): string {
  return [
    `✅ *Subscribed\\!*`,
    DIV,
    ``,
    `📻 *${esc(trunc(feed.title, 36))}*`,
    feed.episodeCount ? `🎧 ${feed.episodeCount} episodes ready` : "",
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
  const lines = [`${num}📻 *${esc(trunc(feed.title, 30))}*`];
  if (feed.author) lines.push(`   _${esc(trunc(feed.author, 24))}_`);

  const meta: string[] = [];
  if (feed.episodeCount) meta.push(`🎧 ${feed.episodeCount}`);
  if (feed.lastUpdated)  meta.push(`📅 ${fmtDate(feed.lastUpdated)}`);
  if (meta.length)       lines.push(`   ${meta.join("  ·  ")}`);

  if (feed.unreadCount && feed.unreadCount > 0) lines.push(`   🔵 ${feed.unreadCount} new`);
  if (feed.rating) lines.push(`   ${"⭐".repeat(feed.rating)}`);
  return lines.join("\n");
}

// ─── Episode card ─────────────────────────────────────────────────────────────

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
  const isNew    = ep.pubDate
    ? (Date.now() - new Date(ep.pubDate).getTime()) < 48 * 3600 * 1000
    : false;
  const dur      = ep.duration ? fmtDur(ep.duration) : "";
  const date     = ep.pubDate  ? fmtDate(ep.pubDate)  : "";
  const numStr   = ep.episodeNumber ? `EP${ep.episodeNumber} · ` : "";

  const lines: string[] = [];

  if (ep.feedTitle) lines.push(`📻 _${esc(trunc(ep.feedTitle, 32))}_`);
  lines.push(`*${esc(numStr)}${esc(trunc(ep.title, 40))}*`);

  const meta: string[] = [];
  if (dur)  meta.push(`⏱ ${esc(dur)}`);
  if (date) meta.push(`📅 ${esc(date)}`);
  if (meta.length) lines.push(meta.join("  ·  "));

  lines.push(DIV_SM);

  if (isPlayed) {
    lines.push(`✅ Completed`);
  } else if (pct > 0) {
    lines.push(`${bar(pct)}  *${pct}%*`);
  } else {
    lines.push(`${V.empty.repeat(10)}  _Not started_`);
  }

  const badges: string[] = [];
  if (isNew)      badges.push("🆕 New");
  if (isFav)      badges.push("❤️ Favourite");
  if (ep.inQueue) badges.push("⏭ Queued");
  if (badges.length) lines.push(badges.join("  ·  "));

  return lines.join("\n");
}

// ─── Feed list ────────────────────────────────────────────────────────────────

export function feedListMsg(feeds: any[]): string {
  if (!feeds.length) {
    return [`📻 *My Podcasts*`, DIV, ``, `No subscriptions yet\\.`, `_Use /add or /discover to get started_`].join("\n");
  }
  return [
    `📻 *My Podcasts* \\(${feeds.length}\\)`,
    DIV,
    feeds.map((f, i) => feedCard(f, i)).join(`\n${DIV_SM}\n`),
  ].join("\n");
}

// ─── Episode list ─────────────────────────────────────────────────────────────

export function episodeListMsg(eps: any[], feedTitle?: string, page = 1, total = 1): string {
  const title = feedTitle ? `📻 *${esc(trunc(feedTitle, 28))}*` : `🎧 *Latest Episodes*`;
  const pg    = total > 1 ? `  ·  Page ${page}/${total}` : "";
  if (!eps.length) return [title, DIV, ``, `No episodes found`].join("\n");
  return [title + esc(pg), DIV, eps.map((e) => episodeCard(e)).join(`\n${DIV_SM}\n`)].join("\n");
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
  weeklyGoal?:       number;
}): string {
  const h = Math.floor(s.totalMinutes / 60), m = s.totalMinutes % 60;
  const timeStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
  const goalPct = s.weeklyGoal && s.totalMinutes
    ? Math.round((s.totalMinutes / s.weeklyGoal) * 100) : null;

  const lines = [
    `📊 *Statistics*`,
    DIV,
    ``,
    `📻  *${s.feedCount}* podcasts`,
    `✅  *${s.playedCount}* episodes completed`,
    `⏱  *${esc(timeStr)}* total listening time`,
    `❤️  *${s.favouriteCount}* favourites`,
  ];
  if (s.queueCount !== undefined)  lines.push(`⏭  *${s.queueCount}* in queue`);
  if (s.transcribedCount)          lines.push(`📝  *${s.transcribedCount}* transcribed`);
  if (s.tagCount !== undefined)    lines.push(`🏷  *${s.tagCount}* tags`);
  if (s.streak)                    lines.push(`🔥  *${s.streak}\\-day* streak`);
  if (s.lastListened)              lines.push(`🕐  Last: ${esc(fmtDate(s.lastListened))}`);
  if (goalPct !== null)            lines.push(`🎯  Weekly goal: ${bar(goalPct)} ${goalPct}%`);

  if (s.weeklyMins?.length === 7) {
    lines.push(``, DIV_SM, weeklyBarChart(s.weeklyMins));
  }
  return lines.join("\n");
}

export function weeklyBarChart(dailyMins: number[]): string {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const max  = Math.max(...dailyMins, 1);
  return [
    `*This Week*`,
    ...dailyMins.map((m, i) => {
      const h = Math.round((m / max) * 6);
      return `\`${days[i]}\` ${"█".repeat(h)}${"░".repeat(6 - h)} ${m}m`;
    }),
  ].join("\n");
}

// ─── Queue ────────────────────────────────────────────────────────────────────

export function queueMsg(eps: any[]): string {
  if (!eps.length) {
    return [`⏭ *Queue*`, DIV, ``, `Empty — add episodes from /latest or any episode page`].join("\n");
  }
  return [
    `⏭ *Queue* \\(${eps.length}\\)`,
    DIV,
    eps.map((e, i) => {
      const dur = fmtDur(e.duration);
      return `*${i + 1}\\.* ${esc(trunc(e.title, 30))}${dur ? `  ·  ${esc(dur)}` : ""}`;
    }).join("\n"),
  ].join("\n");
}

// ─── Search results ───────────────────────────────────────────────────────────

export function searchResultsMsg(query: string, results: any[]): string {
  if (!results.length) {
    return [`🔍 *Search: "${esc(trunc(query,20))}"*`, DIV, ``, `No results found`, `_Try a different keyword_`].join("\n");
  }
  return [
    `🔍 *Search Results* · ${results.length} found`,
    DIV,
    results.slice(0, 8).map((r, i) =>
      `*${i + 1}\\.* ${esc(trunc(r.title, 28))}${r.author ? `\n   _${esc(trunc(r.author, 22))}_` : ""}`
    ).join("\n"),
  ].join("\n");
}

// ─── Summary ──────────────────────────────────────────────────────────────────

export function summaryMsg(title: string, summary: string): string {
  return [
    `🤖 *AI Summary*`,
    `_${esc(trunc(title, 32))}_`,
    DIV,
    ``,
    esc(trunc(summary, 900)),
  ].join("\n");
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export function settingsMsg(prefs: {
  autoDownload:  boolean;
  notifications: string;
  language:      string;
  playbackSpeed?: string;
}): string {
  const notifLabel =
    prefs.notifications === "all"    ? "🔔 All" :
    prefs.notifications === "digest" ? "📋 Digest only" : "🔕 Silent";
  const speed = prefs.playbackSpeed ?? "1";
  return [
    `⚙️ *Settings*`,
    DIV,
    ``,
    `${V.dot} Auto\\-download: ${prefs.autoDownload ? "✅ On" : "❌ Off"}`,
    `${V.dot} Notifications: ${esc(notifLabel)}`,
    `${V.dot} Language: ${prefs.language === "ar" ? "🇸🇦 Arabic" : "🇬🇧 English"}`,
    `${V.dot} Speed: ${esc(speed)}×`,
  ].join("\n");
}

// ─── Notes ────────────────────────────────────────────────────────────────────

export function notesMsg(
  notes: Array<{ episodeTitle: string; note: string; createdAt: Date | string }>
): string {
  if (!notes.length) {
    return [`📝 *My Notes*`, DIV, ``, `No notes yet`, `_Tap 📝 on any episode to add one_`].join("\n");
  }
  return [
    `📝 *My Notes* \\(${notes.length}\\)`,
    DIV,
    notes.map((n, i) =>
      `*${i + 1}\\.* ${esc(trunc(n.episodeTitle, 26))}\n   _"${esc(trunc(n.note, 60))}"_`
    ).join(`\n${DIV_SM}\n`),
  ].join("\n");
}

// ─── Discover ─────────────────────────────────────────────────────────────────

export function discoverMsg(): string {
  return [
    `🌍 *Discover Podcasts*`,
    DIV,
    ``,
    `Browse thousands of shows by category or country\\.`,
    ``,
    `Choose a category below:`,
  ].join("\n");
}

// ─── Playlist ─────────────────────────────────────────────────────────────────

export function playlistMsg(eps: any[], totalMins: number): string {
  return [
    `🎵 *Smart Playlist*`,
    `_~${Math.round(totalMins)}m · ${eps.length} episodes_`,
    DIV,
    eps.map((e, i) => `*${i + 1}\\.* ${esc(trunc(e.title, 30))}`).join("\n"),
  ].join("\n");
}

// ─── Celebration ──────────────────────────────────────────────────────────────

export function celebrationMsg(title: string): string {
  return [
    `🎉 *Episode Complete\\!*`,
    DIV,
    ``,
    `🎙 _${esc(trunc(title, 36))}_`,
    ``,
    `_Keep learning, keep growing\\!_ 🚀`,
  ].join("\n");
}

// ─── Admin panel ──────────────────────────────────────────────────────────────

export function adminPanelMsg(stats?: {
  totalUsers: number; pendingUsers: number; blockedUsers: number;
}): string {
  const lines = [`🛡 *Admin Panel*`, DIV, ``];
  if (stats) {
    lines.push(`👥 Total users: *${stats.totalUsers}*`);
    lines.push(`⏳ Pending: *${stats.pendingUsers}*`);
    lines.push(`🚷 Blocked: *${stats.blockedUsers}*`);
    lines.push(``, DIV_SM);
  }
  lines.push(`Select an action:`);
  return lines.join("\n");
}

// ─── Share card ───────────────────────────────────────────────────────────────

export function shareCard(ep: {
  title:        string;
  feedTitle?:   string | null;
  pubDate?:     Date | string | null;
  duration?:    number | string | null;
  description?: string | null;
}): string {
  return [
    `🔗 *Recommended Episode*`,
    DIV,
    ep.feedTitle ? `📻 _${esc(trunc(ep.feedTitle, 30))}_` : "",
    `*${esc(trunc(ep.title, 40))}*`,
    ep.description ? `_${esc(trunc(ep.description, 140))}_` : "",
    ``,
    [ep.duration ? `⏱ ${esc(fmtDur(ep.duration))}` : "", ep.pubDate ? `📅 ${esc(fmtDate(ep.pubDate))}` : ""].filter(Boolean).join("  ·  "),
    ``,
    `_Shared via iCast_`,
  ].filter((l) => l !== undefined && l !== "").join("\n");
}

// ─── Daily digest ─────────────────────────────────────────────────────────────

export function digestMsg(
  episodes: Array<{ title: string; feedTitle?: string | null; duration?: string | null }>
): string {
  if (!episodes.length) {
    return [`📋 *Weekly Digest*`, DIV, ``, `No new episodes this week\\.`, `_Check back soon\\!_`].join("\n");
  }
  const lines = [
    `📋 *Weekly Digest*`,
    `_${episodes.length} new episodes waiting_`,
    DIV,
    ``,
  ];
  for (const [i, ep] of episodes.entries()) {
    const dur = ep.duration ? `  ·  ${esc(fmtDur(ep.duration))}` : "";
    lines.push(`*${i + 1}\\.* ${esc(trunc(ep.title, 30))}${dur}`);
    if (ep.feedTitle) lines.push(`   📻 _${esc(trunc(ep.feedTitle, 26))}_`);
  }
  return lines.join("\n");
}

// ─── Quote card ───────────────────────────────────────────────────────────────

export function quoteCard(quote: string, episodeTitle: string, feedTitle?: string | null): string {
  return [
    `💡 *Best Quote*`,
    DIV,
    ``,
    `❝ ${esc(trunc(quote, 300))} ❞`,
    ``,
    DIV_SM,
    `🎙 _${esc(trunc(episodeTitle, 34))}_`,
    feedTitle ? `📻 _${esc(trunc(feedTitle, 30))}_` : "",
  ].filter((l) => l !== "").join("\n");
}

// ─── Analytics card ───────────────────────────────────────────────────────────

export function analyticsCard(ep: {
  title:         string;
  duration?:     string | null;
  pubDate?:      Date | null;
  wordCount?:    number;
  speakerCount?: number;
}): string {
  const lines = [`📊 *Episode Analytics*`, `_${esc(trunc(ep.title, 30))}_`, DIV, ``];
  if (ep.duration)     lines.push(`${V.dot} Duration: *${esc(fmtDur(ep.duration))}*`);
  if (ep.pubDate)      lines.push(`${V.dot} Published: *${esc(fmtDate(ep.pubDate))}*`);
  if (ep.wordCount)    lines.push(`${V.dot} Est\\. words: *~${ep.wordCount.toLocaleString()}*`);
  if (ep.speakerCount) lines.push(`${V.dot} Speakers: *${ep.speakerCount}*`);
  return lines.join("\n");
}

// ─── History ─────────────────────────────────────────────────────────────────

export function historyMsg(
  eps: Array<{ title: string; feedTitle?: string | null; listenedAt?: Date | string | null }>
): string {
  if (!eps.length) {
    return [`📖 *Listening History*`, DIV, ``, `Nothing yet — start listening\\!`].join("\n");
  }
  return [
    `📖 *Listening History* \\(${eps.length}\\)`,
    DIV,
    eps.map((e, i) =>
      `*${i + 1}\\.* ${esc(trunc(e.title, 28))}\n   _${e.listenedAt ? esc(fmtDate(e.listenedAt)) : "Date unknown"}_`
    ).join(`\n`),
  ].join("\n");
}

// ─── Streak ──────────────────────────────────────────────────────────────────

export function streakMsg(streak: number, totalDays: number): string {
  const fire = "🔥".repeat(Math.min(streak, 7));
  return [
    `🔥 *Listening Streak*`,
    DIV,
    ``,
    fire || "No streak yet",
    ``,
    `*${streak}\\-day* current streak`,
    `*${totalDays}* total days listened`,
    ``,
    streak >= 7 ? `_Amazing consistency\\!_` :
    streak >= 3 ? `_Keep it up\\!_` :
                  `_Listen daily to build your streak\\!_`,
  ].join("\n");
}

// ─── Reminder ────────────────────────────────────────────────────────────────

export function reminderMsg(episodeTitle: string, mins: number): string {
  return [
    `⏰ *Reminder Set*`,
    DIV,
    ``,
    `🎙 _${esc(trunc(episodeTitle, 34))}_`,
    ``,
    `${V.dot} I'll remind you in *${mins}* minutes`,
  ].join("\n");
}

export function reminderDueMsg(episodeTitle: string): string {
  return [
    `⏰ *Time to Listen\\!*`,
    DIV,
    ``,
    `🎙 *${esc(trunc(episodeTitle, 38))}*`,
    ``,
    `_Your scheduled episode is ready\\!_`,
  ].join("\n");
}

// ─── Export ──────────────────────────────────────────────────────────────────

export function exportReadyMsg(format: string, count: number): string {
  return [
    `📤 *Export Ready*`,
    DIV,
    ``,
    `${V.dot} Format: *${esc(format)}*`,
    `${V.dot} Podcasts: *${count}*`,
  ].join("\n");
}

// ─── Mentions ────────────────────────────────────────────────────────────────

export function mentionsMsg(
  keyword: string,
  results: Array<{ title: string; feedTitle?: string | null; snippet?: string }>
): string {
  if (!results.length) {
    return [`🔍 *Transcript Search: "${esc(keyword)}"*`, DIV, ``, `No mentions found in your transcripts`].join("\n");
  }
  return [
    `🔍 *Transcript Search: "${esc(keyword)}"* · ${results.length} matches`,
    DIV,
    results.slice(0, 6).map((r, i) =>
      `*${i + 1}\\.* ${esc(trunc(r.title, 28))}\n   _${esc(trunc(r.snippet ?? "", 60))}_`
    ).join(`\n${DIV_SM}\n`),
  ].join("\n");
}

// ─── Goal ────────────────────────────────────────────────────────────────────

export function goalMsg(goalMins: number, achievedMins: number): string {
  const pct = Math.round(Math.min((achievedMins / goalMins) * 100, 100));
  return [
    `🎯 *Weekly Goal*`,
    `_${achievedMins}m / ${goalMins}m_`,
    DIV,
    ``,
    `${bar(pct)}  *${pct}%*`,
    ``,
    pct >= 100 ? `🎉 _Goal achieved\\!_` : `_${goalMins - achievedMins}m remaining this week_`,
  ].join("\n");
}

// ─── Back-compat shims ────────────────────────────────────────────────────────

export const fmt              = (lines: string[]) => lines.join("\n");
export const divider          = () => DIV;
export const shortDivider     = () => DIV_SM;
export const truncate         = trunc;
export const formatDuration   = fmtDur;
export const formatDate       = fmtDate;
export const progressBar      = bar;
