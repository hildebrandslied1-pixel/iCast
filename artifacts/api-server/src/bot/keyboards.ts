/**
 * keyboards.ts — All inline & reply keyboard definitions for iCast
 * Uses node-telegram-bot-api types
 */

import type TelegramBot from "node-telegram-bot-api";

type IRow = TelegramBot.InlineKeyboardButton[];
type IKB  = IRow[];

export const MAIN_KEYBOARD: TelegramBot.KeyboardButton[][] = [
  [{ text: "📻 My Feeds" },    { text: "🆕 Latest" },     { text: "🌍 Discover" }],
  [{ text: "🔍 Search" },      { text: "❤️ Favourites" }, { text: "⏭ Queue" }],
  [{ text: "📊 Stats" },       { text: "🔄 Refresh" },    { text: "⚙️ Settings" }],
  [{ text: "➕ Add RSS" }],
];

export const PANEL_BUTTONS: Record<string, string> = {
  "📻 My Feeds":    "feeds",
  "🆕 Latest":      "latest",
  "🌍 Discover":    "trending",
  "🔍 Search":      "search",
  "❤️ Favourites":  "favourites",
  "⏭ Queue":        "queue",
  "📊 Stats":       "stats",
  "🔄 Refresh":     "refresh",
  "⚙️ Settings":    "settings",
  "➕ Add RSS":     "add",
};

export const HOME_BTN: TelegramBot.InlineKeyboardButton = {
  text: "🏠 Home",
  callback_data: "menu",
};

export const homeRow = (): IRow => [HOME_BTN];

// ─── Admin keyboard ───────────────────────────────────────────────────────────

export const ADMIN_KEYBOARD: TelegramBot.KeyboardButton[][] = [
  [{ text: "👥 المستخدمون" },  { text: "📊 الإحصائيات" }],
  [{ text: "📨 رسالة فردية" }, { text: "📢 بث جماعي" }],
  [{ text: "🚷 حظر" },         { text: "✅ فك حظر" }],
  [{ text: "⭐ ترقية" },       { text: "⬇️ إلغاء ترقية" }],
  [{ text: "📋 السجلات" },     { text: "🏠 رجوع" }],
];

export const ADMIN_PANEL_BUTTONS: Record<string, string> = {
  "👥 المستخدمون":  "admin_users",
  "📊 الإحصائيات": "admin_stats",
  "📢 بث جماعي":   "admin_broadcast",
  "📋 السجلات":    "admin_logs",
  "🏠 رجوع":       "main_menu",
};

// ─── Feed actions ─────────────────────────────────────────────────────────────

export function feedActions(feedId: number): IKB {
  return [
    [
      { text: "▶️ Episodes",   callback_data: `feed:${feedId}` },
      { text: "🔄 Refresh",    callback_data: `refresh_feed:${feedId}` },
    ],
    [
      { text: "⭐ Rate",       callback_data: `feed:rate:${feedId}` },
      { text: "🗑 Remove",     callback_data: `del_feed_confirm:${feedId}` },
    ],
    homeRow(),
  ];
}

// ─── Episode actions (full set) ───────────────────────────────────────────────

export function episodeActions(
  epId: number,
  opts: {
    isFav?: boolean;
    isQueued?: boolean;
    hasTranscript?: boolean;
    progress?: number;
    isPlayed?: boolean;
  } = {}
): IKB {
  const { isFav, isQueued, hasTranscript, progress = 0, isPlayed } = opts;
  const kb: IKB = [
    [
      { text: "📥 تحميل الحلقة",    callback_data: `download:${epId}` },
      { text: "📄 تحميل Transcript", callback_data: `transcript:${epId}` },
    ],
    [
      { text: "💡 شرح عميق",    callback_data: `ep:deep:${epId}` },
      { text: "❓ 100 سؤال",    callback_data: `ep:questions:${epId}` },
    ],
    [
      { text: isFav    ? "❤️ مفضلة ✓"   : "🤍 مفضلة",    callback_data: `fav:${epId}` },
      { text: isQueued ? "✅ في القائمة" : "⏭ أضف للقائمة", callback_data: `queue_add:${epId}` },
    ],
    [
      { text: isPlayed ? "✅ تم الاستماع" : "🔲 مشاهدة",   callback_data: `listened:${epId}` },
      { text: "🏷 تصنيفات",                                  callback_data: `tag_pick:${epId}` },
    ],
    hasTranscript
      ? [
          { text: "📝 النص",        callback_data: `transcript:${epId}` },
          { text: "✨ ملخص",        callback_data: `ai_summary:${epId}` },
        ]
      : [
          { text: "✨ توليد ملخص",  callback_data: `ep:summarize:${epId}` },
          { text: "📝 تفريغ نصي",   callback_data: `ep:transcribe:${epId}` },
        ],
    [
      { text: "📝 إضافة ملاحظة", callback_data: `ep:addNote:${epId}` },
      { text: "🔗 مشاركة",       callback_data: `ep:share:${epId}` },
    ],
    [
      { text: "🤖 Ask AI",       callback_data: `ep:ask:${epId}` },
      { text: "◀️ رجوع",        callback_data: "cmd:latest" },
    ],
    [{ text: "🏠 الرئيسية",     callback_data: "menu" }],
  ];
  return kb;
}

// ─── Pagination ───────────────────────────────────────────────────────────────

export function paginationRow(prefix: string, page: number, total: number): IRow {
  const row: IRow = [];
  if (page > 0)          row.push({ text: "◀️ Prev", callback_data: `${prefix}:${page - 1}` });
  row.push({ text: `${page + 1} / ${total}`, callback_data: "noop" });
  if (page < total - 1)  row.push({ text: "Next ▶️", callback_data: `${prefix}:${page + 1}` });
  return row;
}

// ─── Confirm / cancel ─────────────────────────────────────────────────────────

export function confirmRow(confirmData: string, cancelData = "menu"): IKB {
  return [[
    { text: "✅ Confirm", callback_data: confirmData },
    { text: "❌ Cancel",  callback_data: cancelData },
  ]];
}

// ─── Queue item actions ───────────────────────────────────────────────────────

export function queueItemActions(epId: number, pos: number, total: number): IKB {
  return [
    [
      pos > 1     ? { text: "⬆️", callback_data: `queue:up:${epId}` }   : { text: "·", callback_data: "noop" },
      { text: "▶️", callback_data: `ep:${epId}` },
      pos < total ? { text: "⬇️", callback_data: `queue:down:${epId}` } : { text: "·", callback_data: "noop" },
    ],
    [{ text: "🗑 Remove", callback_data: `queue_rm:${epId}` }],
  ];
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export function settingsRows(prefs: {
  autoDownload: boolean;
  notifications: string;
  language: string;
}): IKB {
  return [
    [{ text: `⬇️ Auto-download: ${prefs.autoDownload ? "✅ On" : "❌ Off"}`, callback_data: "settings:toggle:autoDownload" }],
    [
      { text: prefs.notifications === "all"    ? "✅ All Notifications"    : "🔔 All Notifications",    callback_data: "settings:notif:all" },
      { text: prefs.notifications === "digest" ? "✅ Daily Digest"         : "📋 Daily Digest",         callback_data: "settings:notif:digest" },
      { text: prefs.notifications === "none"   ? "✅ Mute"                 : "🔕 Mute",                 callback_data: "settings:notif:none" },
    ],
    [
      { text: prefs.language === "en" ? "✅ English" : "🇬🇧 English", callback_data: "settings:lang:en" },
      { text: prefs.language === "ar" ? "✅ العربية" : "🇸🇦 Arabic",  callback_data: "settings:lang:ar" },
    ],
    homeRow(),
  ];
}

// ─── Rating ───────────────────────────────────────────────────────────────────

export function ratingKeyboard(feedId: number): IKB {
  return [
    [
      { text: "⭐",         callback_data: `feed:setRating:${feedId}:1` },
      { text: "⭐⭐",       callback_data: `feed:setRating:${feedId}:2` },
      { text: "⭐⭐⭐",     callback_data: `feed:setRating:${feedId}:3` },
    ],
    [
      { text: "⭐⭐⭐⭐",   callback_data: `feed:setRating:${feedId}:4` },
      { text: "⭐⭐⭐⭐⭐", callback_data: `feed:setRating:${feedId}:5` },
    ],
    [{ text: "❌ Cancel", callback_data: "menu" }],
  ];
}

// ─── Sleep timer ──────────────────────────────────────────────────────────────

export function sleepTimerRow(epId: number): IRow {
  return [
    { text: "🌙 15m", callback_data: `ep:sleep:${epId}:15` },
    { text: "🌙 30m", callback_data: `ep:sleep:${epId}:30` },
    { text: "🌙 60m", callback_data: `ep:sleep:${epId}:60` },
  ];
}

// ─── Speed selector ───────────────────────────────────────────────────────────

export function speedRow(epId: number): IRow {
  return [
    { text: "1×",   callback_data: `ep:speed:${epId}:1` },
    { text: "1.5×", callback_data: `ep:speed:${epId}:1.5` },
    { text: "2×",   callback_data: `ep:speed:${epId}:2` },
  ];
}

// ─── Discover categories ──────────────────────────────────────────────────────

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
      { text: "❤️ Health",     callback_data: "disc:cat:health" },
    ],
    [{ text: "🌍 Browse by Country", callback_data: "country_page:0" }],
    homeRow(),
  ];
}
