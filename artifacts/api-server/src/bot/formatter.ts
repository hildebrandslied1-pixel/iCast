/**
 * formatter.ts — All Telegram message formatting for iCast
 * Rules:
 *  - MarkdownV2 only — all user-provided strings must pass through esc()
 *  - One divider style: ──────────────
 *  - Mobile-first: keep lines short (≤ 32 chars where possible)
 */

export const DIV = "──────────────";

/** Escape all MarkdownV2 special characters */
export function esc(t: string): string {
  if (!t) return "";
  return t.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

/** Truncate to n chars, breaking at last word boundary */
export function trunc(t: string, n = 32): string {
  if (!t) return "";
  if (t.length <= n) return t;
  const cut = t.slice(0, n).replace(/\s+\S*$/, "");
  return (cut.length > 2 ? cut : t.slice(0, n)) + "…";
}

/** Format seconds → "1h 23m" or "45m" */
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
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Format a date */
export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** Progress bar — 8 blocks wide */
export function bar(pct: number): string {
  const f = Math.round(Math.max(0, Math.min(100, pct)) / 100 * 8);
  return "█".repeat(f) + "░".repeat(8 - f);
}

/** Spinner frames */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Loading bar message (step 0..4) */
export function loadingMsg(step: number, label = "Updating"): string {
  const s = Math.max(0, Math.min(4, step));
  return `⟳ ${label}\n${"█".repeat(s)}${"░".repeat(4 - s)}`;
}

export function doneMsg(label: string): string {
  return `✅ ${esc(label)}`;
}

export function errorMsg(msg: string, hint?: string): string {
  const lines = [`⚠️ ${esc(msg)}`];
  if (hint) lines.push(esc(hint));
  return lines.join("\n");
}

export function softError(situation: string, action: string): string {
  return [`😕 ${esc(situation)}`, esc(action)].join("\n");
}

// ─── Welcome ──────────────────────────────────────────────────────────────────

export function welcomeMsg(name: string, resumeEp?: { title: string; progress: number } | null): string {
  const lines = [
    `🎙 *iCast*`,
    DIV,
    `Hello ${esc(name)} 👋`,
    ``,
    `Listen · Discover · Follow`,
    DIV,
    `📻 /feeds`,
    `🆕 /latest`,
    `🔍 /search`,
    `⚙️ /settings`,
  ];
  if (resumeEp) {
    lines.push(DIV);
    lines.push(`▶️ *Continue Listening*`);
    lines.push(`🎙 ${esc(trunc(resumeEp.title, 28))}`);
    lines.push(`${bar(resumeEp.progress)} ${resumeEp.progress}%`);
  }
  return lines.join("\n");
}

// ─── Help ─────────────────────────────────────────────────────────────────────

export function helpMsg(): string {
  return [
    `📖 *Commands*`,
    DIV,
    `/add — Add a podcast`,
    `/feeds — My subscriptions`,
    `/latest — Latest episodes`,
    `/search — Search episodes`,
    `/queue — Playback queue`,
    `/favourites — Favourites`,
    `/stats — My statistics`,
    `/discover — Discover podcasts`,
    `/resume — Continue listening`,
    `/refresh — Refresh all feeds`,
    `/settings — Preferences`,
    `/notes — My notes`,
    `/tsearch — Search transcripts`,
    `/ask — Ask AI about episode`,
    `/playlist — Build a playlist`,
    `/import — Import OPML file`,
    `/about — About iCast`,
  ].join("\n");
}

// ─── About ────────────────────────────────────────────────────────────────────

export function aboutMsg(): string {
  return [
    `🎙 *iCast v2\\.0*`,
    DIV,
    `Your personal podcast manager`,
    `Powered by Groq AI`,
    DIV,
    `🌐 Discover podcasts worldwide`,
    `🧠 AI transcription & summaries`,
    `📝 Notes & bookmarks`,
    `📊 Listening statistics`,
  ].join("\n");
}

// ─── Add prompt ───────────────────────────────────────────────────────────────

export function addPromptMsg(): string {
  return [
    `📥 *Add a Podcast*`,
    DIV,
    `Send an RSS feed URL`,
    `Example:`,
    `https://feeds\\.example\\.com/feed\\.rss`,
  ].join("\n");
}

export function addPreviewMsg(feed: { title: string; description?: string; episodeCount?: number; image?: string }): string {
  const lines = [
    `📻 *${esc(trunc(feed.title, 28))}*`,
    DIV,
  ];
  if (feed.description) lines.push(esc(trunc(feed.description, 80)));
  if (feed.episodeCount) lines.push(`🎧 ${feed.episodeCount} episodes`);
  lines.push(DIV);
  lines.push(`Add this podcast?`);
  return lines.join("\n");
}

export function addSuccessMsg(feed: { title: string; episodeCount?: number }): string {
  return [
    `✅ *Subscribed\\!*`,
    DIV,
    `📻 ${esc(trunc(feed.title, 28))}`,
    feed.episodeCount ? `🎧 ${feed.episodeCount} episodes ready` : "",
  ].filter(Boolean).join("\n");
}

// ─── Feed card ────────────────────────────────────────────────────────────────

export function feedCard(
  feed: {
    title: string;
    author?: string;
    episodeCount?: number;
    lastUpdated?: Date | string | null;
    unreadCount?: number;
    rating?: number;
  },
  i?: number
): string {
  const num = i !== undefined ? `${i + 1}\\. ` : "";
  const lines = [`${num}📻 *${esc(trunc(feed.title, 26))}*`];
  if (feed.author) lines.push(`👤 ${esc(trunc(feed.author, 22))}`);

  const meta: string[] = [];
  if (feed.episodeCount) meta.push(`🎧 ${feed.episodeCount}`);
  if (feed.lastUpdated) meta.push(`📅 ${fmtDate(feed.lastUpdated)}`);
  if (meta.length) lines.push(meta.join("  ·  "));

  if (feed.unreadCount && feed.unreadCount > 0) {
    lines.push(`🔵 ${feed.unreadCount} new`);
  }
  if (feed.rating) {
    lines.push("⭐".repeat(feed.rating));
  }
  return lines.join("\n");
}

// ─── Episode card ─────────────────────────────────────────────────────────────

export function episodeCard(ep: {
  title: string;
  feedTitle?: string;
  pubDate?: Date | string | null;
  duration?: number | string | null;
  progress?: number | null;
  listened?: boolean;
  isPlayed?: boolean;
  isFavourite?: boolean;
  isFav?: boolean;
  inQueue?: boolean;
  episodeNumber?: number | null;
}): string {
  const isPlayed = ep.listened || ep.isPlayed;
  const isFav = ep.isFavourite || ep.isFav;

  const now = Date.now();
  const isNew = ep.pubDate && (now - new Date(ep.pubDate).getTime()) < 48 * 3600 * 1000;

  const badge = [
    isNew ? "🆕" : "",
    isFav ? "❤️" : "",
    ep.progress && ep.progress > 0 && !isPlayed ? `▶️ ${ep.progress}%` : "",
    isPlayed ? "✅" : "",
  ].filter(Boolean).join("  ");

  const lines: string[] = [];
  const numStr = ep.episodeNumber ? `EP\\.${ep.episodeNumber} ` : "";
  lines.push(`🎙 ${numStr}*${esc(trunc(ep.title, 28))}*`);
  if (badge) lines.push(badge);

  const meta: string[] = [];
  if (ep.pubDate) meta.push(fmtDate(ep.pubDate));
  if (ep.duration) meta.push(fmtDur(ep.duration));
  if (meta.filter(Boolean).length) lines.push(meta.filter(Boolean).join("  ·  "));

  if (ep.feedTitle) lines.push(`📻 ${esc(trunc(ep.feedTitle, 22))}`);

  if (ep.progress && ep.progress > 0 && !isPlayed) {
    lines.push(`${bar(ep.progress)} ${ep.progress}%`);
  }
  return lines.join("\n");
}

// ─── Feed list ────────────────────────────────────────────────────────────────

export function feedListMsg(feeds: any[]): string {
  if (!feeds.length) {
    return [
      `📭 *No Subscriptions Yet*`,
      DIV,
      `Add one with /add`,
      `Or discover with /discover`,
    ].join("\n");
  }
  return [
    `📻 *My Subscriptions* \\(${feeds.length}\\)`,
    DIV,
    feeds.map((f, i) => feedCard(f, i)).join("\n" + DIV + "\n"),
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
    ? `🎙 *${esc(trunc(feedTitle, 22))}*`
    : `🎧 *Latest Episodes*`;
  const pg = total > 1 ? `  ·  ${page}\\/${total}` : "";
  if (!eps.length) return [header, DIV, `No episodes found`].join("\n");
  return [
    `${header}${pg}`,
    DIV,
    eps.map((e) => episodeCard(e)).join("\n" + DIV + "\n"),
  ].join("\n");
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export function statsMsg(s: {
  feedCount: number;
  playedCount: number;
  totalMinutes: number;
  favouriteCount: number;
  streak?: number;
  lastListened?: Date | string | null;
  queueCount?: number;
  tagCount?: number;
  transcribedCount?: number;
  weeklyMins?: number[];
}): string {
  const h = Math.floor(s.totalMinutes / 60);
  const m = s.totalMinutes % 60;
  const timeStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
  const lines = [
    `📊 *My Statistics*`,
    DIV,
    `📻  ${s.feedCount} podcasts`,
    `✅  ${s.playedCount} episodes played`,
    `⏱  ${timeStr} listened`,
    `❤️  ${s.favouriteCount} favourites`,
  ];
  if (s.queueCount !== undefined) lines.push(`⏭  ${s.queueCount} in queue`);
  if (s.transcribedCount) lines.push(`📝  ${s.transcribedCount} transcribed`);
  if (s.tagCount !== undefined) lines.push(`🏷  ${s.tagCount} tags`);
  if (s.streak) lines.push(`🔥  ${s.streak} day streak`);
  if (s.lastListened) lines.push(`🕐  Last: ${fmtDate(s.lastListened)}`);

  if (s.weeklyMins && s.weeklyMins.length === 7) {
    lines.push(DIV);
    lines.push(weeklyBarChart(s.weeklyMins));
  }
  return lines.join("\n");
}

export function weeklyBarChart(dailyMins: number[]): string {
  const days = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const max  = Math.max(...dailyMins, 1);
  return dailyMins
    .map((m, i) => {
      const h = Math.round((m / max) * 5);
      return `${days[i]} ${"█".repeat(h)}${"░".repeat(5 - h)}`;
    })
    .join("\n");
}

// ─── Queue ────────────────────────────────────────────────────────────────────

export function queueMsg(eps: any[]): string {
  if (!eps.length) {
    return [`📭 *Queue Is Empty*`, DIV, `Add episodes from /latest`].join("\n");
  }
  const list = eps
    .map((e, i) => {
      const dur = fmtDur(e.duration);
      return `${i + 1}\\. ${esc(trunc(e.title, 24))}${dur ? `  · ${dur}` : ""}`;
    })
    .join("\n");
  return [`🗂 *Playback Queue* \\(${eps.length}\\)`, DIV, list].join("\n");
}

// ─── Search results ───────────────────────────────────────────────────────────

export function searchResultsMsg(query: string, results: any[]): string {
  const q = esc(trunc(query, 18));
  if (!results.length) {
    return [`🔍 *"${q}"*`, DIV, `No results found`, `Try a different keyword`].join("\n");
  }
  const list = results
    .slice(0, 8)
    .map(
      (r, i) =>
        `${i + 1}\\. *${esc(trunc(r.title, 24))}*${r.author ? `\n   👤 ${esc(trunc(r.author, 18))}` : ""}`
    )
    .join("\n");
  return [`🔍 *"${q}"* — ${results.length}`, DIV, list].join("\n");
}

// ─── Summary ──────────────────────────────────────────────────────────────────

export function summaryMsg(title: string, summary: string): string {
  return [
    `✨ *Summary*`,
    DIV,
    `🎙 ${esc(trunc(title, 28))}`,
    DIV,
    esc(trunc(summary, 800)),
  ].join("\n");
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export function settingsMsg(prefs: {
  autoDownload: boolean;
  notifications: string;
  language: string;
}): string {
  const notifLabel =
    prefs.notifications === "all"
      ? "🔔 All"
      : prefs.notifications === "digest"
      ? "📋 Digest"
      : "🔕 None";
  return [
    `⚙️ *Settings*`,
    DIV,
    `⬇️ Auto\\-download: ${prefs.autoDownload ? "✅ On" : "❌ Off"}`,
    `🔔 Notifications: ${esc(notifLabel)}`,
    `🌐 Language: ${esc(prefs.language === "ar" ? "العربية" : "English")}`,
  ].join("\n");
}

// ─── Notes ────────────────────────────────────────────────────────────────────

export function notesMsg(
  notes: Array<{ episodeTitle: string; note: string; createdAt: Date | string }>
): string {
  if (!notes.length) {
    return [`📭 *No Notes Yet*`, DIV, `Tap 📝 on any episode`].join("\n");
  }
  const list = notes
    .map(
      (n, i) =>
        `${i + 1}\\. *${esc(trunc(n.episodeTitle, 22))}*\n   📝 ${esc(trunc(n.note, 38))}`
    )
    .join("\n" + DIV + "\n");
  return [`📝 *My Notes*`, DIV, list].join("\n");
}

// ─── Discover ─────────────────────────────────────────────────────────────────

export function discoverMsg(): string {
  return [
    `🌍 *Discover Podcasts*`,
    DIV,
    `Browse trending podcasts by country`,
    `or search the iTunes catalogue`,
  ].join("\n");
}

// ─── Playlist ─────────────────────────────────────────────────────────────────

export function playlistMsg(eps: any[], totalMins: number): string {
  return [
    `🎵 *New Playlist*`,
    DIV,
    `⏱ ~${Math.round(totalMins)} min · ${eps.length} episodes`,
    DIV,
    eps.map((e, i) => `${i + 1}\\. ${esc(trunc(e.title, 24))}`).join("\n"),
  ].join("\n");
}

// ─── Celebration ──────────────────────────────────────────────────────────────

export function celebrationMsg(title: string): string {
  return [`🎉 *Episode Complete\\!*`, DIV, `🎙 ${esc(trunc(title, 28))}`].join("\n");
}

// ─── Back-compat shims (used in existing code) ────────────────────────────────

export const divider  = () => DIV;
export const shortDivider = () => "──────────";
export const fmt = (lines: string[]) => lines.join("\n");
export const truncate = trunc;
export const formatDuration = fmtDur;
export const formatDate = fmtDate;
export const progressBar = bar;

export function parseDuration(dur: string | null | undefined): number {
  if (!dur) return 0;
  const parts = dur.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(dur) || 0;
}
