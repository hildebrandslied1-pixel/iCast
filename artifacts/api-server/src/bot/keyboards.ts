/**
 * keyboards.ts — iCast complete keyboard system
 * Design principle: Paginated sub-menus, 2-column max, logical grouping
 * Every screen has a clear purpose and back button
 */

import type TelegramBot from "node-telegram-bot-api";

type IRow = TelegramBot.InlineKeyboardButton[];
type IKB  = TelegramBot.InlineKeyboardButton[][];

// ─── Main reply keyboard ──────────────────────────────────────────────────────

export const MAIN_KEYBOARD: TelegramBot.KeyboardButton[][] = [
  [{ text: "📻 بودكاستاتي" }, { text: "🆕 آخر الحلقات" }],
  [{ text: "🔍 بحث" },        { text: "🌍 اكتشاف" }],
  [{ text: "⏭ القائمة" },    { text: "❤️ المفضلة" }],
  [{ text: "📊 إحصائياتي" },  { text: "⚙️ الإعدادات" }],
  [{ text: "➕ إضافة RSS" }],
];

export const PANEL_BUTTONS: Record<string, string> = {
  "📻 بودكاستاتي":  "feeds",
  "🆕 آخر الحلقات": "latest",
  "🔍 بحث":         "search",
  "🌍 اكتشاف":      "discover",
  "⏭ القائمة":     "queue",
  "❤️ المفضلة":    "favourites",
  "📊 إحصائياتي":  "stats",
  "⚙️ الإعدادات": "settings",
  "➕ إضافة RSS":  "add",
};

// ─── Admin keyboard ───────────────────────────────────────────────────────────

export const ADMIN_KEYBOARD: TelegramBot.KeyboardButton[][] = [
  [{ text: "👥 المستخدمون" }, { text: "📋 السجلات" }],
  [{ text: "📢 بث جماعي" },  { text: "📊 الإحصائيات" }],
  [{ text: "🏠 رجوع" }],
];

export const ADMIN_PANEL_BUTTONS: Record<string, string> = {
  "👥 المستخدمون":  "admin_users",
  "📋 السجلات":    "admin_logs",
  "📢 بث جماعي":  "admin_broadcast",
  "📊 الإحصائيات": "admin_stats",
  "🏠 رجوع":       "main_menu",
};

// ─── Shared buttons ───────────────────────────────────────────────────────────

export const HOME_BTN: TelegramBot.InlineKeyboardButton = {
  text: "🏠 الرئيسية",
  callback_data: "menu",
};

export function homeRow(): IRow { return [HOME_BTN]; }

export function backBtn(to: string, label = "◀️ رجوع"): TelegramBot.InlineKeyboardButton {
  return { text: label, callback_data: to };
}

// ─── Episode main keyboard (CLEAN — 3 sections) ───────────────────────────────

export function episodeActions(
  epId: number,
  opts: {
    isFav?:        boolean;
    isQueued?:     boolean;
    isPlayed?:     boolean;
    hasTranscript?: boolean;
    progress?:     number;
  } = {}
): IKB {
  const { isFav, isQueued, isPlayed, hasTranscript } = opts;

  return [
    // ── Row 1: Primary ───────────────────────────────────────────────────
    [
      { text: isPlayed ? "✅ مكتملة" : "▶️ تشغيل",   callback_data: `play:${epId}` },
      { text: "📥 تحميل",                              callback_data: `download:${epId}` },
    ],
    // ── Row 2: Save ──────────────────────────────────────────────────────
    [
      { text: isFav    ? "❤️ في المفضلة" : "🤍 مفضلة", callback_data: `fav:${epId}` },
      { text: isQueued ? "✅ في القائمة" : "⏭ أضف",    callback_data: `queue_add:${epId}` },
    ],
    // ── Row 3: AI Sub-menu ────────────────────────────────────────────────
    [
      { text: "🤖 AI مساعد ▸",  callback_data: `ep:ai:${epId}` },
    ],
    // ── Row 4: Manage sub-menu ────────────────────────────────────────────
    [
      { text: "⚙️ إدارة الحلقة ▸",  callback_data: `ep:manage:${epId}` },
    ],
    // ── Row 5: Mark + Home ────────────────────────────────────────────────
    [
      { text: isPlayed ? "🔲 إلغاء" : "✅ تم الاستماع", callback_data: `listened:${epId}` },
      HOME_BTN,
    ],
  ];
}

// ─── AI Sub-menu ─────────────────────────────────────────────────────────────

export function aiMenu(epId: number, hasTranscript = false): IKB {
  return [
    [
      { text: "✨ ملخص",          callback_data: hasTranscript ? `ai_summary:${epId}` : `ep:summarize:${epId}` },
      { text: "📝 تفريغ نصي",    callback_data: `ep:transcribe:${epId}` },
    ],
    [
      { text: "🎓 شرح عميق",     callback_data: `ep:deep:${epId}` },
      { text: "❓ 100 سؤال",     callback_data: `ep:questions:${epId}` },
    ],
    [
      { text: "💬 محادثة AI",    callback_data: `ep:ask:${epId}` },
      { text: "🌍 ترجمة الملخص", callback_data: `ep:translate:${epId}` },
    ],
    [
      { text: "💡 اقتباس رائع",  callback_data: `ep:quote:${epId}` },
      { text: "📄 PDF النص",     callback_data: `transcript:${epId}` },
    ],
    [
      backBtn(`ep:${epId}`, "◀️ رجوع للحلقة"),
    ],
  ];
}

// ─── Management Sub-menu ──────────────────────────────────────────────────────

export function manageMenu(epId: number): IKB {
  return [
    [
      { text: "📝 ملاحظة",       callback_data: `ep:addNote:${epId}` },
      { text: "🏷 تصنيفات",      callback_data: `tag_pick:${epId}` },
    ],
    [
      { text: "🔖 إشارة مرجعية", callback_data: `ep:bookmark:${epId}` },
      { text: "🔗 مشاركة",       callback_data: `ep:share:${epId}` },
    ],
    [
      { text: "⏱ مؤقت نوم",    callback_data: `ep:sleep_menu:${epId}` },
      { text: "📊 تحليل",        callback_data: `ep:analytics:${epId}` },
    ],
    [
      backBtn(`ep:${epId}`, "◀️ رجوع للحلقة"),
    ],
  ];
}

// ─── Sleep Timer options ──────────────────────────────────────────────────────

export function sleepTimerMenu(epId: number): IKB {
  return [
    [
      { text: "🌙 15 دقيقة", callback_data: `ep:sleep:${epId}:15` },
      { text: "🌙 30 دقيقة", callback_data: `ep:sleep:${epId}:30` },
    ],
    [
      { text: "🌙 45 دقيقة", callback_data: `ep:sleep:${epId}:45` },
      { text: "🌙 60 دقيقة", callback_data: `ep:sleep:${epId}:60` },
    ],
    [
      backBtn(`ep:manage:${epId}`, "◀️ رجوع"),
    ],
  ];
}

// ─── Feed actions ─────────────────────────────────────────────────────────────

export function feedActions(feedId: number): IKB {
  return [
    [
      { text: "▶️ الحلقات",     callback_data: `feed:${feedId}` },
      { text: "🔄 تحديث",       callback_data: `refresh_feed:${feedId}` },
    ],
    [
      { text: "⭐ تقييم",        callback_data: `feed:rate:${feedId}` },
      { text: "🗑 إزالة",        callback_data: `del_feed_confirm:${feedId}` },
    ],
    homeRow(),
  ];
}

// ─── Pagination ───────────────────────────────────────────────────────────────

export function paginationRow(prefix: string, page: number, total: number): IRow {
  const row: IRow = [];
  if (page > 0)         row.push({ text: "◀️ السابق", callback_data: `${prefix}:${page - 1}` });
  row.push({ text: `${page + 1} / ${total}`, callback_data: "noop" });
  if (page < total - 1) row.push({ text: "التالي ▶️", callback_data: `${prefix}:${page + 1}` });
  return row;
}

// ─── Confirm row ──────────────────────────────────────────────────────────────

export function confirmRow(confirmData: string, cancelData = "menu"): IKB {
  return [[
    { text: "✅ تأكيد", callback_data: confirmData },
    { text: "❌ إلغاء", callback_data: cancelData },
  ]];
}

// ─── Queue item ───────────────────────────────────────────────────────────────

export function queueItemActions(epId: number, pos: number, total: number): IKB {
  return [
    [
      pos > 1     ? { text: "⬆️", callback_data: `queue:up:${epId}` }   : { text: "·", callback_data: "noop" },
      { text: "▶️ تشغيل",        callback_data: `ep:${epId}` },
      pos < total ? { text: "⬇️", callback_data: `queue:down:${epId}` } : { text: "·", callback_data: "noop" },
    ],
    [{ text: "🗑 إزالة من القائمة", callback_data: `queue_rm:${epId}` }],
  ];
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export function settingsRows(prefs: {
  autoDownload:  boolean;
  notifications: string;
  language:      string;
}): IKB {
  return [
    [{ text: `⬇️ تحميل تلقائي: ${prefs.autoDownload ? "✅ مفعّل" : "❌ معطّل"}`, callback_data: "settings:toggle:autoDownload" }],
    [
      { text: prefs.notifications === "all"    ? "✅ كل الإشعارات" : "🔔 كل الإشعارات",    callback_data: "settings:notif:all" },
      { text: prefs.notifications === "digest" ? "✅ ملخص يومي"     : "📋 ملخص يومي",       callback_data: "settings:notif:digest" },
      { text: prefs.notifications === "none"   ? "✅ صامت"          : "🔕 صامت",            callback_data: "settings:notif:none" },
    ],
    [
      { text: prefs.language === "en" ? "✅ English" : "🇬🇧 English", callback_data: "settings:lang:en" },
      { text: prefs.language === "ar" ? "✅ العربية" : "🇸🇦 العربية", callback_data: "settings:lang:ar" },
    ],
    homeRow(),
  ];
}

// ─── Rating ───────────────────────────────────────────────────────────────────

export function ratingKeyboard(feedId: number): IKB {
  return [
    [
      { text: "⭐",       callback_data: `feed:setRating:${feedId}:1` },
      { text: "⭐⭐",     callback_data: `feed:setRating:${feedId}:2` },
      { text: "⭐⭐⭐",   callback_data: `feed:setRating:${feedId}:3` },
    ],
    [
      { text: "⭐⭐⭐⭐",   callback_data: `feed:setRating:${feedId}:4` },
      { text: "⭐⭐⭐⭐⭐", callback_data: `feed:setRating:${feedId}:5` },
    ],
    [{ text: "❌ إلغاء", callback_data: "menu" }],
  ];
}

// ─── Discover categories ──────────────────────────────────────────────────────

export function discoverCategoriesKb(): IKB {
  return [
    [
      { text: "💻 تقنية",     callback_data: "disc:cat:technology" },
      { text: "🔬 علوم",      callback_data: "disc:cat:science" },
    ],
    [
      { text: "💼 أعمال",     callback_data: "disc:cat:business" },
      { text: "🎭 كوميديا",  callback_data: "disc:cat:comedy" },
    ],
    [
      { text: "📰 أخبار",     callback_data: "disc:cat:news" },
      { text: "🏛 تاريخ",    callback_data: "disc:cat:history" },
    ],
    [
      { text: "🎓 تعليم",     callback_data: "disc:cat:education" },
      { text: "❤️ صحة",      callback_data: "disc:cat:health" },
    ],
    [{ text: "🌍 تصفح حسب الدولة", callback_data: "country_page:0" }],
    homeRow(),
  ];
}

// ─── Speed selector ───────────────────────────────────────────────────────────

export function speedRow(epId: number): IRow {
  return [
    { text: "0.75×", callback_data: `ep:speed:${epId}:0.75` },
    { text: "1×",    callback_data: `ep:speed:${epId}:1` },
    { text: "1.25×", callback_data: `ep:speed:${epId}:1.25` },
    { text: "1.5×",  callback_data: `ep:speed:${epId}:1.5` },
    { text: "2×",    callback_data: `ep:speed:${epId}:2` },
  ];
}

// ─── Sleep timer row ──────────────────────────────────────────────────────────

export function sleepTimerRow(epId: number): IRow {
  return [
    { text: "🌙 15م", callback_data: `ep:sleep:${epId}:15` },
    { text: "🌙 30م", callback_data: `ep:sleep:${epId}:30` },
    { text: "🌙 60م", callback_data: `ep:sleep:${epId}:60` },
  ];
}
