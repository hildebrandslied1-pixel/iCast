/**
 * formatter.ts — iCast Vaporwave British English UI
 * Aesthetic: ░▒▓ neon-wave retro-future ▓▒░
 * Language: British English throughout
 */

// ─── Vaporwave Design Tokens ──────────────────────────────────────────────────

export const V = {
  logo:   `░▒▓ ｉＣＡＳＴ ▓▒░`,
  wave:   `～～～～～～～～～～`,
  line:   `━━━━━━━━━━━━━━━━━━━`,
  thin:   `─────────────────────`,
  dbl:    `════════════════════`,
  spark:  `✦`,
  dot:    `▸`,
  fill:   `◆`,
  empty:  `◇`,
  block:  `▓`,
  shade:  `░`,
};

export const DIV     = V.thin;
export const DIV_SM  = `──────────────`;
export const LOGO    = V.logo;
export const WAVE    = V.wave;

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

// ─── Vaporwave header builder ─────────────────────────────────────────────────

function vHeader(title: string, sub?: string): string {
  const lines = [
    `*${V.logo}*`,
    V.dbl,
    `*${esc(title)}*`,
  ];
  if (sub) lines.push(`_${esc(sub)}_`);
  return lines.join("\n");
}

// ─── Welcome ──────────────────────────────────────────────────────────────────

export function welcomeMsg(
  name: string,
  resumeEp?: { title: string; progress: number } | null
): string {
  const lines = [
    `*${V.logo}*`,
    V.dbl,
    ``,
    `Welcome back, *${esc(name)}* ✦`,
    ``,
    `_Your personal AI\\-powered podcast manager_`,
    ``,
    V.wave,
    ``,
    `${V.dot} *My Podcasts* · *Latest Episodes*`,
    `${V.dot} *Search* · *Discover* · *Queue*`,
    `${V.dot} *Favourites* · *Statistics* · *Settings*`,
  ];
  if (resumeEp) {
    lines.push(``, V.thin, `▶️ *Continue Listening*`);
    lines.push(`🎙 ${esc(trunc(resumeEp.title, 30))}`);
    lines.push(`${bar(resumeEp.progress)} ${resumeEp.progress}%`);
  }
  return lines.join("\n");
}

// ─── Help ─────────────────────────────────────────────────────────────────────

export function helpMsg(): string {
  return [
    vHeader("COMMANDS", "All available commands"),
    V.wave,
    ``,
    `📻 *PODCASTS*`,
    `\`/add\`  Add RSS feed`,
    `\`/feeds\`  My subscriptions`,
    `\`/latest\`  Recent episodes`,
    `\`/search\`  Search episodes`,
    `\`/random\`  Random episode`,
    `\`/new\`  New in last 48h`,
    `\`/popular\`  Most played`,
    `\`/recent\`  Recently played`,
    ``,
    `🤖 *AI TOOLS*`,
    `\`/digest\`  Weekly digest`,
    `\`/recommend\`  AI recommendations`,
    `\`/mentions\`  Search transcripts`,
    `\`/compare\`  Compare episodes`,
    ``,
    `📊 *TRACKING*`,
    `\`/stats\`  My statistics`,
    `\`/streak\`  Listening streak`,
    `\`/history\`  Listening history`,
    `\`/goal\`  Weekly listening goal`,
    `\`/now\`  Current episode`,
    ``,
    `🗂 *LIBRARY*`,
    `\`/queue\`  Playback queue`,
    `\`/favourites\`  Saved episodes`,
    `\`/notes\`  My notes`,
    `\`/export\`  Export library`,
    `\`/import\`  Import OPML`,
    ``,
    `⚙️ *SETTINGS*`,
    `\`/settings\`  Preferences`,
    `\`/remind\`  Set a reminder`,
    `\`/goal\`  Listening goal`,
    ``,
    `🛡 *ADMIN*`,
    `\`/admin\`  Admin panel`,
    `\`/adminsetup\`  Setup admin access`,
  ].join("\n");
}

// ─── About ────────────────────────────────────────────────────────────────────

export function aboutMsg(): string {
  return [
    vHeader("iCAST v3.2", "AI Podcast Manager"),
    V.wave,
    ``,
    `${V.spark} Whisper AI transcription`,
    `${V.spark} Groq LLaMA summaries`,
    `${V.spark} Harvard\\-style deep analysis`,
    `${V.spark} 100 critical thinking questions`,
    `${V.spark} Professional PDF transcripts`,
    `${V.spark} Advanced access control`,
    `${V.spark} Statistics & streak tracking`,
    `${V.spark} Sleep timer & playback speed`,
    `${V.spark} Smart playlists & queue`,
    `${V.spark} Bookmarks, notes & tags`,
    ``,
    V.thin,
    `_Powered by Groq · Whisper · LLaMA_`,
  ].join("\n");
}

// ─── Add prompt ───────────────────────────────────────────────────────────────

export function addPromptMsg(): string {
  return [
    vHeader("ADD PODCAST", "Subscribe to an RSS feed"),
    V.wave,
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
    vHeader("PODCAST FOUND", "Subscribe to this podcast?"),
    V.wave,
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
    vHeader("SUBSCRIBED!", ""),
    ``,
    `📻 *${esc(trunc(feed.title, 36))}*`,
    feed.episodeCount ? `🎧 ${feed.episodeCount} episodes ready to play` : "",
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
  if (feed.author) lines.push(`${V.dot} ${esc(trunc(feed.author, 24))}`);

  const meta: string[] = [];
  if (feed.episodeCount) meta.push(`🎧 ${feed.episodeCount}`);
  if (feed.lastUpdated)  meta.push(`📅 ${fmtDate(feed.lastUpdated)}`);
  if (meta.length)       lines.push(meta.join("  ·  "));

  if (feed.unreadCount && feed.unreadCount > 0) lines.push(`🔵 ${feed.unreadCount} new`);
  if (feed.rating) lines.push("⭐".repeat(feed.rating));
  return lines.join("\n");
}

// ─── Episode card (Vaporwave) ─────────────────────────────────────────────────

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

  const lines: string[] = [
    `*${V.logo}*`,
    V.dbl,
  ];

  if (ep.feedTitle) lines.push(`📻 _${esc(trunc(ep.feedTitle, 32))}_`);
  lines.push(``, `*${esc(numStr)}${esc(trunc(ep.title, 38))}*`, ``);

  const meta: string[] = [];
  if (dur)  meta.push(`⏱ ${esc(dur)}`);
  if (date) meta.push(`📅 ${esc(date)}`);
  if (meta.length) lines.push(meta.join("  ·  "));

  lines.push(V.wave);

  if (isPlayed) {
    lines.push(`✅ *Completed*`);
  } else if (pct > 0) {
    lines.push(`${bar(pct)}  *${pct}%*`);
  } else {
    lines.push(`${V.empty.repeat(10)}  _Not started_`);
  }

  const badges: string[] = [];
  if (isNew)      badges.push("🆕 New");
  if (isFav)      badges.push("❤️ Favourite");
  if (ep.inQueue) badges.push("⏭ Queued");
  if (badges.length) lines.push(``, badges.join("  ${V.dot}  "));

  return lines.join("\n");
}

// ─── Feed list ────────────────────────────────────────────────────────────────

export function feedListMsg(feeds: any[]): string {
  if (!feeds.length) {
    return [vHeader("MY PODCASTS", "No subscriptions yet"), ``, `Use /add or /discover to get started`].join("\n");
  }
  return [
    vHeader(`MY PODCASTS (${feeds.length})`, "Your subscriptions"),
    V.wave,
    feeds.map((f, i) => feedCard(f, i)).join(`\n${DIV_SM}\n`),
  ].join("\n");
}

// ─── Episode list ─────────────────────────────────────────────────────────────

export function episodeListMsg(eps: any[], feedTitle?: string, page = 1, total = 1): string {
  const header = feedTitle
    ? vHeader(trunc(feedTitle, 26), `Episodes`)
    : vHeader("LATEST EPISODES", "");
  const pg = total > 1 ? `  ·  Page ${page}/${total}` : "";
  if (!eps.length) return [header, ``, `No episodes found`].join("\n");
  return [header + esc(pg), V.wave, eps.map((e) => episodeCard(e)).join(`\n${DIV_SM}\n`)].join("\n");
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
    vHeader("MY STATISTICS", "Your listening overview"),
    V.wave,
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
    lines.push(``, V.thin, weeklyBarChart(s.weeklyMins));
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
    return [vHeader("QUEUE", "Empty"), ``, `Add episodes from /latest or any episode page`].join("\n");
  }
  return [
    vHeader(`QUEUE (${eps.length})`, "Your playback queue"),
    V.wave,
    eps.map((e, i) => {
      const dur = fmtDur(e.duration);
      return `*${i + 1}\\.* ${esc(trunc(e.title, 28))}${dur ? `  ·  ${esc(dur)}` : ""}`;
    }).join("\n"),
  ].join("\n");
}

// ─── Search results ───────────────────────────────────────────────────────────

export function searchResultsMsg(query: string, results: any[]): string {
  const q = esc(trunc(query, 20));
  if (!results.length) {
    return [vHeader("SEARCH", `"${query}"`), ``, `No results found`, `_Try a different keyword_`].join("\n");
  }
  return [
    vHeader("SEARCH RESULTS", `"${query}" · ${results.length} found`),
    V.wave,
    results.slice(0, 8).map((r, i) =>
      `*${i + 1}\\.* ${esc(trunc(r.title, 28))}${r.author ? `\n   _${esc(trunc(r.author, 22))}_` : ""}`
    ).join("\n"),
  ].join("\n");
}

// ─── Summary ──────────────────────────────────────────────────────────────────

export function summaryMsg(title: string, summary: string): string {
  return [
    vHeader("AI SUMMARY", trunc(title, 30)),
    V.wave,
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
    prefs.notifications === "all"    ? "🔔 All notifications" :
    prefs.notifications === "digest" ? "📋 Daily digest only" : "🔕 Silent";
  const speed = prefs.playbackSpeed ?? "1";
  return [
    vHeader("SETTINGS", "Your preferences"),
    V.wave,
    ``,
    `${V.dot} Auto\\-download: ${prefs.autoDownload ? "✅ On" : "❌ Off"}`,
    `${V.dot} Notifications: ${esc(notifLabel)}`,
    `${V.dot} Language: ${prefs.language === "ar" ? "🇸🇦 Arabic" : "🇬🇧 English"}`,
    `${V.dot} Playback speed: ${esc(speed)}×`,
  ].join("\n");
}

// ─── Notes ────────────────────────────────────────────────────────────────────

export function notesMsg(
  notes: Array<{ episodeTitle: string; note: string; createdAt: Date | string }>
): string {
  if (!notes.length) {
    return [vHeader("MY NOTES", ""), ``, `No notes yet`, `_Tap 📝 on any episode to add one_`].join("\n");
  }
  return [
    vHeader(`MY NOTES (${notes.length})`, "Your episode notes"),
    V.wave,
    notes.map((n, i) =>
      `*${i + 1}\\.* ${esc(trunc(n.episodeTitle, 24))}\n   _"${esc(trunc(n.note, 50))}"_`
    ).join(`\n${DIV_SM}\n`),
  ].join("\n");
}

// ─── Discover ─────────────────────────────────────────────────────────────────

export function discoverMsg(): string {
  return [
    vHeader("DISCOVER PODCASTS", "Explore thousands of shows"),
    V.wave,
    ``,
    `Browse by category or country`,
    ``,
    `Choose a category below ${V.spark}`,
  ].join("\n");
}

// ─── Playlist ─────────────────────────────────────────────────────────────────

export function playlistMsg(eps: any[], totalMins: number): string {
  return [
    vHeader("SMART PLAYLIST", `~${Math.round(totalMins)}m · ${eps.length} episodes`),
    V.wave,
    eps.map((e, i) => `*${i + 1}\\.* ${esc(trunc(e.title, 28))}`).join("\n"),
  ].join("\n");
}

// ─── Celebration ──────────────────────────────────────────────────────────────

export function celebrationMsg(title: string): string {
  return [
    vHeader("EPISODE COMPLETE!", "Well done ✦"),
    V.wave,
    ``,
    `🎙 _${esc(trunc(title, 34))}_`,
    ``,
    `_Keep learning, keep growing\\!_ 🚀`,
  ].join("\n");
}

// ─── Admin panel ──────────────────────────────────────────────────────────────

export function adminPanelMsg(stats?: {
  totalUsers: number; pendingUsers: number; blockedUsers: number;
}): string {
  const lines = [vHeader("ADMIN PANEL", "System Control Centre"), V.wave, ``];
  if (stats) {
    lines.push(`👥 Total users: *${stats.totalUsers}*`);
    lines.push(`⏳ Pending approval: *${stats.pendingUsers}*`);
    lines.push(`🚷 Blocked: *${stats.blockedUsers}*`);
    lines.push(``, V.thin);
  }
  lines.push(`Select an action below:`);
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
    vHeader("RECOMMENDED EPISODE", "Shared via iCast"),
    V.wave,
    ep.feedTitle ? `📻 _${esc(trunc(ep.feedTitle, 30))}_` : "",
    `*${esc(trunc(ep.title, 40))}*`,
    ep.description ? `_${esc(trunc(ep.description, 140))}_` : "",
    ``,
    [ep.duration ? `⏱ ${esc(fmtDur(ep.duration))}` : "", ep.pubDate ? `📅 ${esc(fmtDate(ep.pubDate))}` : ""].filter(Boolean).join("  ·  "),
    ``,
    `_Discover more with iCast_`,
  ].filter((l) => l !== undefined).join("\n");
}

// ─── Daily digest ─────────────────────────────────────────────────────────────

export function digestMsg(
  episodes: Array<{ title: string; feedTitle?: string | null; duration?: string | null }>
): string {
  if (!episodes.length) {
    return [vHeader("WEEKLY DIGEST", "No new episodes this week"), ``, `_Check back soon\\!_`].join("\n");
  }
  const lines = [
    vHeader("WEEKLY DIGEST", `${episodes.length} new episodes waiting`),
    V.wave,
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
    vHeader("BEST QUOTE", "Extracted by AI"),
    V.wave,
    ``,
    `❝ ${esc(trunc(quote, 300))} ❞`,
    ``,
    V.thin,
    `🎙 _${esc(trunc(episodeTitle, 32))}_`,
    feedTitle ? `📻 _${esc(trunc(feedTitle, 28))}_` : "",
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
  const lines = [vHeader("EPISODE ANALYTICS", trunc(ep.title, 28)), V.wave, ``];
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
    return [vHeader("LISTENING HISTORY", ""), ``, `Nothing yet — start listening\\!`].join("\n");
  }
  return [
    vHeader(`HISTORY (${eps.length})`, "Recently completed"),
    V.wave,
    eps.map((e, i) =>
      `*${i + 1}\\.* ${esc(trunc(e.title, 26))}\n   _${e.listenedAt ? esc(fmtDate(e.listenedAt)) : "unknown date"}_`
    ).join(`\n`),
  ].join("\n");
}

// ─── Streak ──────────────────────────────────────────────────────────────────

export function streakMsg(streak: number, totalDays: number): string {
  const fire = "🔥".repeat(Math.min(streak, 7));
  return [
    vHeader("LISTENING STREAK", "Daily consistency"),
    V.wave,
    ``,
    `${fire}`,
    ``,
    `*${streak}\\-day* current streak`,
    `*${totalDays}* total days listened`,
    ``,
    streak >= 7 ? `${V.spark} _Amazing consistency\\!_` :
    streak >= 3 ? `${V.spark} _Keep it up\\!_` :
                  `${V.spark} _Listen daily to build your streak\\!_`,
  ].join("\n");
}

// ─── Reminder ────────────────────────────────────────────────────────────────

export function reminderMsg(episodeTitle: string, mins: number): string {
  return [
    vHeader("REMINDER SET", ""),
    ``,
    `🎙 _${esc(trunc(episodeTitle, 32))}_`,
    ``,
    `${V.dot} Reminder in *${mins}* minutes`,
  ].join("\n");
}

export function reminderDueMsg(episodeTitle: string): string {
  return [
    vHeader("REMINDER!", "Time to listen"),
    V.wave,
    ``,
    `🎙 *${esc(trunc(episodeTitle, 36))}*`,
    ``,
    `_Your scheduled episode is ready\\!_`,
  ].join("\n");
}

// ─── Export ──────────────────────────────────────────────────────────────────

export function exportReadyMsg(format: string, count: number): string {
  return [
    vHeader("EXPORT READY", ""),
    ``,
    `${V.dot} Format: *${esc(format)}*`,
    `${V.dot} Podcasts exported: *${count}*`,
  ].join("\n");
}

// ─── Mentions ────────────────────────────────────────────────────────────────

export function mentionsMsg(
  keyword: string,
  results: Array<{ title: string; feedTitle?: string | null; snippet?: string }>
): string {
  if (!results.length) {
    return [vHeader("TRANSCRIPT SEARCH", `"${keyword}"`), ``, `No mentions found in your transcripts`].join("\n");
  }
  return [
    vHeader("TRANSCRIPT SEARCH", `"${keyword}" · ${results.length} matches`),
    V.wave,
    results.slice(0, 6).map((r, i) =>
      `*${i + 1}\\.* ${esc(trunc(r.title, 26))}\n   _${esc(trunc(r.snippet ?? "", 60))}_`
    ).join(`\n${DIV_SM}\n`),
  ].join("\n");
}

// ─── Goal ────────────────────────────────────────────────────────────────────

export function goalMsg(goalMins: number, achievedMins: number): string {
  const pct = Math.round(Math.min((achievedMins / goalMins) * 100, 100));
  return [
    vHeader("WEEKLY GOAL", `${achievedMins}m / ${goalMins}m`),
    V.wave,
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
