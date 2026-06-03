/**
 * keyboards.ts — iCast Complete Keyboard System
 * Design: Vaporwave British English · Logical sub-menus · Every feature accessible
 * Protocol: Each screen has ONE clear purpose and a back route
 */

import type TelegramBot from "node-telegram-bot-api";

type IRow = TelegramBot.InlineKeyboardButton[];
type IKB  = TelegramBot.InlineKeyboardButton[][];

// ─── Main Reply Keyboard ───────────────────────────────────────────────────────

export const MAIN_KEYBOARD: TelegramBot.KeyboardButton[][] = [
  [{ text: "🎙 My Podcasts" },   { text: "🆕 Latest Episodes" }],
  [{ text: "🔍 Search" },        { text: "🌍 Discover" }],
  [{ text: "⏭ Queue" },         { text: "❤️ Favourites" }],
  [{ text: "📊 Statistics" },    { text: "⚙️ Settings" }],
  [{ text: "➕ Add Podcast" }],
];

export const PANEL_BUTTONS: Record<string, string> = {
  "🎙 My Podcasts":      "feeds",
  "🆕 Latest Episodes":  "latest",
  "🔍 Search":           "search",
  "🌍 Discover":         "discover",
  "⏭ Queue":            "queue",
  "❤️ Favourites":      "favourites",
  "📊 Statistics":       "stats",
  "⚙️ Settings":        "settings",
  "➕ Add Podcast":      "add",
};

// ─── Admin Keyboard ────────────────────────────────────────────────────────────

export const ADMIN_KEYBOARD: TelegramBot.KeyboardButton[][] = [
  [{ text: "👥 Users" },        { text: "📋 Logs" }],
  [{ text: "📢 Broadcast" },    { text: "📊 Stats" }],
  [{ text: "🏠 Main Menu" }],
];

export const ADMIN_PANEL_BUTTONS: Record<string, string> = {
  "👥 Users":      "admin_users",
  "📋 Logs":       "admin_logs",
  "📢 Broadcast":  "admin_broadcast",
  "📊 Stats":      "admin_stats",
  "🏠 Main Menu":  "main_menu",
};

// ─── Shared Buttons ────────────────────────────────────────────────────────────

export const HOME_BTN: TelegramBot.InlineKeyboardButton = {
  text: "🏠 Home",
  callback_data: "menu",
};

export function homeRow(): IRow { return [HOME_BTN]; }

export function backBtn(to: string, label = "◀️ Back"): TelegramBot.InlineKeyboardButton {
  return { text: label, callback_data: to };
}

// ─── Episode Main Actions ─────────────────────────────────────────────────────
//
// Layout:
//   [▶️ Play]          [📥 Download]
//   [❤️ Favourite]     [⏭ Add to Queue]
//   ─────────────────────────────────
//   [🤖 AI Tools ▸]   [⚙️ Manage ▸]
//   ─────────────────────────────────
//   [✅ Mark Complete] [🏠 Home]
//

export function episodeActions(
  epId: number,
  opts: { isFav?: boolean; isQueued?: boolean; isPlayed?: boolean } = {}
): IKB {
  const { isFav, isQueued, isPlayed } = opts;
  return [
    [
      { text: "▶️ Play",                             callback_data: `play:${epId}` },
      { text: "📥 Download",                         callback_data: `download:${epId}` },
    ],
    [
      { text: isFav    ? "❤️ Favourited" : "🤍 Favourite", callback_data: `fav:${epId}` },
      { text: isQueued ? "✅ In Queue"   : "⏭ Add to Queue", callback_data: `queue_add:${epId}` },
    ],
    [
      { text: "🤖 AI Tools ▸",                       callback_data: `ep:ai:${epId}` },
      { text: "⚙️ Manage ▸",                         callback_data: `ep:manage:${epId}` },
    ],
    [
      { text: isPlayed ? "🔲 Mark Incomplete" : "✅ Mark Complete", callback_data: `listened:${epId}` },
      HOME_BTN,
    ],
  ];
}

// ─── AI Tools Sub-menu ────────────────────────────────────────────────────────
//
// Layout:
//   [✨ Summary]       [📝 Transcript]
//   [🎓 Deep Dive]     [❓ 100 Questions]
//   [💬 AI Chat]       [🌍 Translate]
//   [💡 Best Quote]    [📄 PDF Export]
//   [◀️ Back to Episode]
//

export function aiMenu(epId: number, hasTranscript = false): IKB {
  return [
    [
      { text: "✨ Summary",      callback_data: hasTranscript ? `ai_summary:${epId}` : `ep:summarize:${epId}` },
      { text: "📝 Transcript",   callback_data: `ep:transcribe:${epId}` },
    ],
    [
      { text: "🎓 Deep Dive",    callback_data: `ep:deep:${epId}` },
      { text: "❓ 100 Questions", callback_data: `ep:questions:${epId}` },
    ],
    [
      { text: "💬 AI Chat",      callback_data: `ep:ask:${epId}` },
      { text: "🌍 Translate",    callback_data: `ep:translate:${epId}` },
    ],
    [
      { text: "💡 Best Quote",   callback_data: `ep:quote:${epId}` },
      { text: "📄 PDF Export",   callback_data: `transcript:${epId}` },
    ],
    [
      backBtn(`ep:${epId}`, "◀️ Back to Episode"),
    ],
  ];
}

// ─── Management Sub-menu ──────────────────────────────────────────────────────
//
// Layout:
//   [📝 Add Note]      [🏷 Tags]
//   [🔖 Bookmark]      [🔗 Share]
//   [⏱ Sleep Timer]   [📊 Analytics]
//   [⏰ Remind Me]     [⏩ Skip Episode]
//   [◀️ Back to Episode]
//

export function manageMenu(epId: number): IKB {
  return [
    [
      { text: "📝 Add Note",     callback_data: `ep:addNote:${epId}` },
      { text: "🏷 Tags",         callback_data: `tag_pick:${epId}` },
    ],
    [
      { text: "🔖 Bookmark",     callback_data: `ep:bookmark:${epId}` },
      { text: "🔗 Share",        callback_data: `ep:share:${epId}` },
    ],
    [
      { text: "⏱ Sleep Timer",  callback_data: `ep:sleep_menu:${epId}` },
      { text: "📊 Analytics",    callback_data: `ep:analytics:${epId}` },
    ],
    [
      { text: "⏰ Remind Me",    callback_data: `ep:remind_menu:${epId}` },
      { text: "⏩ Skip Episode", callback_data: `ep:skip:${epId}` },
    ],
    [
      backBtn(`ep:${epId}`, "◀️ Back to Episode"),
    ],
  ];
}

// ─── Sleep Timer Sub-menu ─────────────────────────────────────────────────────

export function sleepTimerMenu(epId: number): IKB {
  return [
    [
      { text: "🌙 15 min",  callback_data: `ep:sleep:${epId}:15` },
      { text: "🌙 30 min",  callback_data: `ep:sleep:${epId}:30` },
    ],
    [
      { text: "🌙 45 min",  callback_data: `ep:sleep:${epId}:45` },
      { text: "🌙 60 min",  callback_data: `ep:sleep:${epId}:60` },
    ],
    [backBtn(`ep:manage:${epId}`, "◀️ Back to Manage")],
  ];
}

// ─── Reminder Sub-menu ────────────────────────────────────────────────────────

export function remindMenu(epId: number): IKB {
  return [
    [
      { text: "⏰ 10 min",   callback_data: `ep:remind:${epId}:10` },
      { text: "⏰ 30 min",   callback_data: `ep:remind:${epId}:30` },
    ],
    [
      { text: "⏰ 1 hour",   callback_data: `ep:remind:${epId}:60` },
      { text: "⏰ 3 hours",  callback_data: `ep:remind:${epId}:180` },
    ],
    [backBtn(`ep:manage:${epId}`, "◀️ Back to Manage")],
  ];
}

// ─── Feed Actions ──────────────────────────────────────────────────────────────

export function feedActions(feedId: number): IKB {
  return [
    [
      { text: "▶️ Episodes",     callback_data: `feed:${feedId}` },
      { text: "🔄 Refresh",      callback_data: `refresh_feed:${feedId}` },
    ],
    [
      { text: "⭐ Rate",          callback_data: `feed:rate:${feedId}` },
      { text: "🗑 Remove",        callback_data: `del_feed_confirm:${feedId}` },
    ],
    [
      { text: "🔔 Notifications", callback_data: `feed:notif:${feedId}` },
    ],
    homeRow(),
  ];
}

// ─── Notifications per Feed ────────────────────────────────────────────────────

export function feedNotifMenu(feedId: number, current: string): IKB {
  return [
    [
      { text: current === "all"   ? "✅ All episodes" : "🔔 All episodes",   callback_data: `feed:setNotif:${feedId}:all` },
      { text: current === "none"  ? "✅ Silent"       : "🔕 Silent",          callback_data: `feed:setNotif:${feedId}:none` },
    ],
    [backBtn(`feed:${feedId}`, "◀️ Back")],
  ];
}

// ─── Pagination ────────────────────────────────────────────────────────────────

export function paginationRow(prefix: string, page: number, total: number): IRow {
  const row: IRow = [];
  if (page > 0)         row.push({ text: "◀️ Prev", callback_data: `${prefix}:${page - 1}` });
  row.push({ text: `${page + 1} / ${total}`, callback_data: "noop" });
  if (page < total - 1) row.push({ text: "Next ▶️", callback_data: `${prefix}:${page + 1}` });
  return row;
}

// ─── Confirm ──────────────────────────────────────────────────────────────────

export function confirmRow(confirmData: string, cancelData = "menu"): IKB {
  return [[
    { text: "✅ Confirm", callback_data: confirmData },
    { text: "❌ Cancel",  callback_data: cancelData },
  ]];
}

// ─── Queue Item ───────────────────────────────────────────────────────────────

export function queueItemActions(epId: number, pos: number, total: number): IKB {
  return [
    [
      pos > 1     ? { text: "⬆️ Move Up",   callback_data: `queue:up:${epId}` }   : { text: "·", callback_data: "noop" },
      { text: "▶️ Play",                     callback_data: `ep:${epId}` },
      pos < total ? { text: "⬇️ Move Down", callback_data: `queue:down:${epId}` } : { text: "·", callback_data: "noop" },
    ],
    [{ text: "🗑 Remove from Queue", callback_data: `queue_rm:${epId}` }],
  ];
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export function settingsRows(prefs: {
  autoDownload:   boolean;
  notifications:  string;
  language:       string;
  playbackSpeed?: string;
}): IKB {
  const speed = prefs.playbackSpeed ?? "1";
  return [
    [{ text: `⬇️ Auto-download: ${prefs.autoDownload ? "✅ On" : "❌ Off"}`, callback_data: "settings:toggle:autoDownload" }],
    [
      { text: prefs.notifications === "all"    ? "✅ All Notifications" : "🔔 All",    callback_data: "settings:notif:all" },
      { text: prefs.notifications === "digest" ? "✅ Daily Digest"      : "📋 Digest", callback_data: "settings:notif:digest" },
      { text: prefs.notifications === "none"   ? "✅ Silent"            : "🔕 Silent", callback_data: "settings:notif:none" },
    ],
    [
      { text: prefs.language === "en" ? "✅ English 🇬🇧" : "🇬🇧 English", callback_data: "settings:lang:en" },
      { text: prefs.language === "ar" ? "✅ Arabic 🇸🇦"  : "🇸🇦 Arabic",  callback_data: "settings:lang:ar" },
    ],
    [
      { text: speed === "0.75" ? "✅ 0.75×" : "0.75×", callback_data: "settings:speed:0.75" },
      { text: speed === "1"    ? "✅ 1×"    : "1×",    callback_data: "settings:speed:1" },
      { text: speed === "1.25" ? "✅ 1.25×" : "1.25×", callback_data: "settings:speed:1.25" },
      { text: speed === "1.5"  ? "✅ 1.5×"  : "1.5×",  callback_data: "settings:speed:1.5" },
      { text: speed === "2"    ? "✅ 2×"    : "2×",    callback_data: "settings:speed:2" },
    ],
    homeRow(),
  ];
}

// ─── Rating ───────────────────────────────────────────────────────────────────

export function ratingKeyboard(feedId: number): IKB {
  return [
    [
      { text: "⭐ 1",     callback_data: `feed:setRating:${feedId}:1` },
      { text: "⭐⭐ 2",   callback_data: `feed:setRating:${feedId}:2` },
      { text: "⭐⭐⭐ 3", callback_data: `feed:setRating:${feedId}:3` },
    ],
    [
      { text: "⭐⭐⭐⭐ 4",   callback_data: `feed:setRating:${feedId}:4` },
      { text: "⭐⭐⭐⭐⭐ 5", callback_data: `feed:setRating:${feedId}:5` },
    ],
    [{ text: "❌ Cancel", callback_data: "menu" }],
  ];
}

// ─── Discover Categories ──────────────────────────────────────────────────────

export function discoverCategoriesKb(): IKB {
  return [
    [
      { text: "💻 Technology",  callback_data: "disc:cat:technology" },
      { text: "🔬 Science",     callback_data: "disc:cat:science" },
    ],
    [
      { text: "💼 Business",    callback_data: "disc:cat:business" },
      { text: "🎭 Comedy",      callback_data: "disc:cat:comedy" },
    ],
    [
      { text: "📰 News",        callback_data: "disc:cat:news" },
      { text: "🏛 History",     callback_data: "disc:cat:history" },
    ],
    [
      { text: "🎓 Education",   callback_data: "disc:cat:education" },
      { text: "❤️ Health",      callback_data: "disc:cat:health" },
    ],
    [
      { text: "🎵 Music",       callback_data: "disc:cat:music" },
      { text: "🌍 Society",     callback_data: "disc:cat:society" },
    ],
    [{ text: "🗺 Browse by Country", callback_data: "country_page:0" }],
    homeRow(),
  ];
}

// ─── Speed Row ────────────────────────────────────────────────────────────────

export function speedRow(epId: number): IRow {
  return [
    { text: "0.75×", callback_data: `ep:speed:${epId}:0.75` },
    { text: "1×",    callback_data: `ep:speed:${epId}:1` },
    { text: "1.25×", callback_data: `ep:speed:${epId}:1.25` },
    { text: "1.5×",  callback_data: `ep:speed:${epId}:1.5` },
    { text: "2×",    callback_data: `ep:speed:${epId}:2` },
  ];
}

export function sleepTimerRow(epId: number): IRow {
  return [
    { text: "🌙 15m", callback_data: `ep:sleep:${epId}:15` },
    { text: "🌙 30m", callback_data: `ep:sleep:${epId}:30` },
    { text: "🌙 60m", callback_data: `ep:sleep:${epId}:60` },
  ];
}

// ─── Compare Episodes ─────────────────────────────────────────────────────────

export function compareStartKb(epId: number, candidates: Array<{ id: number; title: string }>): IKB {
  const rows: IKB = candidates.slice(0, 5).map((c) => [
    { text: `Compare with: ${c.title.slice(0, 28)}`, callback_data: `compare:${epId}:${c.id}` },
  ]);
  rows.push([backBtn(`ep:${epId}`, "◀️ Cancel")]);
  return rows;
}

// ─── Export Format ────────────────────────────────────────────────────────────

export function exportFormatKb(): IKB {
  return [
    [
      { text: "📄 OPML",  callback_data: "export:opml" },
      { text: "📊 JSON",  callback_data: "export:json" },
    ],
    homeRow(),
  ];
}
