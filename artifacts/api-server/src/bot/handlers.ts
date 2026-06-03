/**
 * handlers.ts — iCast Telegram Bot Handler
 * All messages use MarkdownV2. All dynamic text is escaped with esc().
 */

import TelegramBot from "node-telegram-bot-api";
import {
  db, feedsTable, episodesTable, favoritesTable,
  queueTable, tagsTable, episodeTagsTable,
  userPrefsTable, bookmarksTable, ratingsTable,
  usersTable, adminLogsTable, userActivityTable,
} from "@workspace/db";
import { eq, and, desc, like, count, sql, or, gt, isNotNull, inArray } from "drizzle-orm";
import { fetchFeed, isValidFeedUrl } from "./rss.js";
import {
  fetchTopCharts, searchPodcasts, resolveRssFeed,
  getCountriesPage, totalCountryPages, findCountry,
  getCachedPodcast,
} from "./discover.js";
import { generateTranscriptPdf } from "./pdf.js";
import {
  transcribeEpisodeFull, summarizeText, generateSummary,
  generateDeepExplanation,
  generateCriticalQuestions, chatWithEpisode, getRecommendations,
  hasGroqKey,
} from "./ai.js";
import { sendEpisodeAudio } from "./downloader.js";
import {
  V, DIV, DIV_SM, LOGO, WAVE,
  esc, trunc, fmtDur, fmtDate, bar,
  welcomeMsg, helpMsg, aboutMsg, addPromptMsg, addPreviewMsg, addSuccessMsg,
  feedCard, episodeCard, feedListMsg, episodeListMsg, statsMsg,
  queueMsg, searchResultsMsg, summaryMsg, settingsMsg, notesMsg,
  discoverMsg, playlistMsg, celebrationMsg, doneMsg, errorMsg,
  softError, loadingMsg, weeklyBarChart, adminPanelMsg,
  shareCard, digestMsg, quoteCard, analyticsCard,
  historyMsg, streakMsg, reminderMsg, reminderDueMsg,
  exportReadyMsg, mentionsMsg, goalMsg,
  fmt, divider, shortDivider, truncate, formatDuration, formatDate,
  progressBar, parseDuration,
} from "./formatter.js";
import {
  MAIN_KEYBOARD, PANEL_BUTTONS, homeRow, HOME_BTN,
  ADMIN_KEYBOARD, ADMIN_PANEL_BUTTONS,
  feedActions, episodeActions, aiMenu, manageMenu,
  sleepTimerMenu, remindMenu, exportFormatKb,
  paginationRow, confirmRow, queueItemActions, settingsRows, ratingKeyboard,
  sleepTimerRow, speedRow, discoverCategoriesKb, feedNotifMenu,
} from "./keyboards.js";
import { logger } from "../lib/logger.js";
import {
  getOrCreateUser, handleStart, handleCaptchaAnswer,
  authGate, logActivity,
} from "./auth-flow.js";
import {
  notifyAdmins, logAdminAction, approveUser, rejectUser,
  blockUser, unblockUser, promoteUser, demoteUser,
  broadcastMessage, isAdmin, getAdminChatIds,
} from "./admin.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const PAGE_SIZE  = 5;
const CHART_PAGE = 10;
const SPINNER    = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ─── Rate Limiting ────────────────────────────────────────────────────────────

const rateLimits = new Map<number, number[]>();

function checkRateLimit(userId: number, maxPerMin = 30): boolean {
  const now = Date.now();
  const times = (rateLimits.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (times.length >= maxPerMin) return false;
  times.push(now);
  rateLimits.set(userId, times);
  return true;
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

type SessionAction =
  | "awaiting_rss"
  | "awaiting_rss_confirm"
  | "awaiting_search"
  | "awaiting_browse"
  | "awaiting_country_code"
  | "awaiting_tag_name"
  | "awaiting_tag_ep"
  | "awaiting_note"
  | "awaiting_ask";

interface Session {
  action?: SessionAction;
  extra?: number;
  pendingFeed?: { url: string; title: string; description?: string; episodeCount: number; imageUrl?: string };
  currentEpisodeId?: number;
  askHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  lastActive: number;
}

const sessions = new Map<number, Session>();

function getSession(id: number): Session {
  const s = sessions.get(id);
  if (s) {
    if (Date.now() - s.lastActive > SESSION_TTL) {
      sessions.set(id, { lastActive: Date.now() });
      return sessions.get(id)!;
    }
    s.lastActive = Date.now();
    return s;
  }
  sessions.set(id, { lastActive: Date.now() });
  return sessions.get(id)!;
}

function clearSession(id: number): void {
  sessions.set(id, { lastActive: Date.now() });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type Opts = TelegramBot.SendMessageOptions;

const MV2 = "MarkdownV2" as const;

const sendMd = (bot: TelegramBot, chatId: number, text: string, opts?: Opts) =>
  bot.sendMessage(chatId, text, { parse_mode: MV2, disable_web_page_preview: true, ...opts });

const editMd = (
  bot: TelegramBot, chatId: number, msgId: number, text: string,
  keyboard?: TelegramBot.InlineKeyboardMarkup
) =>
  bot.editMessageText(text, {
    chat_id: chatId, message_id: msgId,
    parse_mode: MV2, reply_markup: keyboard,
    disable_web_page_preview: true,
  }).catch(() => {});

/** Normalise a DB episode for the formatter (converts 0-1 progress to 0-100) */
function normEp(ep: any, feedTitle?: string): Parameters<typeof episodeCard>[0] {
  return {
    title:         ep.title,
    feedTitle,
    pubDate:       ep.pubDate,
    duration:      ep.duration,
    progress:      ep.progress != null ? Math.round(ep.progress * 100) : undefined,
    listened:      ep.listened,
    isFavourite:   ep.isFav,
    episodeNumber: ep.episodeNumber,
  };
}

function escMd(text: string): string { return esc(text); }

/** Build a Postgres ANY() array literal for Drizzle */
function sqlArr(ids: number[]): ReturnType<typeof sql> {
  if (!ids.length) return sql`ARRAY[]::int[]`;
  return sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::int[]`;
}

/** Split long text into Telegram-safe chunks (≤ 4096 chars) */
function splitLong(text: string, max = 4000): string[] {
  const chunks: string[] = [];
  let rem = text;
  while (rem.length > max) {
    let cut = rem.lastIndexOf("\n\n", max);
    if (cut < max * 0.6) cut = rem.lastIndexOf("\n", max);
    if (cut < 1) cut = max;
    chunks.push(rem.slice(0, cut).trim());
    rem = rem.slice(cut).trim();
  }
  if (rem) chunks.push(rem);
  return chunks;
}

/** Send long text in multiple messages */
async function sendLongText(bot: TelegramBot, chatId: number, text: string): Promise<void> {
  for (const chunk of splitLong(text)) {
    await bot.sendMessage(chatId, chunk);
  }
}

/** Spinner animation for long operations */
async function withSpinner(
  bot: TelegramBot, chatId: number, label: string, fn: () => Promise<void>
): Promise<void> {
  const msg = await bot.sendMessage(chatId, `${SPINNER[0]} ${label}…`);
  let spinIdx = 0;
  const interval = setInterval(async () => {
    spinIdx = (spinIdx + 1) % SPINNER.length;
    await bot.editMessageText(`${SPINNER[spinIdx]} ${label}…`, {
      chat_id: chatId, message_id: msg.message_id,
    }).catch(() => {});
  }, 400);
  try {
    await fn();
  } finally {
    clearInterval(interval);
    await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
  }
}

// ─── User Preferences ─────────────────────────────────────────────────────────

async function getUserPrefs(chatId: string): Promise<{ autoDownload: boolean; notifications: string; language: string; playbackSpeed: string }> {
  const prefs = await db.select().from(userPrefsTable).where(eq(userPrefsTable.chatId, chatId)).limit(1);
  if (prefs[0]) return prefs[0] as any;
  return { autoDownload: false, notifications: "all", language: "en", playbackSpeed: "1" };
}

async function upsertUserPrefs(chatId: string, update: Partial<{ autoDownload: boolean; notifications: string; language: string; playbackSpeed: string }>): Promise<void> {
  await db.insert(userPrefsTable).values({ chatId, ...update }).onConflictDoUpdate({
    target: userPrefsTable.chatId,
    set: { ...update, updatedAt: new Date() },
  });
}

// ─── REGISTER ────────────────────────────────────────────────────────────────

export function registerHandlers(bot: TelegramBot): void {

  // ── Rate limit middleware helper ─────────────────────────────────────────
  function rl(msg: TelegramBot.Message): boolean {
    if (!msg.from?.id) return false;
    if (!checkRateLimit(msg.from.id)) {
      void bot.sendMessage(msg.chat.id, "⚠️ You are sending too many requests\\. Please slow down\\.", { parse_mode: MV2 });
      return false;
    }
    logger.info({ userId: msg.from?.id, chatId: msg.chat.id }, "message received");
    return true;
  }

  // ── Slash commands ──────────────────────────────────────────────────────
  bot.onText(/^\/start/, async (msg) => {
    if (!rl(msg)) return;
    logger.info({ userId: msg.from?.id, command: "/start" }, "command received");

    // Auth flow: captcha / approval gate
    const intercepted = await handleStart(bot, msg);
    if (intercepted) return;

    // Normal welcome
    const name = msg.from?.first_name ?? "Friend";
    const resumeEp = await getResumeEpisode(String(msg.chat.id));
    let resumeInfo: { title: string; progress: number } | null = null;
    if (resumeEp) {
      resumeInfo = { title: resumeEp.title, progress: Math.round((resumeEp.progress ?? 0) * 100) };
      getSession(msg.chat.id).currentEpisodeId = resumeEp.id;
    }
    void logActivity(String(msg.chat.id), "start");
    await sendMd(bot, msg.chat.id, welcomeMsg(name, resumeInfo), {
      reply_markup: { keyboard: MAIN_KEYBOARD, resize_keyboard: true, is_persistent: true },
    });
  });

  bot.onText(/^\/help/, (msg) => {
    if (!rl(msg)) return;
    logger.info({ userId: msg.from?.id, command: "/help" }, "command received");
    void sendMd(bot, msg.chat.id, helpMsg());
  });

  bot.onText(/^\/about/, (msg) => {
    if (!rl(msg)) return;
    void sendMd(bot, msg.chat.id, aboutMsg());
  });

  bot.onText(/^\/menu/, (msg) => {
    if (!rl(msg)) return;
    void sendMenu(bot, msg.chat.id);
  });

  bot.onText(/^\/feeds/, (msg) => {
    if (!rl(msg)) return;
    logger.info({ userId: msg.from?.id, command: "/feeds" }, "command received");
    void cmdFeeds(bot, msg.chat.id);
  });

  bot.onText(/^\/latest/, (msg) => {
    if (!rl(msg)) return;
    logger.info({ userId: msg.from?.id, command: "/latest" }, "command received");
    void cmdLatest(bot, msg.chat.id);
  });

  bot.onText(/^\/queue/, (msg) => {
    if (!rl(msg)) return;
    logger.info({ userId: msg.from?.id, command: "/queue" }, "command received");
    void cmdQueue(bot, msg.chat.id);
  });

  bot.onText(/^\/favourites|^\/favorites/, (msg) => {
    if (!rl(msg)) return;
    logger.info({ userId: msg.from?.id, command: "/favourites" }, "command received");
    void cmdFavourites(bot, msg.chat.id);
  });

  bot.onText(/^\/tags/, (msg) => {
    if (!rl(msg)) return;
    void cmdTags(bot, msg.chat.id);
  });

  bot.onText(/^\/stats/, (msg) => {
    if (!rl(msg)) return;
    logger.info({ userId: msg.from?.id, command: "/stats" }, "command received");
    void cmdStats(bot, msg.chat.id);
  });

  bot.onText(/^\/refresh/, (msg) => {
    if (!rl(msg)) return;
    logger.info({ userId: msg.from?.id, command: "/refresh" }, "command received");
    void cmdRefreshAll(bot, msg.chat.id);
  });

  bot.onText(/^\/trending/, (msg) => {
    if (!rl(msg)) return;
    void showCountryPicker(bot, msg.chat.id, 0);
  });

  bot.onText(/^\/discover/, (msg) => {
    if (!rl(msg)) return;
    logger.info({ userId: msg.from?.id, command: "/discover" }, "command received");
    void cmdDiscover(bot, msg.chat.id);
  });

  bot.onText(/^\/add/, (msg) => {
    if (!rl(msg)) return;
    logger.info({ userId: msg.from?.id, command: "/add" }, "command received");
    getSession(msg.chat.id).action = "awaiting_rss";
    void sendMd(bot, msg.chat.id, addPromptMsg(), { reply_markup: { inline_keyboard: [homeRow()] } });
  });

  bot.onText(/^\/search(.*)/, (msg, match) => {
    if (!rl(msg)) return;
    logger.info({ userId: msg.from?.id, command: "/search" }, "command received");
    const inline = match?.[1]?.trim();
    if (inline) {
      void handleEpisodeSearch(bot, msg.chat.id, inline);
    } else {
      getSession(msg.chat.id).action = "awaiting_search";
      void sendMd(bot, msg.chat.id, `🔍 *Search Episodes*\n${DIV}\nSend a keyword to search:`, {
        reply_markup: { inline_keyboard: [homeRow()] },
      });
    }
  });

  bot.onText(/^\/browse/, (msg) => {
    if (!rl(msg)) return;
    getSession(msg.chat.id).action = "awaiting_browse";
    void sendMd(bot, msg.chat.id, `🌐 *Browse iTunes*\n${DIV}\nEnter a show name or topic:`, {
      reply_markup: { inline_keyboard: [homeRow()] },
    });
  });

  bot.onText(/^\/resume/, (msg) => {
    if (!rl(msg)) return;
    logger.info({ userId: msg.from?.id, command: "/resume" }, "command received");
    void cmdResume(bot, msg.chat.id);
  });

  bot.onText(/^\/settings/, (msg) => {
    if (!rl(msg)) return;
    logger.info({ userId: msg.from?.id, command: "/settings" }, "command received");
    void cmdSettings(bot, msg.chat.id);
  });

  bot.onText(/^\/notes/, (msg) => {
    if (!rl(msg)) return;
    void cmdNotes(bot, msg.chat.id);
  });

  bot.onText(/^\/tsearch(.*)/, (msg, match) => {
    if (!rl(msg)) return;
    const inline = match?.[1]?.trim();
    if (inline) {
      void handleTranscriptSearch(bot, msg.chat.id, inline);
    } else {
      void sendMd(bot, msg.chat.id, `🔍 *Transcript Search*\n${DIV}\nUsage: /tsearch keyword`);
    }
  });

  bot.onText(/^\/ask(.*)/, (msg, match) => {
    if (!rl(msg)) return;
    const inline = match?.[1]?.trim();
    void cmdAsk(bot, msg.chat.id, inline || "");
  });

  bot.onText(/^\/playlist(.*)/, (msg, match) => {
    if (!rl(msg)) return;
    const inline = match?.[1]?.trim();
    void cmdPlaylist(bot, msg.chat.id, inline || "");
  });

  bot.onText(/^\/import/, (msg) => {
    if (!rl(msg)) return;
    void sendMd(bot, msg.chat.id, [`📂 *استيراد OPML*`, DIV, `أرسل ملف \.opml لاستيراد اشتراكاتك\\.`].join("\n"));
  });

  bot.onText(/^\/random/, async (msg) => {
    if (!rl(msg)) return;
    void cmdRandom(bot, msg.chat.id);
  });

  bot.onText(/^\/digest/, async (msg) => {
    if (!rl(msg)) return;
    void cmdDigest(bot, msg.chat.id);
  });

  bot.onText(/^\/recommend/, async (msg) => {
    if (!rl(msg)) return;
    void cmdRecommend(bot, msg.chat.id);
  });

  bot.onText(/^\/streak/, async (msg) => {
    if (!rl(msg)) return;
    void cmdStreak(bot, msg.chat.id);
  });

  bot.onText(/^\/history/, async (msg) => {
    if (!rl(msg)) return;
    void cmdHistory(bot, msg.chat.id);
  });

  bot.onText(/^\/recent/, async (msg) => {
    if (!rl(msg)) return;
    void cmdRecent(bot, msg.chat.id);
  });

  bot.onText(/^\/popular/, async (msg) => {
    if (!rl(msg)) return;
    void cmdPopular(bot, msg.chat.id);
  });

  bot.onText(/^\/new/, async (msg) => {
    if (!rl(msg)) return;
    void cmdNewEpisodes(bot, msg.chat.id);
  });

  bot.onText(/^\/export/, async (msg) => {
    if (!rl(msg)) return;
    await cmdExport(bot, msg.chat.id);
  });

  bot.onText(/^\/mentions\s+(.+)/, async (msg, match) => {
    if (!rl(msg)) return;
    void cmdMentions(bot, msg.chat.id, match?.[1]?.trim() ?? "");
  });

  bot.onText(/^\/goal(?:\s+(\d+))?/, async (msg, match) => {
    if (!rl(msg)) return;
    void cmdGoal(bot, msg.chat.id, match?.[1] ? parseInt(match[1], 10) : undefined);
  });

  bot.onText(/^\/now/, async (msg) => {
    if (!rl(msg)) return;
    void cmdNow(bot, msg.chat.id);
  });

  bot.onText(/^\/lsearch\s+(.+)/, async (msg, match) => {
    if (!rl(msg)) return;
    await handleEpisodeSearch(bot, msg.chat.id, match?.[1]?.trim() ?? "");
  });

  bot.onText(/^\/compare(?:\s+(\d+))?/, async (msg, match) => {
    if (!rl(msg)) return;
    void cmdCompareStart(bot, msg.chat.id, match?.[1] ? parseInt(match[1], 10) : undefined);
  });

  bot.onText(/^\/adminsetup(?:\s+(.+))?/, async (msg, match) => {
    if (!rl(msg)) return;
    await handleAdminSetup(bot, msg.chat.id, match?.[1]?.trim() ?? "");
  });

  // ── Admin commands ───────────────────────────────────────────────────────
  bot.onText(/^\/admin/, async (msg) => {
    if (!rl(msg)) return;
    if (!await isAdmin(String(msg.chat.id))) {
      await sendMd(bot, msg.chat.id,
        `🚫 *Access Denied*\n${DIV}\n_You do not have admin privileges\\._\n\nUse /adminsetup to claim admin access\\.`
      );
      return;
    }
    await cmdAdminPanel(bot, msg.chat.id);
  });

  bot.onText(/^\/approve (.+)/, async (msg, match) => {
    if (!await isAdmin(String(msg.chat.id))) return;
    const targetId = match?.[1]?.trim() ?? "";
    await approveUser(bot, targetId, String(msg.chat.id));
    await sendMd(bot, msg.chat.id, `✅ *Approved* user ${esc(targetId)}`);
  });

  bot.onText(/^\/block (\S+)(?:\s+(.+))?/, async (msg, match) => {
    if (!await isAdmin(String(msg.chat.id))) return;
    const targetId = match?.[1]?.trim() ?? "";
    const reason   = match?.[2]?.trim() ?? "Blocked by admin";
    await blockUser(bot, targetId, String(msg.chat.id), reason);
    await sendMd(bot, msg.chat.id, `🚷 *Blocked* user ${esc(targetId)}`);
  });

  bot.onText(/^\/unblock (.+)/, async (msg, match) => {
    if (!await isAdmin(String(msg.chat.id))) return;
    const targetId = match?.[1]?.trim() ?? "";
    await unblockUser(bot, targetId, String(msg.chat.id));
    await sendMd(bot, msg.chat.id, `✅ *Unblocked* user ${esc(targetId)}`);
  });

  bot.onText(/^\/promote (.+)/, async (msg, match) => {
    if (!await isAdmin(String(msg.chat.id))) return;
    const targetId = match?.[1]?.trim() ?? "";
    await promoteUser(bot, targetId, String(msg.chat.id));
    await sendMd(bot, msg.chat.id, `⭐ *Promoted* user ${esc(targetId)} to admin`);
  });

  bot.onText(/^\/demote (.+)/, async (msg, match) => {
    if (!await isAdmin(String(msg.chat.id))) return;
    const targetId = match?.[1]?.trim() ?? "";
    await demoteUser(bot, targetId, String(msg.chat.id));
    await sendMd(bot, msg.chat.id, `⬇️ *Demoted* user ${esc(targetId)}`);
  });

  bot.onText(/^\/msg (\S+) (.+)/, async (msg, match) => {
    if (!await isAdmin(String(msg.chat.id))) return;
    const targetId = match?.[1]?.trim() ?? "";
    const text     = match?.[2]?.trim() ?? "";
    await bot.sendMessage(targetId, `📨 *Message from Admin:*\n\n${text}`, { parse_mode: "Markdown" });
    await logAdminAction(String(msg.chat.id), "message", targetId, text.slice(0, 100));
    await sendMd(bot, msg.chat.id, `✅ *Message sent* to ${esc(targetId)}`);
  });

  bot.onText(/^\/broadcast (.+)/, async (msg, match) => {
    if (!await isAdmin(String(msg.chat.id))) return;
    const text = match?.[1]?.trim() ?? "";
    const loadMsg = await bot.sendMessage(msg.chat.id, "📢 جاري الإرسال...");
    const result = await broadcastMessage(bot, text, String(msg.chat.id));
    await bot.editMessageText(
      `✅ تم الإرسال لـ ${result.sent} مستخدم\n❌ فشل: ${result.failed}`,
      { chat_id: msg.chat.id, message_id: loadMsg.message_id }
    ).catch(() => {});
  });

  bot.onText(/^\/users/, async (msg) => {
    if (!await isAdmin(String(msg.chat.id))) return;
    await cmdAdminUsers(bot, msg.chat.id);
  });

  bot.onText(/^\/logs/, async (msg) => {
    if (!await isAdmin(String(msg.chat.id))) return;
    await cmdAdminLogs(bot, msg.chat.id);
  });

  // ── Document messages (OPML import) ─────────────────────────────────────
  bot.on("document", async (msg) => {
    if (!msg.document) return;
    const doc = msg.document;
    if (!doc.file_name?.endsWith(".opml") && doc.mime_type !== "text/x-opml") return;
    void handleOpmlImport(bot, msg.chat.id, msg.document);
  });

  // ── Voice messages ──────────────────────────────────────────────────────
  bot.on("voice", async (msg) => {
    if (!msg.voice || !checkRateLimit(msg.from?.id ?? 0)) return;
    if (!hasGroqKey()) {
      await bot.sendMessage(msg.chat.id, "⚠️ AI transcription is not configured\\.", { parse_mode: MV2 });
      return;
    }
    void handleVoiceSearch(bot, msg);
  });

  // ── Text messages ───────────────────────────────────────────────────────
  bot.on("message", async (msg) => {
    if (!msg.text) return;
    if (msg.text.startsWith("/")) return;
    if (!checkRateLimit(msg.from?.id ?? 0)) return;

    const chatId = msg.chat.id;
    const text   = msg.text.trim();

    // ── CAPTCHA check (must come before auth gate) ──────────────────────
    const captchaHandled = await handleCaptchaAnswer(bot, msg);
    if (captchaHandled) return;

    // ── Auth gate ──────────────────────────────────────────────────────
    const gateResult = await authGate(String(chatId));
    if (gateResult === "block") {
      const user = await db.select({ blockReason: usersTable.blockReason })
        .from(usersTable).where(eq(usersTable.chatId, String(chatId))).limit(1);
      await bot.sendMessage(chatId, `🚷 تم حظرك. السبب: ${user[0]?.blockReason ?? "غير محدد"}`);
      return;
    }
    if (gateResult === "pending") {
      // If user doesn't exist yet, allow them to interact (captcha already handled above)
      const existing = await db.select().from(usersTable)
        .where(eq(usersTable.chatId, String(chatId))).limit(1);
      if (existing[0] && existing[0].captchaSolved) {
        await bot.sendMessage(chatId, "⏳ حسابك في انتظار الموافقة من الأدمن.");
        return;
      }
      if (existing[0] && !existing[0].captchaSolved) {
        // They need to solve the captcha first — resend challenge
        const { question } = (await import("./captcha.js")).getCaptchaChallenge();
        await bot.sendMessage(chatId, question, { parse_mode: "MarkdownV2" });
        return;
      }
      // Brand new user — register them
      await getOrCreateUser(msg);
      return;
    }

    const sess = getSession(chatId);

    // Admin panel button routing
    const adminCmd = ADMIN_PANEL_BUTTONS[text];
    if (adminCmd && !sess.action && await isAdmin(String(chatId))) {
      void routeAdminCommand(bot, chatId, adminCmd);
      return;
    }

    // Panel button press (Arabic labels)
    const panelCmd = PANEL_BUTTONS[text];
    if (panelCmd && !sess.action) {
      void routeCommand(bot, chatId, panelCmd);
      return;
    }

    // Session-driven input
    switch (sess.action) {
      case "awaiting_rss":
        clearSession(chatId);
        void handleAddRss(bot, chatId, text);
        break;
      case "awaiting_rss_confirm":
        clearSession(chatId);
        void sendMd(bot, chatId, "❌ Cancelled\\.");
        break;
      case "awaiting_search":
        clearSession(chatId);
        void handleEpisodeSearch(bot, chatId, text);
        break;
      case "awaiting_browse":
        clearSession(chatId);
        void handlePodcastSearch(bot, chatId, text);
        break;
      case "awaiting_country_code": {
        clearSession(chatId);
        const code = text.toLowerCase().replace(/[^a-z]/g, "");
        if (code.length === 2) void showTopCharts(bot, chatId, 0, code);
        else void sendMd(bot, chatId, `⚠️ Please enter a valid 2\\-letter country code \\(e\\.g\\. us, gb, sa\\)\\.`);
        break;
      }
      case "awaiting_tag_name":
        clearSession(chatId);
        void createTag(bot, chatId, text.slice(0, 50));
        break;
      case "awaiting_note": {
        const epId = sess.extra;
        clearSession(chatId);
        if (epId) void handleSaveNote(bot, chatId, epId, text);
        break;
      }
      case "awaiting_ask": {
        const epId = sess.extra;
        void handleAskReply(bot, chatId, epId ?? 0, text);
        break;
      }
      default:
        if (text.startsWith("http")) void handleAddRss(bot, chatId, text);
        else void sendMenu(bot, chatId);
    }
  });

  // ── Callback queries ────────────────────────────────────────────────────
  bot.on("callback_query", async (query) => {
    if (!query.message || !query.data) return;
    if (!checkRateLimit(query.from.id, 60)) {
      await bot.answerCallbackQuery(query.id, { text: "⚠️ Too many requests" });
      return;
    }
    const chatId = query.message.chat.id;
    const msgId  = query.message.message_id;

    try {
      await bot.answerCallbackQuery(query.id);
      await routeCallback(bot, chatId, msgId, query.data, query);
    } catch (err) {
      logger.error({ err, data: query.data }, "Callback error");
      await bot.answerCallbackQuery(query.id, { text: "⚠️ Something went wrong" }).catch(() => {});
    }
  });
}

// ─── COMMAND ROUTER ───────────────────────────────────────────────────────────

async function routeCommand(bot: TelegramBot, chatId: number, cmd: string): Promise<void> {
  switch (cmd) {
    case "feeds":      await cmdFeeds(bot, chatId);      break;
    case "latest":     await cmdLatest(bot, chatId);     break;
    case "queue":      await cmdQueue(bot, chatId);      break;
    case "favourites": await cmdFavourites(bot, chatId); break;
    case "tags":       await cmdTags(bot, chatId);       break;
    case "stats":      await cmdStats(bot, chatId);      break;
    case "refresh":    await cmdRefreshAll(bot, chatId); break;
    case "resume":     await cmdResume(bot, chatId);     break;
    case "settings":   await cmdSettings(bot, chatId);   break;
    case "trending":   await showCountryPicker(bot, chatId, 0); break;
    case "discover":   await cmdDiscover(bot, chatId);   break;
    case "add":
      getSession(chatId).action = "awaiting_rss";
      await sendMd(bot, chatId, addPromptMsg(), { reply_markup: { inline_keyboard: [homeRow()] } });
      break;
    case "search":
      getSession(chatId).action = "awaiting_search";
      await sendMd(bot, chatId, `🔍 *Search Episodes*\n${DIV}\nSend a keyword:`, {
        reply_markup: { inline_keyboard: [homeRow()] },
      });
      break;
    case "browse":
      getSession(chatId).action = "awaiting_browse";
      await sendMd(bot, chatId, `🌐 *Browse iTunes*\n${DIV}\nEnter a show name or topic:`, {
        reply_markup: { inline_keyboard: [homeRow()] },
      });
      break;
  }
}

// ─── CALLBACK ROUTER ─────────────────────────────────────────────────────────

async function routeCallback(
  bot: TelegramBot, chatId: number, msgId: number, data: string,
  query: TelegramBot.CallbackQuery
): Promise<void> {
  if (data === "noop") return;

  if (data === "menu") { await editMenu(bot, chatId, msgId); return; }
  if (data === "home") { await editMenu(bot, chatId, msgId); return; }

  // cmd: shortcuts
  if (data.startsWith("cmd:")) {
    const cmd = data.slice(4);
    if (cmd === "trending") { await editMd(bot, chatId, msgId, "⏳"); await showCountryPicker(bot, chatId, 0, msgId); return; }
    if (cmd === "add") {
      getSession(chatId).action = "awaiting_rss";
      await editMd(bot, chatId, msgId, addPromptMsg(), { inline_keyboard: [homeRow()] });
      return;
    }
    if (cmd === "search") {
      getSession(chatId).action = "awaiting_search";
      await editMd(bot, chatId, msgId, `🔍 *بحث في الحلقات*\n${DIV}\nأرسل كلمة مفتاحية:`, { inline_keyboard: [homeRow()] });
      return;
    }
    if (cmd === "browse") {
      getSession(chatId).action = "awaiting_browse";
      await editMd(bot, chatId, msgId, `🌐 *تصفح iTunes*\n${DIV}\nأدخل اسم بودكاست أو موضوع:`, { inline_keyboard: [homeRow()] });
      return;
    }
    await cmdDispatch(bot, chatId, msgId, cmd); return;
  }

  // ── Play shortcut (same as episode detail) ────────────────────────────
  if (data.startsWith("play:"))            { await showEpisodeDetail(bot, chatId, msgId, +data.slice(5)); return; }

  // ── Feed navigation ────────────────────────────────────────────────────
  if (data.startsWith("feed:")) {
    const parts = data.split(":");
    if (parts[1] === "rate")      { await editMd(bot, chatId, msgId, `⭐ *Rate this Podcast*\n${DIV}\nChoose your rating:`, { inline_keyboard: ratingKeyboard(+parts[2]) }); return; }
    if (parts[1] === "setRating") { await handleSetRating(bot, chatId, msgId, +parts[2], +parts[3]); return; }
    if (parts[1] === "eps")       { await showFeedEpisodes(bot, chatId, msgId, +parts[2], 0); return; }
    if (parts[1] === "notif")     { await showFeedNotifMenu(bot, chatId, msgId, +parts[2]); return; }
    if (parts[1] === "setNotif")  { await handleSetFeedNotif(bot, chatId, msgId, +parts[2], parts[3] ?? "all"); return; }
    await showFeedEpisodes(bot, chatId, msgId, +data.slice(5), 0); return;
  }
  if (data.startsWith("eplist:"))          { const [,f,p] = data.split(":").map(Number); await showFeedEpisodes(bot, chatId, msgId, f, p); return; }

  // ── Episode sub-menus ──────────────────────────────────────────────────
  if (data.startsWith("ep:ai:"))           { await showEpAiMenu(bot, chatId, msgId, +data.slice(6)); return; }
  if (data.startsWith("ep:manage:"))       { await showEpManageMenu(bot, chatId, msgId, +data.slice(10)); return; }
  if (data.startsWith("ep:sleep_menu:"))   { await showEpSleepMenu(bot, chatId, msgId, +data.slice(14)); return; }
  if (data.startsWith("ep:remind_menu:"))  { await showEpRemindMenu(bot, chatId, msgId, +data.slice(15)); return; }
  if (data.startsWith("ep:bookmark:"))     { await handleEpBookmark(bot, chatId, msgId, +data.slice(12)); return; }
  if (data.startsWith("ep:translate:"))    { void handleEpTranslate(bot, chatId, +data.slice(13)); return; }
  if (data.startsWith("ep:quote:"))        { void handleEpQuote(bot, chatId, +data.slice(9)); return; }
  if (data.startsWith("ep:analytics:"))    { await handleEpAnalytics(bot, chatId, msgId, +data.slice(13)); return; }
  if (data.startsWith("ep:skip:"))         { await handleEpSkip(bot, chatId, msgId, +data.slice(8)); return; }
  if (data.startsWith("ep:remind:")) {
    const parts = data.split(":");
    const epId = +parts[2], mins = parseInt(parts[3] ?? "30", 10);
    await handleEpRemind(bot, chatId, query.id, epId, mins);
    return;
  }

  // ── Episode actions ────────────────────────────────────────────────────
  if (data.startsWith("ep:ask:"))          { await initAskMode(bot, chatId, msgId, +data.slice(7)); return; }
  if (data.startsWith("ep:summarize:"))    { void handleEpSummarize(bot, chatId, +data.slice(14)); return; }
  if (data.startsWith("ep:transcribe:"))   { void handleEpTranscribe(bot, chatId, +data.slice(15)); return; }
  if (data.startsWith("ep:share:"))        { await handleEpShare(bot, chatId, msgId, +data.slice(9)); return; }
  if (data.startsWith("ep:addNote:"))      { await initNoteMode(bot, chatId, msgId, +data.slice(11)); return; }
  if (data.startsWith("ep:sleep:")) {
    const parts = data.split(":");
    const mins = parts[3] ?? "30";
    await bot.answerCallbackQuery(query.id, { text: `🌙 Sleep timer: ${mins} min activated` });
    await sendMd(bot, chatId, `🌙 *Sleep Timer*\n${DIV}\nYou will be notified in *${esc(mins)}* minutes\\.`);
    const minsNum = parseInt(mins, 10);
    if (!isNaN(minsNum) && minsNum > 0) {
      setTimeout(async () => {
        await sendMd(bot, chatId, `🛌 *Sleep timer\\!*\n${DIV}\nTime to rest\\. Good night\\! 😴`).catch(() => {});
      }, minsNum * 60 * 1000);
    }
    return;
  }
  if (data.startsWith("ep:speed:")) {
    const parts = data.split(":");
    const speed = parts[3] ?? "1";
    await upsertUserPrefs(String(chatId), { playbackSpeed: speed });
    await bot.answerCallbackQuery(query.id, { text: `▶️ Speed: ${speed}×` });
    return;
  }

  // ── Compare episodes ───────────────────────────────────────────────────
  if (data.startsWith("compare:")) {
    const parts = data.split(":");
    void handleEpCompare(bot, chatId, +parts[1], +parts[2]);
    return;
  }

  // ── Export ────────────────────────────────────────────────────────────
  if (data === "export:opml")    { void handleExportOpml(bot, chatId); return; }
  if (data === "export:json")    { void handleExportJson(bot, chatId); return; }

  // ── Settings: speed ───────────────────────────────────────────────────
  if (data.startsWith("settings:speed:")) {
    const speed = data.slice(15);
    await upsertUserPrefs(String(chatId), { playbackSpeed: speed });
    await bot.answerCallbackQuery(query.id, { text: `Speed set to ${speed}×` });
    await cmdSettings(bot, chatId, msgId);
    return;
  }

  // ── AI actions ─────────────────────────────────────────────────────────
  if (data.startsWith("ep:deep:"))        { void handleEpDeepExplanation(bot, chatId, +data.slice(8)); return; }
  if (data.startsWith("ep:questions:"))   { void handleEpQuestions(bot, chatId, +data.slice(13)); return; }
  if (data.startsWith("questions_new:"))  { void handleEpQuestionsNew(bot, chatId, +data.slice(14)); return; }
  if (data.startsWith("ai_summary:"))     { void handleAiSummary(bot, chatId, +data.slice(11)); return; }
  if (data.startsWith("ai_detail:"))      { void handleAiDetail(bot, chatId, +data.slice(10)); return; }
  if (data.startsWith("transcript:"))     { void handleTranscriptPdf(bot, chatId, +data.slice(11)); return; }
  if (data.startsWith("download:"))       { void handleDownload(bot, chatId, +data.slice(9)); return; }

  // ── Episode fallback (must be LAST in ep: chain) ───────────────────────
  if (data.startsWith("ep:"))             { await showEpisodeDetail(bot, chatId, msgId, +data.slice(3)); return; }

  // ── Queue & favourites ─────────────────────────────────────────────────
  if (data.startsWith("fav:"))            { await toggleFavourite(bot, chatId, msgId, +data.slice(4)); return; }
  if (data.startsWith("queue_add:"))      { await addToQueue(bot, chatId, msgId, +data.slice(10)); return; }
  if (data.startsWith("queue_rm:"))       { await removeFromQueue(chatId, +data.slice(9)); await cmdQueue(bot, chatId, msgId); return; }
  if (data.startsWith("queue:up:"))       { await moveQueue(chatId, +data.slice(9), "up"); await cmdQueue(bot, chatId, msgId); return; }
  if (data.startsWith("queue:down:"))     { await moveQueue(chatId, +data.slice(11), "down"); await cmdQueue(bot, chatId, msgId); return; }
  if (data.startsWith("queue:remove:"))   { await removeFromQueue(chatId, +data.slice(13)); await cmdQueue(bot, chatId, msgId); return; }
  if (data.startsWith("listened:"))       { await markListened(bot, chatId, msgId, +data.slice(9)); return; }
  if (data.startsWith("del_feed_confirm:")){ await showDeleteFeedConfirm(bot, chatId, msgId, +data.slice(18)); return; }
  if (data.startsWith("del_feed:"))       { await deleteFeed(bot, chatId, msgId, +data.slice(9)); return; }
  if (data.startsWith("refresh_feed:"))   { await refreshSingleFeed(bot, chatId, msgId, +data.slice(12)); return; }

  // ── Admin callbacks ────────────────────────────────────────────────────
  if (data.startsWith("admin_approve:"))  { await handleAdminApprove(bot, chatId, query, data.slice(14)); return; }
  if (data.startsWith("admin_reject:"))   { await handleAdminReject(bot, chatId, query, data.slice(13)); return; }
  if (data.startsWith("admin_block:"))    { await handleAdminBlock(bot, chatId, query, data.slice(12)); return; }

  // Tags
  if (data.startsWith("tag_list:"))        { await showTagEpisodes(bot, chatId, msgId, +data.slice(9), 0); return; }
  if (data.startsWith("tag_page:"))        { const [,t,p] = data.split(":").map(Number); await showTagEpisodes(bot, chatId, msgId, t, p); return; }
  if (data.startsWith("tag_del:"))         { await deleteTag(bot, chatId, msgId, +data.slice(8)); return; }
  if (data.startsWith("tag_pick:"))        { await showTagPicker(bot, chatId, msgId, +data.slice(9)); return; }
  if (data.startsWith("tag_toggle:"))      { const [,e,t] = data.split(":").map(Number); await toggleEpisodeTag(bot, chatId, msgId, e, t); return; }
  if (data === "tag_new")                  { getSession(chatId).action = "awaiting_tag_name"; await editMd(bot, chatId, msgId, `🏷 *Create Tag*\n${DIV}\nType a name for the new tag:`, { inline_keyboard: [homeRow()] }); return; }

  // Discovery
  if (data.startsWith("country_page:"))    { const [,p] = data.split(":"); await showCountryPicker(bot, chatId, +p, msgId); return; }
  if (data === "country_type")             { getSession(chatId).action = "awaiting_country_code"; await editMd(bot, chatId, msgId, `🔤 *Enter Country Code*\n${DIV}\nType a 2\\-letter code: us · gb · sa · de · jp`, { inline_keyboard: [homeRow()] }); return; }
  if (data.startsWith("trend_c:"))         { const [,c,p] = data.split(":"); await showTopCharts(bot, chatId, +(p ?? 0), c, msgId); return; }
  if (data.startsWith("charts_page:"))     { const [,c,p] = data.split(":"); await showTopCharts(bot, chatId, +p, c, msgId); return; }
  if (data.startsWith("disc_sub:"))        { await subscribeFromDiscovery(bot, chatId, msgId, data.slice(9)); return; }
  if (data.startsWith("disc:cat:"))        { await handleDiscoverCategory(bot, chatId, msgId, data.slice(9)); return; }
  if (data.startsWith("discover:search:")) { await handlePodcastSearchEdit(bot, chatId, msgId, decodeURIComponent(data.slice(16))); return; }

  // Add RSS confirmation
  if (data === "add_confirm")              { await confirmAddFeed(bot, chatId, msgId); return; }
  if (data === "add_cancel")               { clearSession(chatId); await editMd(bot, chatId, msgId, `❌ Cancelled\\.`); return; }

  // Settings
  if (data.startsWith("settings:toggle:autoDownload")) { await toggleAutoDownload(bot, chatId, msgId); return; }
  if (data.startsWith("settings:notif:"))  { const val = data.slice(15); await upsertUserPrefs(String(chatId), { notifications: val }); await showSettingsEdit(bot, chatId, msgId); return; }
  if (data.startsWith("settings:lang:"))   { const val = data.slice(14); await upsertUserPrefs(String(chatId), { language: val }); await showSettingsEdit(bot, chatId, msgId); return; }

  // Latest pagination
  if (data.startsWith("latest:"))          { await cmdLatest(bot, chatId, msgId, +data.slice(7)); return; }
}

async function cmdDispatch(bot: TelegramBot, chatId: number, msgId: number, cmd: string): Promise<void> {
  switch (cmd) {
    case "feeds":      await cmdFeeds(bot, chatId, msgId);      break;
    case "latest":     await cmdLatest(bot, chatId, msgId);     break;
    case "queue":      await cmdQueue(bot, chatId, msgId);      break;
    case "favourites": await cmdFavourites(bot, chatId, msgId); break;
    case "tags":       await cmdTags(bot, chatId, msgId);       break;
    case "stats":      await cmdStats(bot, chatId, msgId);      break;
    case "refresh":    await cmdRefreshAll(bot, chatId, msgId); break;
    case "resume":     await cmdResume(bot, chatId, msgId);     break;
    case "settings":   await cmdSettings(bot, chatId, msgId);   break;
    case "discover":   await cmdDiscover(bot, chatId, msgId);   break;
  }
}

// ─── MENU ─────────────────────────────────────────────────────────────────────

async function sendMenu(bot: TelegramBot, chatId: number): Promise<void> {
  const text = `🎙 *iCast*\n${DIV}\nUse the keyboard below to navigate\\.`;
  await sendMd(bot, chatId, text, { reply_markup: { keyboard: MAIN_KEYBOARD, resize_keyboard: true, is_persistent: true } });
}

async function editMenu(bot: TelegramBot, chatId: number, msgId: number): Promise<void> {
  const text = `🎙 *iCast*\n${DIV}\nUse the keyboard below to navigate\\.`;
  await editMd(bot, chatId, msgId, text);
  await sendMd(bot, chatId, "⌨️ _Keyboard restored\\._", { reply_markup: { keyboard: MAIN_KEYBOARD, resize_keyboard: true, is_persistent: true } });
}

// ─── START / RESUME ───────────────────────────────────────────────────────────

async function getResumeEpisode(chatId: string) {
  try {
    const feeds = await db.select({ id: feedsTable.id }).from(feedsTable).where(eq(feedsTable.chatId, chatId));
    if (!feeds.length) return null;
    const arr = sqlArr(feeds.map((f) => f.id));
    const ep = await db.select().from(episodesTable)
      .where(and(sql`${episodesTable.feedId} = ANY(${arr})`, gt(episodesTable.progress, 0), eq(episodesTable.listened, false)))
      .orderBy(desc(episodesTable.updatedAt)).limit(1);
    return ep[0] ?? null;
  } catch { return null; }
}

async function cmdResume(bot: TelegramBot, chatId: number, msgId?: number): Promise<void> {
  const ep = await getResumeEpisode(String(chatId));
  if (!ep) {
    const text = `▶️ *Resume Listening*\n${DIV}\nNo episodes in progress\\.`;
    const kb = { inline_keyboard: [[{ text: "🆕 Latest", callback_data: "cmd:latest" }], homeRow()] };
    msgId ? await editMd(bot, chatId, msgId, text, kb) : await sendMd(bot, chatId, text, { reply_markup: kb });
    return;
  }
  getSession(chatId).currentEpisodeId = ep.id;
  await showEpisodeDetail(bot, chatId, msgId ?? 0, ep.id, !msgId);
}

// ─── FEEDS ────────────────────────────────────────────────────────────────────

async function cmdFeeds(bot: TelegramBot, chatId: number, msgId?: number): Promise<void> {
  const feeds = await db.select().from(feedsTable).where(eq(feedsTable.chatId, String(chatId))).orderBy(feedsTable.title);

  if (!feeds.length) {
    const text = feedListMsg([]);
    const kb   = { inline_keyboard: [[{ text: "➕ Add Podcast", callback_data: "cmd:add" }], homeRow()] };
    msgId ? await editMd(bot, chatId, msgId, text, kb) : await sendMd(bot, chatId, text, { reply_markup: kb });
    return;
  }

  // Count unread for each feed
  const feedsWithMeta = await Promise.all(feeds.map(async (f) => {
    const [{ c }] = await db.select({ c: count() }).from(episodesTable)
      .where(and(eq(episodesTable.feedId, f.id), eq(episodesTable.listened, false)));
    const rating = await db.select({ rating: ratingsTable.rating }).from(ratingsTable)
      .where(and(eq(ratingsTable.feedId, f.id), eq(ratingsTable.chatId, String(chatId)))).limit(1);
    return { ...f, unreadCount: Number(c), rating: rating[0]?.rating };
  }));

  const text     = feedListMsg(feedsWithMeta);
  const keyboard: TelegramBot.InlineKeyboardButton[][] = feeds.map((f, i) => [{
    text: `${i + 1}. ${f.title.slice(0, 30)}`,
    callback_data: `feed:${f.id}`,
  }]);
  keyboard.push(homeRow());

  msgId ? await editMd(bot, chatId, msgId, text, { inline_keyboard: keyboard })
        : await sendMd(bot, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}

// ─── SHOW FEED EPISODES ───────────────────────────────────────────────────────

async function showFeedEpisodes(
  bot: TelegramBot, chatId: number, msgId: number, feedId: number, page: number
): Promise<void> {
  const feed = await db.select().from(feedsTable).where(eq(feedsTable.id, feedId)).limit(1);
  if (!feed[0]) return;

  const [{ c: total }] = await db.select({ c: count() }).from(episodesTable).where(eq(episodesTable.feedId, feedId));
  const totalPages = Math.max(1, Math.ceil(Number(total) / PAGE_SIZE));
  const episodes   = await db.select().from(episodesTable)
    .where(eq(episodesTable.feedId, feedId))
    .orderBy(desc(episodesTable.pubDate))
    .limit(PAGE_SIZE).offset(page * PAGE_SIZE);

  const text = episodeListMsg(
    episodes.map((e) => normEp(e, feed[0].title)),
    feed[0].title, page + 1, totalPages
  );

  const keyboard: TelegramBot.InlineKeyboardButton[][] = episodes.map((ep, i) => [{
    text: `${page * PAGE_SIZE + i + 1}. ${ep.listened ? "✅" : "🔵"} ${trunc(ep.title, 28)}`,
    callback_data: `ep:${ep.id}`,
  }]);

  const navRow = paginationRow(`eplist:${feedId}`, page, totalPages);
  if (navRow.length > 0) keyboard.push(navRow);
  keyboard.push([
    { text: "🔄 Refresh", callback_data: `refresh_feed:${feedId}` },
    { text: "⭐ Rate",    callback_data: `feed:rate:${feedId}` },
    { text: "🗑 Remove",  callback_data: `del_feed_confirm:${feedId}` },
  ]);
  keyboard.push(homeRow());

  await editMd(bot, chatId, msgId, text, { inline_keyboard: keyboard });
}

// ─── EPISODE DETAIL ───────────────────────────────────────────────────────────

async function showEpisodeDetail(
  bot: TelegramBot, chatId: number, msgId: number, epId: number, sendNew = false
): Promise<void> {
  const ep = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;

  const feed = await db.select().from(feedsTable).where(eq(feedsTable.id, ep[0].feedId)).limit(1);

  const isFav = await db.select().from(favoritesTable)
    .where(and(eq(favoritesTable.chatId, String(chatId)), eq(favoritesTable.episodeId, epId))).limit(1);
  const isQueued = await db.select().from(queueTable)
    .where(and(eq(queueTable.chatId, String(chatId)), eq(queueTable.episodeId, epId))).limit(1);

  getSession(chatId).currentEpisodeId = epId;

  const text = episodeCard(normEp(ep[0], feed[0]?.title));
  const kb = episodeActions(epId, {
    isFav: isFav.length > 0,
    isQueued: isQueued.length > 0,
    hasTranscript: Boolean(ep[0].transcript),
    progress: Math.round((ep[0].progress ?? 0) * 100),
    isPlayed: ep[0].listened ?? false,
  });

  if (sendNew) {
    await sendMd(bot, chatId, text, { reply_markup: { inline_keyboard: kb } });
  } else {
    await editMd(bot, chatId, msgId, text, { inline_keyboard: kb });
  }
}

// ─── LATEST EPISODES ──────────────────────────────────────────────────────────

async function cmdLatest(bot: TelegramBot, chatId: number, msgId?: number, page = 0): Promise<void> {
  const feeds = await db.select({ id: feedsTable.id }).from(feedsTable).where(eq(feedsTable.chatId, String(chatId)));

  if (!feeds.length) {
    const text = `🎧 *Latest Episodes*\n${DIV}\nNo subscriptions yet\\.\nAdd one with /add`;
    const kb   = { inline_keyboard: [[{ text: "➕ Add Podcast", callback_data: "cmd:add" }], homeRow()] };
    msgId ? await editMd(bot, chatId, msgId, text, kb) : await sendMd(bot, chatId, text, { reply_markup: kb });
    return;
  }

  const arr = sqlArr(feeds.map((f) => f.id));
  const [{ c: total }] = await db.select({ c: count() }).from(episodesTable)
    .where(sql`${episodesTable.feedId} = ANY(${arr})`);
  const totalPages = Math.max(1, Math.ceil(Number(total) / PAGE_SIZE));
  const episodes = await db.select({
    id: episodesTable.id, title: episodesTable.title, feedId: episodesTable.feedId,
    pubDate: episodesTable.pubDate, duration: episodesTable.duration,
    listened: episodesTable.listened, progress: episodesTable.progress,
    episodeNumber: episodesTable.episodeNumber,
  }).from(episodesTable)
    .where(sql`${episodesTable.feedId} = ANY(${arr})`)
    .orderBy(desc(episodesTable.pubDate))
    .limit(PAGE_SIZE).offset(page * PAGE_SIZE);

  const text = episodeListMsg(episodes.map((e) => normEp(e)), undefined, page + 1, totalPages);

  const keyboard: TelegramBot.InlineKeyboardButton[][] = episodes.map((ep, i) => [{
    text: `${page * PAGE_SIZE + i + 1}. ${ep.listened ? "✅" : "🔵"} ${trunc(ep.title, 28)}`,
    callback_data: `ep:${ep.id}`,
  }]);

  const navRow = paginationRow("latest", page, totalPages);
  if (navRow.length > 0) keyboard.push(navRow);
  keyboard.push(homeRow());

  msgId ? await editMd(bot, chatId, msgId, text, { inline_keyboard: keyboard })
        : await sendMd(bot, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}

// ─── QUEUE ────────────────────────────────────────────────────────────────────

async function cmdQueue(bot: TelegramBot, chatId: number, msgId?: number): Promise<void> {
  const items = await db.select({
    episodeId: queueTable.episodeId, position: queueTable.position,
    title: episodesTable.title, duration: episodesTable.duration, id: queueTable.id,
  }).from(queueTable)
    .innerJoin(episodesTable, eq(queueTable.episodeId, episodesTable.id))
    .where(eq(queueTable.chatId, String(chatId)))
    .orderBy(queueTable.position);

  const text = queueMsg(items.map((i) => ({ title: i.title, duration: i.duration })));
  const total = items.length;

  const keyboard: TelegramBot.InlineKeyboardButton[][] = items.map((item, idx) =>
    queueItemActions(item.episodeId, idx + 1, total).flat()
  );
  keyboard.push(homeRow());

  msgId ? await editMd(bot, chatId, msgId, text, { inline_keyboard: keyboard })
        : await sendMd(bot, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}

// ─── FAVOURITES ───────────────────────────────────────────────────────────────

async function cmdFavourites(bot: TelegramBot, chatId: number, msgId?: number): Promise<void> {
  const favs = await db.select({
    episodeId: episodesTable.id, title: episodesTable.title,
    listened: episodesTable.listened, pubDate: episodesTable.pubDate,
  }).from(favoritesTable)
    .innerJoin(episodesTable, eq(favoritesTable.episodeId, episodesTable.id))
    .where(eq(favoritesTable.chatId, String(chatId)))
    .orderBy(desc(favoritesTable.createdAt)).limit(20);

  const text = favs.length
    ? [
        `❤️ *Favourites \\(${favs.length}\\)*`, DIV,
        ...favs.map((f, i) => `${i + 1}\\. ${f.listened ? "✅" : "🔵"} ${esc(trunc(f.title, 28))}`),
      ].join("\n")
    : [`❤️ *No Favourites Yet*`, DIV, `Tap 🤍 on any episode to save it here\\.`].join("\n");

  const keyboard: TelegramBot.InlineKeyboardButton[][] = favs.map((f, i) => [{
    text: `${i + 1}. ${f.listened ? "✅" : "🔵"} ${trunc(f.title, 28)}`,
    callback_data: `ep:${f.episodeId}`,
  }]);
  keyboard.push(homeRow());

  msgId ? await editMd(bot, chatId, msgId, text, { inline_keyboard: keyboard })
        : await sendMd(bot, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}

// ─── STATS ────────────────────────────────────────────────────────────────────

async function cmdStats(bot: TelegramBot, chatId: number, msgId?: number): Promise<void> {
  const feeds = await db.select({ id: feedsTable.id }).from(feedsTable).where(eq(feedsTable.chatId, String(chatId)));

  if (!feeds.length) {
    const text = `📊 *My Statistics*\n${DIV}\nNo subscriptions yet\\.\nSubscribe to a podcast to start\\.`;
    const kb   = { inline_keyboard: [homeRow()] };
    msgId ? await editMd(bot, chatId, msgId, text, kb) : await sendMd(bot, chatId, text, { reply_markup: kb });
    return;
  }

  const arr = sqlArr(feeds.map((f) => f.id));
  const [
    [{ c: total }], [{ c: played }], [{ c: favCount }],
    [{ c: queueCount }], [{ c: transcribed }], [{ c: tagCount }],
  ] = await Promise.all([
    db.select({ c: count() }).from(episodesTable).where(sql`${episodesTable.feedId} = ANY(${arr})`),
    db.select({ c: count() }).from(episodesTable).where(and(sql`${episodesTable.feedId} = ANY(${arr})`, eq(episodesTable.listened, true))),
    db.select({ c: count() }).from(favoritesTable).where(eq(favoritesTable.chatId, String(chatId))),
    db.select({ c: count() }).from(queueTable).where(eq(queueTable.chatId, String(chatId))),
    db.select({ c: count() }).from(episodesTable).where(and(sql`${episodesTable.feedId} = ANY(${arr})`, isNotNull(episodesTable.transcript))),
    db.select({ c: count() }).from(tagsTable).where(eq(tagsTable.chatId, String(chatId))),
  ]);

  // Estimate total minutes from duration fields
  const durationRows = await db.select({ duration: episodesTable.duration }).from(episodesTable)
    .where(and(sql`${episodesTable.feedId} = ANY(${arr})`, eq(episodesTable.listened, true)));

  let totalMinutes = 0;
  for (const r of durationRows) {
    if (r.duration) {
      const parts = r.duration.split(":").map(Number);
      let secs = 0;
      if (parts.length === 3) secs = parts[0] * 3600 + parts[1] * 60 + parts[2];
      else if (parts.length === 2) secs = parts[0] * 60 + parts[1];
      else secs = Number(r.duration) || 0;
      totalMinutes += Math.floor(secs / 60);
    }
  }

  const text = statsMsg({
    feedCount:       feeds.length,
    playedCount:     Number(played),
    totalMinutes,
    favouriteCount:  Number(favCount),
    queueCount:      Number(queueCount),
    tagCount:        Number(tagCount),
    transcribedCount: Number(transcribed),
  });
  const kb = { inline_keyboard: [homeRow()] };
  msgId ? await editMd(bot, chatId, msgId, text, kb) : await sendMd(bot, chatId, text, { reply_markup: kb });
}

// ─── REFRESH ──────────────────────────────────────────────────────────────────

async function refreshSingleFeed(
  bot: TelegramBot, chatId: number, msgId: number, feedId: number
): Promise<void> {
  const feed = await db.select().from(feedsTable).where(eq(feedsTable.id, feedId)).limit(1);
  if (!feed[0]) return;
  await editMd(bot, chatId, msgId, `🔄 *Refreshing\\.\\.\\.*\n${DIV}\n📻 ${esc(trunc(feed[0].title, 28))}`);
  try {
    const feedData = await fetchFeed(feed[0].url, true);
    let newCount = 0;
    for (const ep of feedData.episodes) {
      const exists = await db.select({ id: episodesTable.id }).from(episodesTable)
        .where(and(eq(episodesTable.feedId, feedId), eq(episodesTable.guid, ep.guid))).limit(1);
      if (!exists.length) {
        await db.insert(episodesTable).values({
          feedId, guid: ep.guid, title: ep.title, description: ep.description,
          audioUrl: ep.audioUrl, imageUrl: ep.imageUrl,
          pubDate: ep.pubDate, duration: ep.duration,
          episodeNumber: ep.episodeNumber,
          chapters: ep.chapters ? JSON.stringify(ep.chapters) : null,
        });
        newCount++;
      }
    }
    await db.update(feedsTable).set({ lastChecked: new Date() }).where(eq(feedsTable.id, feedId));
    const msg = newCount === 0
      ? doneMsg("No new episodes")
      : doneMsg(`${newCount} new episode${newCount !== 1 ? "s" : ""} ✨`);
    await editMd(bot, chatId, msgId, `📻 ${esc(trunc(feed[0].title, 28))}\n${DIV}\n${msg}`, {
      inline_keyboard: [[{ text: "▶️ Browse Feed", callback_data: `feed:${feedId}` }], homeRow()],
    });
  } catch (err: any) {
    await editMd(bot, chatId, msgId,
      softError("Could not refresh feed", "Check the RSS URL or try again later"),
      { inline_keyboard: [homeRow()] });
  }
}

async function cmdRefreshAll(bot: TelegramBot, chatId: number, msgId?: number): Promise<void> {
  const feeds = await db.select().from(feedsTable).where(eq(feedsTable.chatId, String(chatId)));
  if (!feeds.length) {
    const text = `📭 *No Subscriptions to Refresh*`;
    const kb   = { inline_keyboard: [homeRow()] };
    msgId ? await editMd(bot, chatId, msgId, text, kb) : await sendMd(bot, chatId, text, { reply_markup: kb });
    return;
  }

  const loadText = loadingMsg(0, `Refreshing ${feeds.length} feed${feeds.length !== 1 ? "s" : ""}`);
  let curId: number;
  if (msgId) { await editMd(bot, chatId, msgId, loadText); curId = msgId; }
  else       { const m = await sendMd(bot, chatId, loadText); curId = m.message_id; }

  let totalNew = 0;
  for (let i = 0; i < feeds.length; i++) {
    const feed = feeds[i];
    await editMd(bot, chatId, curId, loadingMsg(Math.min(4, Math.ceil((i / feeds.length) * 4)), `Checking ${trunc(feed.title, 20)}`));
    try {
      const feedData = await fetchFeed(feed.url, true);
      for (const ep of feedData.episodes) {
        const exists = await db.select({ id: episodesTable.id }).from(episodesTable)
          .where(and(eq(episodesTable.feedId, feed.id), eq(episodesTable.guid, ep.guid))).limit(1);
        if (!exists.length) {
          await db.insert(episodesTable).values({
            feedId: feed.id, guid: ep.guid, title: ep.title,
            description: ep.description, audioUrl: ep.audioUrl,
            imageUrl: ep.imageUrl, pubDate: ep.pubDate, duration: ep.duration,
            episodeNumber: ep.episodeNumber,
            chapters: ep.chapters ? JSON.stringify(ep.chapters) : null,
          });
          totalNew++;
        }
      }
      await db.update(feedsTable).set({ lastChecked: new Date() }).where(eq(feedsTable.id, feed.id));
      await new Promise((r) => setTimeout(r, 500)); // stagger requests
    } catch { /* skip failed feeds */ }
  }

  const result = totalNew === 0
    ? doneMsg("No new episodes")
    : doneMsg(`${totalNew} new episode${totalNew !== 1 ? "s" : ""} ✨`);

  await editMd(bot, chatId, curId, result, {
    inline_keyboard: [[{ text: "🆕 View Latest", callback_data: "cmd:latest" }], homeRow()],
  });
}

// ─── ADD RSS ──────────────────────────────────────────────────────────────────

async function handleAddRss(bot: TelegramBot, chatId: number, url: string): Promise<void> {
  if (!isValidFeedUrl(url)) {
    await sendMd(bot, chatId, softError("Invalid URL", "Please send a valid http/https RSS feed URL\\."));
    return;
  }

  const existing = await db.select().from(feedsTable)
    .where(and(eq(feedsTable.chatId, String(chatId)), eq(feedsTable.url, url))).limit(1);
  if (existing.length) {
    await sendMd(bot, chatId, [`⚠️ *Already Subscribed*`, DIV, `📻 ${esc(trunc(existing[0].title, 28))}`].join("\n"), {
      reply_markup: { inline_keyboard: [[{ text: "▶️ Browse Feed", callback_data: `feed:${existing[0].id}` }], homeRow()] },
    });
    return;
  }

  const loadMsg = await sendMd(bot, chatId, `⟳ Fetching feed…`);

  try {
    const feedData = await fetchFeed(url, true);
    getSession(chatId).pendingFeed = {
      url,
      title: feedData.title,
      description: feedData.description,
      episodeCount: feedData.episodes.length,
      imageUrl: feedData.imageUrl,
    };
    getSession(chatId).action = "awaiting_rss_confirm";

    const preview = addPreviewMsg({
      title: feedData.title,
      description: feedData.description,
      episodeCount: feedData.episodes.length,
    });

    await bot.editMessageText(preview, {
      chat_id: chatId, message_id: loadMsg.message_id,
      parse_mode: MV2,
      reply_markup: { inline_keyboard: [
        [{ text: "✅ Add Podcast", callback_data: "add_confirm" }],
        [{ text: "❌ Cancel", callback_data: "add_cancel" }],
      ]},
    });
  } catch (err: any) {
    await bot.editMessageText(softError("Could not load feed", "Check the URL and try again\\."), {
      chat_id: chatId, message_id: loadMsg.message_id,
      parse_mode: MV2,
      reply_markup: { inline_keyboard: [homeRow()] },
    }).catch(() => {});
  }
}

async function confirmAddFeed(bot: TelegramBot, chatId: number, msgId: number): Promise<void> {
  const sess = getSession(chatId);
  const pending = sess.pendingFeed;
  if (!pending) {
    await editMd(bot, chatId, msgId, `⚠️ Session expired\\. Please try /add again\\.`);
    return;
  }
  clearSession(chatId);

  await editMd(bot, chatId, msgId, `⟳ Adding podcast…`);

  try {
    const feedData = await fetchFeed(pending.url, true);
    const [feed] = await db.insert(feedsTable).values({
      chatId: String(chatId), url: pending.url, title: feedData.title,
      author: feedData.author, imageUrl: feedData.imageUrl, lastChecked: new Date(),
    }).returning();

    if (feedData.episodes.length) {
      const CHUNK = 100;
      for (let i = 0; i < feedData.episodes.length; i += CHUNK) {
        await db.insert(episodesTable).values(
          feedData.episodes.slice(i, i + CHUNK).map((ep) => ({
            feedId: feed.id, guid: ep.guid, title: ep.title,
            description: ep.description, audioUrl: ep.audioUrl,
            imageUrl: ep.imageUrl, pubDate: ep.pubDate, duration: ep.duration,
            episodeNumber: ep.episodeNumber,
            chapters: ep.chapters ? JSON.stringify(ep.chapters) : null,
          }))
        ).onConflictDoNothing();
      }
      await db.update(feedsTable).set({ lastEpisodeGuid: feedData.episodes[0]?.guid ?? null })
        .where(eq(feedsTable.id, feed.id));
    }

    const successMsg = addSuccessMsg({ title: feedData.title, episodeCount: feedData.episodes.length });

    if (feedData.imageUrl) {
      await bot.editMessageText(successMsg, {
        chat_id: chatId, message_id: msgId, parse_mode: MV2,
        reply_markup: { inline_keyboard: feedActions(feed.id) },
      }).catch(async () => {
        await bot.sendPhoto(chatId, feedData.imageUrl!, {
          caption: successMsg,
          parse_mode: MV2,
          reply_markup: { inline_keyboard: feedActions(feed.id) },
        });
      });
    } else {
      await editMd(bot, chatId, msgId, successMsg, { inline_keyboard: feedActions(feed.id) });
    }
  } catch (err: any) {
    await editMd(bot, chatId, msgId, softError("Failed to add podcast", "Please try again later\\."),
      { inline_keyboard: [homeRow()] });
  }
}

// ─── DISCOVER ─────────────────────────────────────────────────────────────────

async function cmdDiscover(bot: TelegramBot, chatId: number, msgId?: number): Promise<void> {
  const text = discoverMsg();
  const kb   = { inline_keyboard: discoverCategoriesKb() };
  msgId ? await editMd(bot, chatId, msgId, text, kb)
        : await sendMd(bot, chatId, text, { reply_markup: kb });
}

async function handleDiscoverCategory(
  bot: TelegramBot, chatId: number, msgId: number, category: string
): Promise<void> {
  await editMd(bot, chatId, msgId, `🔍 *Searching "${esc(category)}"\\.\\.\\.*`);
  await handlePodcastSearchEdit(bot, chatId, msgId, category);
}

// ─── COUNTRY PICKER ───────────────────────────────────────────────────────────

async function showCountryPicker(
  bot: TelegramBot, chatId: number, page: number, msgId?: number
): Promise<void> {
  const entries    = getCountriesPage(page);
  const totalPages = totalCountryPages();

  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  for (let i = 0; i < entries.length; i += 2) {
    const row: TelegramBot.InlineKeyboardButton[] = [
      { text: entries[i][1], callback_data: `trend_c:${entries[i][0]}:0` },
    ];
    if (entries[i + 1]) row.push({ text: entries[i + 1][1], callback_data: `trend_c:${entries[i + 1][0]}:0` });
    rows.push(row);
  }

  const nav: TelegramBot.InlineKeyboardButton[] = [];
  if (page > 0)               nav.push({ text: "◀️ Prev", callback_data: `country_page:${page - 1}` });
  nav.push({ text: `${page + 1}/${totalPages}`, callback_data: "noop" });
  if (page < totalPages - 1)  nav.push({ text: "Next ▶️", callback_data: `country_page:${page + 1}` });
  rows.push(nav);
  rows.push([{ text: "🔤 Enter Any Country Code", callback_data: "country_type" }]);
  rows.push(homeRow());

  const text = `🌍 *Trending Podcasts*\n${DIV}\nSelect a country · Page ${page + 1} of ${totalPages}`;
  if (msgId) await editMd(bot, chatId, msgId, text, { inline_keyboard: rows });
  else       await sendMd(bot, chatId, text, { reply_markup: { inline_keyboard: rows } });
}

// ─── TOP CHARTS ───────────────────────────────────────────────────────────────

async function showTopCharts(
  bot: TelegramBot, chatId: number, page: number, country: string, msgId?: number
): Promise<void> {
  const label = findCountry(country) ?? country.toUpperCase();
  const loader = `⏳ *Loading Charts\\.\\.\\.*\n${DIV}\n🌍 ${esc(label)}`;

  let curId: number;
  if (msgId) { await editMd(bot, chatId, msgId, loader); curId = msgId; }
  else       { const m = await sendMd(bot, chatId, loader); curId = m.message_id; }

  try {
    const all        = await fetchTopCharts(country, 100);
    const totalPages = Math.max(1, Math.ceil(all.length / CHART_PAGE));
    const slice      = all.slice(page * CHART_PAGE, (page + 1) * CHART_PAGE);
    const start      = page * CHART_PAGE + 1;

    const keyboard: TelegramBot.InlineKeyboardButton[][] = slice.map((p, i) => [{
      text: `${start + i}. ${trunc(p.name, 32)}`,
      callback_data: `disc_sub:${p.id}`,
    }]);

    const nav: TelegramBot.InlineKeyboardButton[] = [];
    if (page > 0)              nav.push({ text: "◀️ Prev", callback_data: `charts_page:${country}:${page - 1}` });
    nav.push({ text: `${page + 1}/${totalPages}`, callback_data: "noop" });
    if (page < totalPages - 1) nav.push({ text: "Next ▶️", callback_data: `charts_page:${country}:${page + 1}` });
    if (nav.length) keyboard.push(nav);
    keyboard.push([{ text: "🌍 Change Country", callback_data: "country_page:0" }]);
    keyboard.push(homeRow());

    const text = [
      `🏆 *Top Podcasts · ${esc(label)}*`, DIV,
      `Page ${page + 1} of ${totalPages}`, `──────────`,
      ...slice.map((p, i) => `${start + i}\\. *${esc(trunc(p.name, 28))}*\n    ${esc(trunc(p.artist, 24))}`),
      DIV, `Tap a podcast to subscribe\\.`,
    ].join("\n");

    await editMd(bot, chatId, curId, text, { inline_keyboard: keyboard });
  } catch {
    await editMd(bot, chatId, curId,
      softError("Charts unavailable", "Please try a different country\\."),
      { inline_keyboard: [[{ text: "🌍 Try Another Country", callback_data: "country_page:0" }], homeRow()] });
  }
}

// ─── PODCAST SEARCH ───────────────────────────────────────────────────────────

async function handlePodcastSearch(bot: TelegramBot, chatId: number, query: string): Promise<void> {
  const loadMsg = await sendMd(bot, chatId, `🔍 *Searching iTunes…*\n${DIV}\n"${esc(trunc(query, 30))}"`);
  await handlePodcastSearchEdit(bot, chatId, loadMsg.message_id, query);
}

async function handlePodcastSearchEdit(bot: TelegramBot, chatId: number, msgId: number, query: string): Promise<void> {
  try {
    const results = await searchPodcasts(query, "us", 20);
    if (!results.length) {
      await editMd(bot, chatId, msgId,
        [`🔍 *No Results*`, DIV, `Nothing found for "${esc(trunc(query, 28))}"\\.\nTry different keywords\\.`].join("\n"),
        { inline_keyboard: [homeRow()] });
      return;
    }

    const keyboard: TelegramBot.InlineKeyboardButton[][] = results.map((p, i) => [{
      text: `${i + 1}. ${trunc(p.name, 32)}`,
      callback_data: `disc_sub:${p.id}`,
    }]);
    keyboard.push(homeRow());

    const text = [
      `🌐 *"${esc(trunc(query, 22))}" · ${results.length} results*`, DIV,
      ...results.map((p, i) => `${i + 1}\\. *${esc(trunc(p.name, 28))}*\n    ${esc(trunc(p.artist, 24))}`),
      DIV, `Tap to subscribe\\.`,
    ].join("\n");

    await editMd(bot, chatId, msgId, text, { inline_keyboard: keyboard });
  } catch {
    await editMd(bot, chatId, msgId, softError("Search failed", "Please try again later\\."), { inline_keyboard: [homeRow()] });
  }
}

// ─── SUBSCRIBE FROM DISCOVERY ─────────────────────────────────────────────────

async function subscribeFromDiscovery(
  bot: TelegramBot, chatId: number, msgId: number, itunesId: string
): Promise<void> {
  const cached = getCachedPodcast(itunesId);
  let name = cached?.name ?? itunesId;
  let rssUrl = cached?.feedUrl ?? null;

  await editMd(bot, chatId, msgId, `⏳ *Resolving Feed\\.\\.\\.*\n${DIV}\n📻 ${esc(name)}`);

  try {
    if (!rssUrl) {
      rssUrl = await resolveRssFeed(itunesId);
      if (!rssUrl) {
        await editMd(bot, chatId, msgId,
          softError("RSS feed not found", "Apple Podcasts did not return an RSS URL\\. Try /add instead\\."),
          { inline_keyboard: [homeRow()] });
        return;
      }
    }

    const existing = await db.select().from(feedsTable)
      .where(and(eq(feedsTable.chatId, String(chatId)), eq(feedsTable.url, rssUrl))).limit(1);
    if (existing.length) {
      await editMd(bot, chatId, msgId,
        [`⚠️ *Already Subscribed*`, DIV, `📻 ${esc(trunc(existing[0].title, 28))}`].join("\n"),
        { inline_keyboard: [[{ text: "▶️ Browse Feed", callback_data: `feed:${existing[0].id}` }], homeRow()] });
      return;
    }

    await editMd(bot, chatId, msgId, `⏳ *Fetching Episodes\\.\\.\\.*\n${DIV}\n📻 ${esc(name)}`);

    const feedData = await fetchFeed(rssUrl, true);
    name = feedData.title || name;
    const [feed] = await db.insert(feedsTable).values({
      chatId: String(chatId), url: rssUrl, title: name,
      author: feedData.author, imageUrl: feedData.imageUrl, lastChecked: new Date(),
    }).returning();

    if (feedData.episodes.length) {
      const CHUNK = 100;
      for (let i = 0; i < feedData.episodes.length; i += CHUNK) {
        await db.insert(episodesTable).values(
          feedData.episodes.slice(i, i + CHUNK).map((ep) => ({
            feedId: feed.id, guid: ep.guid, title: ep.title,
            description: ep.description, audioUrl: ep.audioUrl,
            imageUrl: ep.imageUrl, pubDate: ep.pubDate, duration: ep.duration,
            episodeNumber: ep.episodeNumber,
            chapters: ep.chapters ? JSON.stringify(ep.chapters) : null,
          }))
        ).onConflictDoNothing();
      }
      await db.update(feedsTable).set({ lastEpisodeGuid: feedData.episodes[0]?.guid ?? null })
        .where(eq(feedsTable.id, feed.id));
    }

    const successMsg = addSuccessMsg({ title: name, episodeCount: feedData.episodes.length });
    await editMd(bot, chatId, msgId, successMsg, { inline_keyboard: feedActions(feed.id) });
  } catch {
    await editMd(bot, chatId, msgId,
      softError("Failed to subscribe", "Please try again or use /add with the RSS URL directly\\."),
      { inline_keyboard: [homeRow()] });
  }
}

// ─── EPISODE SEARCH ───────────────────────────────────────────────────────────

async function handleEpisodeSearch(bot: TelegramBot, chatId: number, query: string): Promise<void> {
  const feeds = await db.select({ id: feedsTable.id }).from(feedsTable).where(eq(feedsTable.chatId, String(chatId)));
  if (!feeds.length) {
    await sendMd(bot, chatId, `📭 *No Subscriptions*\n${DIV}\nSubscribe first with /add\\.`, { reply_markup: { inline_keyboard: [homeRow()] } });
    return;
  }

  const arr   = sqlArr(feeds.map((f) => f.id));
  const safeQ = query.replace(/[%_]/g, "\\$&");

  const results = await db.select().from(episodesTable)
    .where(and(
      sql`${episodesTable.feedId} = ANY(${arr})`,
      or(
        like(episodesTable.title, `%${safeQ}%`),
        like(episodesTable.description, `%${safeQ}%`),
      )
    ))
    .orderBy(desc(episodesTable.pubDate)).limit(10);

  const text = results.length
    ? [
        `🔍 *"${esc(trunc(query, 20))}"* · ${results.length}`,
        DIV,
        ...results.map((ep, i) => `${i + 1}\\. ${ep.listened ? "✅" : "🔵"} ${esc(trunc(ep.title, 26))}`),
      ].join("\n")
    : [`🔍 *No Results*`, DIV, `Nothing found for "${esc(trunc(query, 24))}"`, `Try a different keyword\\.`].join("\n");

  const keyboard: TelegramBot.InlineKeyboardButton[][] = results.map((ep, i) => [{ text: `${i + 1}. ${trunc(ep.title, 30)}`, callback_data: `ep:${ep.id}` }]);
  keyboard.push(homeRow());
  await sendMd(bot, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}

// ─── TRANSCRIPT SEARCH ────────────────────────────────────────────────────────

async function handleTranscriptSearch(bot: TelegramBot, chatId: number, query: string): Promise<void> {
  const feeds = await db.select({ id: feedsTable.id }).from(feedsTable).where(eq(feedsTable.chatId, String(chatId)));
  if (!feeds.length) { await sendMd(bot, chatId, `📭 No subscriptions yet\\.`); return; }

  const arr   = sqlArr(feeds.map((f) => f.id));
  const safeQ = query.replace(/[%_]/g, "\\$&");

  const results = await db.select().from(episodesTable)
    .where(and(
      sql`${episodesTable.feedId} = ANY(${arr})`,
      like(episodesTable.transcript, `%${safeQ}%`)
    ))
    .limit(5);

  if (!results.length) {
    await sendMd(bot, chatId, [`🔍 *No Results in Transcripts*`, DIV, `No transcripts contain "${esc(trunc(query, 20))}"\\.`].join("\n"));
    return;
  }

  const text = [
    `🔍 *In Transcripts: "${esc(trunc(query, 18))}"*`, DIV,
    results.map((r, i) => `${i + 1}\\. ${esc(trunc(r.title, 26))}`).join("\n"),
  ].join("\n");

  const kb: TelegramBot.InlineKeyboardButton[][] = results.map((r, i) => [{ text: `${i + 1}. ${trunc(r.title, 28)}`, callback_data: `ep:${r.id}` }]);
  kb.push(homeRow());
  await sendMd(bot, chatId, text, { reply_markup: { inline_keyboard: kb } });
}

// ─── SETTINGS ─────────────────────────────────────────────────────────────────

async function cmdSettings(bot: TelegramBot, chatId: number, msgId?: number): Promise<void> {
  const prefs = await getUserPrefs(String(chatId));
  const text  = settingsMsg(prefs as any);
  const kb    = { inline_keyboard: settingsRows(prefs as any) };
  msgId ? await editMd(bot, chatId, msgId, text, kb)
        : await sendMd(bot, chatId, text, { reply_markup: kb });
}

async function showSettingsEdit(bot: TelegramBot, chatId: number, msgId: number): Promise<void> {
  const prefs = await getUserPrefs(String(chatId));
  await editMd(bot, chatId, msgId, settingsMsg(prefs as any), { inline_keyboard: settingsRows(prefs as any) });
}

async function toggleAutoDownload(bot: TelegramBot, chatId: number, msgId: number): Promise<void> {
  const prefs = await getUserPrefs(String(chatId));
  await upsertUserPrefs(String(chatId), { autoDownload: !prefs.autoDownload });
  await showSettingsEdit(bot, chatId, msgId);
}

// ─── NOTES / BOOKMARKS ────────────────────────────────────────────────────────

async function cmdNotes(bot: TelegramBot, chatId: number, msgId?: number): Promise<void> {
  const notes = await db.select({
    id: bookmarksTable.id, note: bookmarksTable.note, createdAt: bookmarksTable.createdAt,
    episodeTitle: episodesTable.title,
  }).from(bookmarksTable)
    .innerJoin(episodesTable, eq(bookmarksTable.episodeId, episodesTable.id))
    .where(eq(bookmarksTable.chatId, String(chatId)))
    .orderBy(desc(bookmarksTable.createdAt)).limit(10);

  const text = notesMsg(notes.map((n) => ({
    episodeTitle: n.episodeTitle,
    note: n.note ?? "",
    createdAt: n.createdAt ?? new Date(),
  })));
  const kb = { inline_keyboard: [homeRow()] };
  msgId ? await editMd(bot, chatId, msgId, text, kb)
        : await sendMd(bot, chatId, text, { reply_markup: kb });
}

async function initNoteMode(bot: TelegramBot, chatId: number, msgId: number, epId: number): Promise<void> {
  const sess  = getSession(chatId);
  sess.action = "awaiting_note";
  sess.extra  = epId;
  await editMd(bot, chatId, msgId,
    [`📝 *Add Note*`, DIV, `Send your note now:`].join("\n"),
    { inline_keyboard: [[{ text: "❌ Cancel", callback_data: `ep:${epId}` }]] });
}

async function handleSaveNote(bot: TelegramBot, chatId: number, epId: number, note: string): Promise<void> {
  await db.insert(bookmarksTable).values({ chatId: String(chatId), episodeId: epId, note });
  await sendMd(bot, chatId, doneMsg("Note saved"));
}

// ─── AI FEATURES ──────────────────────────────────────────────────────────────

async function initAskMode(bot: TelegramBot, chatId: number, msgId: number, epId: number): Promise<void> {
  const ep = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;
  if (!ep[0].transcript && !ep[0].description) {
    await editMd(bot, chatId, msgId, softError("No content to ask about", "Transcribe this episode first\\."), { inline_keyboard: [homeRow()] });
    return;
  }
  if (!hasGroqKey()) {
    await editMd(bot, chatId, msgId, `⚠️ AI is not configured\\.`);
    return;
  }
  const sess = getSession(chatId);
  sess.action = "awaiting_ask";
  sess.extra  = epId;
  sess.currentEpisodeId = epId;
  sess.askHistory = [];
  await editMd(bot, chatId, msgId,
    [`🤖 *Ask AI about*`, DIV, `🎙 ${esc(trunc(ep[0].title, 28))}`, DIV, `Send your question:`].join("\n"),
    { inline_keyboard: [[{ text: "❌ Stop", callback_data: `ep:${epId}` }]] });
}

async function cmdAsk(bot: TelegramBot, chatId: number, question: string): Promise<void> {
  const sess = getSession(chatId);
  const epId = sess.currentEpisodeId;
  if (!epId) {
    await sendMd(bot, chatId, softError("No episode selected", "Open an episode first, then tap 🤖 Ask AI\\."));
    return;
  }
  if (!question) {
    await sendMd(bot, chatId, [`🤖 *Ask AI*`, DIV, `Usage: /ask your question here`].join("\n"));
    return;
  }
  await handleAskReply(bot, chatId, epId, question);
}

async function handleAskReply(bot: TelegramBot, chatId: number, epId: number, question: string): Promise<void> {
  if (!hasGroqKey()) {
    await sendMd(bot, chatId, `⚠️ AI is not configured\\.`);
    return;
  }
  const ep = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) { clearSession(chatId); return; }

  const sess = getSession(chatId);
  sess.lastActive = Date.now();
  const history = sess.askHistory ?? [];

  await withSpinner(bot, chatId, "Thinking", async () => {
    const answer = await chatWithEpisode(
      question, ep[0].title,
      ep[0].transcript ?? ep[0].description ?? "",
      history
    );
    history.push({ role: "user", content: question });
    history.push({ role: "assistant", content: answer });
    sess.askHistory = history.slice(-10);

    const text = [
      `💬 *${esc(trunc(question, 26))}*`,
      DIV,
      esc(trunc(answer, 800)),
    ].join("\n");
    await sendMd(bot, chatId, text, {
      reply_markup: { inline_keyboard: [[{ text: "❌ Stop AI chat", callback_data: `ep:${epId}` }]] },
    });
  });
}

async function handleEpSummarize(bot: TelegramBot, chatId: number, epId: number): Promise<void> {
  if (!hasGroqKey()) { await sendMd(bot, chatId, `⚠️ AI is not configured\\.`); return; }
  const ep = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;
  const text = ep[0].transcript ?? ep[0].description ?? "";
  if (!text) { await sendMd(bot, chatId, softError("No content to summarise", "Transcribe this episode first\\.")); return; }

  await withSpinner(bot, chatId, "Generating summary", async () => {
    const summary = await summarizeText(text, ep[0].title);
    await sendMd(bot, chatId, summaryMsg(ep[0].title, summary));
  });
}

async function handleEpTranscribe(bot: TelegramBot, chatId: number, epId: number): Promise<void> {
  if (!hasGroqKey()) { await sendMd(bot, chatId, `⚠️ AI is not configured\\.`); return; }
  const ep = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]?.audioUrl) { await sendMd(bot, chatId, softError("No audio URL", "This episode has no audio to transcribe\\.")); return; }

  let spinIdx = 0;
  const statusMsg = await sendMd(bot, chatId, `${SPINNER[0]} Transcribing…`);
  const interval  = setInterval(async () => {
    spinIdx = (spinIdx + 1) % SPINNER.length;
    await bot.editMessageText(`${SPINNER[spinIdx]} Transcribing…`, { chat_id: chatId, message_id: statusMsg.message_id }).catch(() => {});
  }, 400);

  try {
    const transcript = await transcribeEpisodeFull(ep[0].audioUrl, {
      onProgress: async (msg) => {
        await bot.editMessageText(msg, { chat_id: chatId, message_id: statusMsg.message_id }).catch(() => {});
      },
    });

    await db.update(episodesTable).set({ transcript, transcriptAt: new Date() }).where(eq(episodesTable.id, epId));

    clearInterval(interval);
    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

    await sendMd(bot, chatId, doneMsg("Transcription complete"));
    await sendLongText(bot, chatId, transcript);
  } catch (err: any) {
    clearInterval(interval);
    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    await sendMd(bot, chatId, softError("Transcription failed", err?.message?.slice(0, 60) ?? "Please try again\\."));
  }
}

async function handleEpShare(bot: TelegramBot, chatId: number, _msgId: number, epId: number): Promise<void> {
  const ep = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;
  const feed = await db.select({ title: feedsTable.title }).from(feedsTable)
    .where(eq(feedsTable.id, ep[0].feedId)).limit(1);

  const card = shareCard({
    title: ep[0].title,
    feedTitle: feed[0]?.title,
    pubDate: ep[0].pubDate,
    duration: ep[0].duration,
    description: ep[0].description,
  });

  await sendMd(bot, chatId, card, {
    reply_markup: { inline_keyboard: [[{ text: "◀️ رجوع للحلقة", callback_data: `ep:${epId}` }]] },
  });
}

async function handleAiSummary(bot: TelegramBot, chatId: number, epId: number): Promise<void> {
  if (!hasGroqKey()) { await sendMd(bot, chatId, `⚠️ AI is not configured\\.`); return; }
  const ep = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]?.transcript) { await sendMd(bot, chatId, softError("No transcript", "Transcribe this episode first\\.")); return; }
  const feed = await db.select({ title: feedsTable.title }).from(feedsTable).where(eq(feedsTable.id, ep[0].feedId)).limit(1);

  await withSpinner(bot, chatId, "Generating summary", async () => {
    const summary = await generateSummary(ep[0].transcript!, feed[0]?.title ?? "", ep[0].title);
    await sendLongText(bot, chatId, summary);
  });
}

async function handleAiDetail(bot: TelegramBot, chatId: number, epId: number): Promise<void> {
  if (!hasGroqKey()) { await sendMd(bot, chatId, `⚠️ AI is not configured\\.`); return; }
  const ep = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]?.transcript) { await sendMd(bot, chatId, softError("No transcript", "Transcribe this episode first\\.")); return; }
  const feed = await db.select({ title: feedsTable.title }).from(feedsTable).where(eq(feedsTable.id, ep[0].feedId)).limit(1);

  await withSpinner(bot, chatId, "Generating detailed analysis", async () => {
    const detail = await generateDeepExplanation(ep[0].transcript!, feed[0]?.title ?? "", ep[0].title);
    await sendLongText(bot, chatId, detail);
  });
}

async function handleTranscriptPdf(bot: TelegramBot, chatId: number, epId: number): Promise<void> {
  const ep = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]?.transcript) { await sendMd(bot, chatId, softError("No transcript", "Transcribe this episode first\\.")); return; }
  const feed = await db.select({ title: feedsTable.title }).from(feedsTable).where(eq(feedsTable.id, ep[0].feedId)).limit(1);

  await withSpinner(bot, chatId, "Generating PDF", async () => {
    const pdfBuf = await generateTranscriptPdf({
      episodeTitle: ep[0].title,
      podcastTitle: feed[0]?.title ?? "",
      transcript: ep[0].transcript!,
    });
    await bot.sendDocument(chatId, pdfBuf as any, {
      caption: `📄 ${ep[0].title.slice(0, 40)}`,
    }, { filename: `transcript-${epId}.pdf`, contentType: "application/pdf" });
  });
}

// ─── DOWNLOAD ─────────────────────────────────────────────────────────────────

async function handleDownload(bot: TelegramBot, chatId: number, epId: number): Promise<void> {
  const ep = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]?.audioUrl) { await sendMd(bot, chatId, softError("No audio URL", "This episode has no audio to download\\.")); return; }
  const feed = await db.select({ title: feedsTable.title }).from(feedsTable).where(eq(feedsTable.id, ep[0].feedId)).limit(1);

  let statusMsgId: number | undefined;
  try {
    const statusMsg = await sendMd(bot, chatId, `⬇️ *Preparing download\\.\\.\\.*`);
    statusMsgId = statusMsg.message_id;
    await sendEpisodeAudio({
      chatId, episodeTitle: ep[0].title,
      feedTitle: feed[0]?.title ?? "", audioUrl: ep[0].audioUrl, episodeId: epId,
      onProgress: async (text) => {
        if (statusMsgId) {
          await bot.editMessageText(esc(text), { chat_id: chatId, message_id: statusMsgId, parse_mode: MV2 }).catch(() => {});
        }
      },
    });
    if (statusMsgId) await bot.deleteMessage(chatId, statusMsgId).catch(() => {});
  } catch (err: any) {
    if (statusMsgId) await bot.editMessageText(softError("Download failed", err?.message?.slice(0, 60) ?? "Please try again\\."), {
      chat_id: chatId, message_id: statusMsgId, parse_mode: MV2,
    }).catch(() => {});
  }
}

// ─── FAVOURITES TOGGLE ────────────────────────────────────────────────────────

async function toggleFavourite(bot: TelegramBot, chatId: number, msgId: number, epId: number): Promise<void> {
  const ex = await db.select().from(favoritesTable)
    .where(and(eq(favoritesTable.chatId, String(chatId)), eq(favoritesTable.episodeId, epId))).limit(1);
  if (ex.length) {
    await db.delete(favoritesTable).where(eq(favoritesTable.id, ex[0].id));
    await bot.answerCallbackQuery("", { text: "🤍 Removed from favourites" }).catch(() => {});
  } else {
    await db.insert(favoritesTable).values({ chatId: String(chatId), episodeId: epId });
    await bot.answerCallbackQuery("", { text: "❤️ Added to favourites" }).catch(() => {});
  }
  await showEpisodeDetail(bot, chatId, msgId, epId);
}

// ─── QUEUE ────────────────────────────────────────────────────────────────────

async function addToQueue(bot: TelegramBot, chatId: number, msgId: number, epId: number): Promise<void> {
  const ex = await db.select().from(queueTable)
    .where(and(eq(queueTable.chatId, String(chatId)), eq(queueTable.episodeId, epId))).limit(1);
  if (!ex.length) {
    const [{ m }] = await db.select({ m: sql<number>`COALESCE(MAX(${queueTable.position}), 0)` })
      .from(queueTable).where(eq(queueTable.chatId, String(chatId)));
    await db.insert(queueTable).values({ chatId: String(chatId), episodeId: epId, position: (m ?? 0) + 1 });
    await bot.answerCallbackQuery("", { text: "⏭ Added to queue" }).catch(() => {});
  } else {
    await bot.answerCallbackQuery("", { text: "✅ Already in queue" }).catch(() => {});
  }
  await showEpisodeDetail(bot, chatId, msgId, epId);
}

async function removeFromQueue(chatId: number, epId: number): Promise<void> {
  await db.delete(queueTable).where(and(eq(queueTable.chatId, String(chatId)), eq(queueTable.episodeId, epId)));
}

async function moveQueue(chatId: number, epId: number, direction: "up" | "down"): Promise<void> {
  const items = await db.select().from(queueTable)
    .where(eq(queueTable.chatId, String(chatId))).orderBy(queueTable.position);
  const idx = items.findIndex((i) => i.episodeId === epId);
  if (idx < 0) return;
  const swapIdx = direction === "up" ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= items.length) return;
  const a = items[idx]; const b = items[swapIdx];
  await db.update(queueTable).set({ position: b.position }).where(eq(queueTable.id, a.id));
  await db.update(queueTable).set({ position: a.position }).where(eq(queueTable.id, b.id));
}

// ─── MARK LISTENED ────────────────────────────────────────────────────────────

async function markListened(bot: TelegramBot, chatId: number, msgId: number, epId: number): Promise<void> {
  const ep = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;
  const newListened = !ep[0].listened;
  await db.update(episodesTable).set({
    listened: newListened, progress: newListened ? 1 : 0, updatedAt: new Date(),
  }).where(eq(episodesTable.id, epId));
  if (newListened) {
    await sendMd(bot, chatId, celebrationMsg(ep[0].title));
  }
  await showEpisodeDetail(bot, chatId, msgId, epId);
}

// ─── DELETE FEED ──────────────────────────────────────────────────────────────

async function showDeleteFeedConfirm(bot: TelegramBot, chatId: number, msgId: number, feedId: number): Promise<void> {
  const feed = await db.select().from(feedsTable).where(eq(feedsTable.id, feedId)).limit(1);
  if (!feed[0]) return;
  await editMd(bot, chatId, msgId,
    [`🗑 *Remove Podcast?*`, DIV, `📻 ${esc(trunc(feed[0].title, 28))}`, ``, `This cannot be undone\\.`].join("\n"),
    { inline_keyboard: [
      [{ text: "✅ Yes, Remove", callback_data: `del_feed:${feedId}` }],
      [{ text: "❌ Cancel",      callback_data: `feed:${feedId}` }],
    ]});
}

async function deleteFeed(bot: TelegramBot, chatId: number, msgId: number, feedId: number): Promise<void> {
  const feed = await db.select().from(feedsTable).where(eq(feedsTable.id, feedId)).limit(1);
  if (!feed[0]) return;
  await db.delete(feedsTable).where(eq(feedsTable.id, feedId));
  await editMd(bot, chatId, msgId,
    doneMsg(`"${trunc(feed[0].title, 28)}" removed`),
    { inline_keyboard: [[{ text: "📻 My Feeds", callback_data: "cmd:feeds" }], homeRow()] });
}

// ─── RATINGS ──────────────────────────────────────────────────────────────────

async function handleSetRating(bot: TelegramBot, chatId: number, msgId: number, feedId: number, rating: number): Promise<void> {
  await db.insert(ratingsTable).values({ chatId: String(chatId), feedId, rating })
    .onConflictDoUpdate ? undefined : undefined;
  try {
    await db.insert(ratingsTable).values({ chatId: String(chatId), feedId, rating });
  } catch {
    await db.update(ratingsTable).set({ rating })
      .where(and(eq(ratingsTable.chatId, String(chatId)), eq(ratingsTable.feedId, feedId)));
  }
  await editMd(bot, chatId, msgId, `${"⭐".repeat(rating)} *Rated\\!*\n${DIV}\nThanks for your rating\\.`,
    { inline_keyboard: [[{ text: "▶️ Browse Feed", callback_data: `feed:${feedId}` }], homeRow()] });
}

// ─── TAGS ─────────────────────────────────────────────────────────────────────

async function cmdTags(bot: TelegramBot, chatId: number, msgId?: number): Promise<void> {
  const tags = await db.select().from(tagsTable)
    .where(eq(tagsTable.chatId, String(chatId))).orderBy(tagsTable.name);

  if (!tags.length) {
    const text = `🏷 *No Tags Yet*\n${DIV}\nCreate tags to organise your episodes\\.`;
    const kb   = { inline_keyboard: [[{ text: "➕ Create Tag", callback_data: "tag_new" }], homeRow()] };
    msgId ? await editMd(bot, chatId, msgId, text, kb) : await sendMd(bot, chatId, text, { reply_markup: kb });
    return;
  }

  const counts = await Promise.all(tags.map((t) =>
    db.select({ c: count() }).from(episodeTagsTable).where(eq(episodeTagsTable.tagId, t.id))
  ));

  const keyboard: TelegramBot.InlineKeyboardButton[][] = tags.map((t, i) => [
    { text: `🏷 ${trunc(t.name, 26)} (${counts[i][0].c})`, callback_data: `tag_list:${t.id}` },
    { text: "🗑", callback_data: `tag_del:${t.id}` },
  ]);
  keyboard.push([{ text: "➕ Create Tag", callback_data: "tag_new" }]);
  keyboard.push(homeRow());

  const text = [
    `🏷 *Tags \\(${tags.length}\\)*`, DIV,
    ...tags.map((t, i) => `🏷 *${esc(trunc(t.name, 28))}* — ${counts[i][0].c} episode${counts[i][0].c !== 1 ? "s" : ""}`),
  ].join("\n");

  msgId ? await editMd(bot, chatId, msgId, text, { inline_keyboard: keyboard })
        : await sendMd(bot, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}

async function createTag(bot: TelegramBot, chatId: number, name: string): Promise<void> {
  if (!name.trim()) { await sendMd(bot, chatId, `⚠️ Tag name cannot be empty\\.`); return; }
  const existing = await db.select().from(tagsTable)
    .where(and(eq(tagsTable.chatId, String(chatId)), eq(tagsTable.name, name))).limit(1);
  if (existing.length) {
    await sendMd(bot, chatId, [`⚠️ *Tag Already Exists*`, DIV, `🏷 ${esc(name)}`].join("\n"), {
      reply_markup: { inline_keyboard: [homeRow()] },
    });
    return;
  }
  const [tag] = await db.insert(tagsTable).values({ chatId: String(chatId), name }).returning();
  await sendMd(bot, chatId,
    [`✅ *Tag Created*`, DIV, `🏷 *${esc(tag.name)}*`, ``, `Open an episode and tap 🏷 Tags to add it here\\.`].join("\n"),
    { reply_markup: { inline_keyboard: [[{ text: "🏷 View All Tags", callback_data: "cmd:tags" }], homeRow()] } });
}

async function showTagEpisodes(
  bot: TelegramBot, chatId: number, msgId: number, tagId: number, page: number
): Promise<void> {
  const tag = await db.select().from(tagsTable).where(eq(tagsTable.id, tagId)).limit(1);
  if (!tag[0]) return;

  const allLinks = await db.select({ episodeId: episodeTagsTable.episodeId })
    .from(episodeTagsTable).where(eq(episodeTagsTable.tagId, tagId));
  const epIds = allLinks.map((r) => r.episodeId);

  if (!epIds.length) {
    await editMd(bot, chatId, msgId, [`🏷 *${esc(trunc(tag[0].name, 28))}*`, DIV, `No episodes in this tag yet\\.`].join("\n"),
      { inline_keyboard: [[{ text: "🏷 Back to Tags", callback_data: "cmd:tags" }], homeRow()] });
    return;
  }

  const arr  = sqlArr(epIds);
  const episodes = await db.select().from(episodesTable)
    .where(sql`${episodesTable.id} = ANY(${arr})`)
    .orderBy(desc(episodesTable.pubDate))
    .limit(PAGE_SIZE).offset(page * PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(epIds.length / PAGE_SIZE));

  const keyboard: TelegramBot.InlineKeyboardButton[][] = episodes.map((ep, i) => [{
    text: `${page * PAGE_SIZE + i + 1}. ${ep.listened ? "✅" : "🔵"} ${trunc(ep.title, 28)}`,
    callback_data: `ep:${ep.id}`,
  }]);
  const navRow = paginationRow(`tag_page:${tagId}`, page, totalPages);
  if (navRow.length > 0) keyboard.push(navRow);
  keyboard.push([{ text: "🗑 Delete Tag", callback_data: `tag_del:${tagId}` }, { text: "🏷 All Tags", callback_data: "cmd:tags" }]);
  keyboard.push(homeRow());

  const text = [`🏷 *${esc(trunc(tag[0].name, 28))}*`, DIV,
    `${epIds.length} episodes · Page ${page + 1} of ${totalPages}`, `──────────`,
    ...episodes.map((ep, i) => `${page * PAGE_SIZE + i + 1}\\. ${ep.listened ? "✅" : "🔵"} ${esc(trunc(ep.title, 28))}`),
  ].join("\n");

  await editMd(bot, chatId, msgId, text, { inline_keyboard: keyboard });
}

async function showTagPicker(bot: TelegramBot, chatId: number, msgId: number, epId: number): Promise<void> {
  const tags = await db.select().from(tagsTable).where(eq(tagsTable.chatId, String(chatId))).orderBy(tagsTable.name);
  if (!tags.length) {
    await editMd(bot, chatId, msgId, `🏷 *No Tags Yet*\n${DIV}\nCreate a tag first\\.`,
      { inline_keyboard: [[{ text: "➕ Create Tag", callback_data: "tag_new" }], homeRow()] });
    return;
  }
  const epTags   = await db.select({ tagId: episodeTagsTable.tagId }).from(episodeTagsTable).where(eq(episodeTagsTable.episodeId, epId));
  const epTagSet = new Set(epTags.map((r) => r.tagId));
  const keyboard: TelegramBot.InlineKeyboardButton[][] = tags.map((t) => [{
    text: `${epTagSet.has(t.id) ? "✅" : "🔲"} ${trunc(t.name, 28)}`,
    callback_data: `tag_toggle:${epId}:${t.id}`,
  }]);
  keyboard.push([{ text: "➕ Create New Tag", callback_data: "tag_new" }]);
  keyboard.push([{ text: "◀️ Back to Episode", callback_data: `ep:${epId}` }]);
  await editMd(bot, chatId, msgId, `🏷 *Add to Tag*\n${DIV}\n✅ \\= in tag  ·  🔲 \\= not in tag\n_Tap to toggle\\._`,
    { inline_keyboard: keyboard });
}

async function toggleEpisodeTag(bot: TelegramBot, chatId: number, msgId: number, epId: number, tagId: number): Promise<void> {
  const existing = await db.select().from(episodeTagsTable)
    .where(and(eq(episodeTagsTable.episodeId, epId), eq(episodeTagsTable.tagId, tagId))).limit(1);
  if (existing.length) {
    await db.delete(episodeTagsTable).where(eq(episodeTagsTable.id, existing[0].id));
  } else {
    await db.insert(episodeTagsTable).values({ episodeId: epId, tagId });
  }
  await showTagPicker(bot, chatId, msgId, epId);
}

async function deleteTag(bot: TelegramBot, chatId: number, msgId: number, tagId: number): Promise<void> {
  const tag = await db.select().from(tagsTable).where(eq(tagsTable.id, tagId)).limit(1);
  if (!tag[0]) return;
  await db.delete(tagsTable).where(eq(tagsTable.id, tagId));
  await editMd(bot, chatId, msgId, doneMsg(`Tag "${trunc(tag[0].name, 20)}" deleted`),
    { inline_keyboard: [[{ text: "🏷 View Tags", callback_data: "cmd:tags" }], homeRow()] });
}

// ─── PLAYLIST ─────────────────────────────────────────────────────────────────

async function cmdPlaylist(bot: TelegramBot, chatId: number, input: string): Promise<void> {
  const feeds = await db.select({ id: feedsTable.id }).from(feedsTable).where(eq(feedsTable.chatId, String(chatId)));
  if (!feeds.length) { await sendMd(bot, chatId, `📭 No subscriptions yet\\.`); return; }

  if (!input) {
    await sendMd(bot, chatId, [`🎵 *Build a Playlist*`, DIV, `Usage: /playlist 30 mins tech`].join("\n"));
    return;
  }

  const minsMatch = input.match(/(\d+)/);
  const targetMins = minsMatch ? Number(minsMatch[1]) : 30;
  const arr = sqlArr(feeds.map((f) => f.id));

  const eps = await db.select().from(episodesTable)
    .where(and(sql`${episodesTable.feedId} = ANY(${arr})`, eq(episodesTable.listened, false)))
    .orderBy(desc(episodesTable.pubDate)).limit(50);

  if (!eps.length) { await sendMd(bot, chatId, `📭 No unplayed episodes available\\.`); return; }

  const shuffled = [...eps].sort(() => Math.random() - 0.5);
  let total = 0;
  const playlist: typeof eps = [];
  for (const ep of shuffled) {
    const parts = (ep.duration ?? "").split(":").map(Number);
    let secs = 0;
    if (parts.length === 3) secs = parts[0] * 3600 + parts[1] * 60 + parts[2];
    else if (parts.length === 2) secs = parts[0] * 60 + parts[1];
    const mins = secs / 60;
    if (total + mins > targetMins + 10) continue;
    playlist.push(ep);
    total += mins;
    if (total >= targetMins) break;
  }

  if (!playlist.length) { await sendMd(bot, chatId, `📭 No suitable episodes found\\.`); return; }

  for (const ep of playlist) {
    const [{ m }] = await db.select({ m: sql<number>`COALESCE(MAX(${queueTable.position}), 0)` })
      .from(queueTable).where(eq(queueTable.chatId, String(chatId)));
    await db.insert(queueTable).values({ chatId: String(chatId), episodeId: ep.id, position: (m ?? 0) + 1 });
  }

  await sendMd(bot, chatId, playlistMsg(playlist, total), {
    reply_markup: { inline_keyboard: [[{ text: "⏭ View Queue", callback_data: "cmd:queue" }], homeRow()] },
  });
}

// ─── OPML IMPORT ──────────────────────────────────────────────────────────────

async function handleOpmlImport(bot: TelegramBot, chatId: number, doc: TelegramBot.Document): Promise<void> {
  const file = await bot.getFile(doc.file_id);
  if (!file.file_path) { await sendMd(bot, chatId, softError("Could not download file", "Please try again\\.")); return; }

  const token  = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const url    = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 30_000);
  let xml: string;
  try {
    const res = await fetch(url, { signal: controller.signal });
    xml = await res.text();
  } finally {
    clearTimeout(timeout);
  }

  const urls = (xml.match(/xmlUrl="([^"]+)"/g) ?? []).map((m) => m.replace(/xmlUrl="|"/g, ""));
  if (!urls.length) { await sendMd(bot, chatId, softError("Empty or invalid OPML file", "Please send a valid \.opml file\\.")); return; }

  const statusMsg = await sendMd(bot, chatId, `⟳ Importing ${Math.min(urls.length, 20)} podcasts…`);
  let added = 0;
  for (const rssUrl of urls.slice(0, 20)) {
    try {
      if (!isValidFeedUrl(rssUrl)) continue;
      const existing = await db.select({ id: feedsTable.id }).from(feedsTable)
        .where(and(eq(feedsTable.chatId, String(chatId)), eq(feedsTable.url, rssUrl))).limit(1);
      if (existing.length) continue;
      const feedData = await fetchFeed(rssUrl, true);
      const [feed]   = await db.insert(feedsTable).values({
        chatId: String(chatId), url: rssUrl, title: feedData.title,
        author: feedData.author, imageUrl: feedData.imageUrl, lastChecked: new Date(),
      }).returning();
      if (feedData.episodes.length) {
        await db.insert(episodesTable).values(
          feedData.episodes.slice(0, 50).map((ep) => ({
            feedId: feed.id, guid: ep.guid, title: ep.title,
            description: ep.description, audioUrl: ep.audioUrl,
            pubDate: ep.pubDate, duration: ep.duration,
          }))
        ).onConflictDoNothing();
      }
      added++;
    } catch { /* skip failed feeds */ }
  }

  await bot.editMessageText(doneMsg(`Imported ${added} of ${Math.min(urls.length, 20)} podcasts`), {
    chat_id: chatId, message_id: statusMsg.message_id, parse_mode: MV2,
    reply_markup: { inline_keyboard: [[{ text: "📻 My Feeds", callback_data: "cmd:feeds" }], homeRow()] },
  });
}

// ─── VOICE SEARCH ─────────────────────────────────────────────────────────────

async function handleVoiceSearch(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id;
  if (!msg.voice) return;

  await withSpinner(bot, chatId, "Converting voice to text", async () => {
    const file = await bot.getFile(msg.voice!.file_id);
    if (!file.file_path) throw new Error("File not found");
    const token    = process.env.TELEGRAM_BOT_TOKEN ?? "";
    const audioUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

    const { transcribeUrl } = await import("./ai.js");
    const transcript = await transcribeUrl(audioUrl);

    if (!transcript.trim()) {
      await sendMd(bot, chatId, softError("Could not understand audio", "Please try again or type your search\\."));
      return;
    }

    await sendMd(bot, chatId, `🎙 *Heard:* ${esc(trunc(transcript, 30))}\n${DIV}\nSearching podcasts…`);
    await handleEpisodeSearch(bot, chatId, transcript);
  });
}

// ─── ADMIN ROUTING ────────────────────────────────────────────────────────────

async function routeAdminCommand(bot: TelegramBot, chatId: number, cmd: string): Promise<void> {
  switch (cmd) {
    case "admin_users":  await cmdAdminUsers(bot, chatId);  break;
    case "admin_stats":  await cmdAdminPanel(bot, chatId);  break;
    case "admin_logs":   await cmdAdminLogs(bot, chatId);   break;
    case "main_menu":
      await sendMd(bot, chatId, `🎙 *iCast*\n${DIV}\nUse the keyboard below\\.`, {
        reply_markup: { keyboard: MAIN_KEYBOARD, resize_keyboard: true, is_persistent: true },
      });
      break;
  }
}

// ─── ADMIN PANEL ──────────────────────────────────────────────────────────────

async function cmdAdminPanel(bot: TelegramBot, chatId: number): Promise<void> {
  const [totalRows] = await db.select({ c: count() }).from(usersTable);
  const [pendingRows] = await db.select({ c: count() }).from(usersTable)
    .where(eq(usersTable.role, "pending"));
  const [blockedRows] = await db.select({ c: count() }).from(usersTable)
    .where(eq(usersTable.isBlocked, true));

  const text = adminPanelMsg({
    totalUsers:   Number(totalRows.c),
    pendingUsers: Number(pendingRows.c),
    blockedUsers: Number(blockedRows.c),
  });

  await sendMd(bot, chatId, text, {
    reply_markup: {
      keyboard: ADMIN_KEYBOARD,
      resize_keyboard: true,
      is_persistent: true,
    },
  });
}

async function cmdAdminUsers(bot: TelegramBot, chatId: number): Promise<void> {
  const users = await db.select().from(usersTable)
    .orderBy(desc(usersTable.joinedAt)).limit(20);

  if (!users.length) {
    await sendMd(bot, chatId, `👥 *لا يوجد مستخدمون بعد*`);
    return;
  }

  const lines = [
    `👥 *المستخدمون \\(${users.length}\\)*`,
    DIV,
  ];
  for (const u of users) {
    const icon = u.isBlocked ? "🚷" : u.role === "admin" || u.role === "superadmin" ? "⭐" : u.role === "user" ? "✅" : "⏳";
    const name = esc(trunc(u.firstName ?? u.username ?? u.chatId, 20));
    lines.push(`${icon} ${name} \\— \`${u.chatId}\` \\(${esc(u.role ?? "??")}\\)`);
  }

  // Split into chunks if needed
  for (const chunk of splitLong(lines.join("\n"))) {
    await sendMd(bot, chatId, chunk);
  }
}

async function cmdAdminLogs(bot: TelegramBot, chatId: number): Promise<void> {
  const logs = await db.select().from(adminLogsTable)
    .orderBy(desc(adminLogsTable.createdAt)).limit(20);

  if (!logs.length) {
    await sendMd(bot, chatId, `📋 *لا توجد سجلات بعد*`);
    return;
  }

  const lines = [
    `📋 *آخر ${logs.length} نشاط*`,
    DIV,
  ];
  for (const l of logs) {
    const date = l.createdAt ? fmtDate(l.createdAt) : "?";
    lines.push(`• ${esc(l.action)} ← \`${esc(l.adminChatId)}\`` +
      (l.targetChatId ? ` → \`${esc(l.targetChatId)}\`` : "") +
      ` \\(${esc(date)}\\)`);
  }

  for (const chunk of splitLong(lines.join("\n"))) {
    await sendMd(bot, chatId, chunk);
  }
}

// ─── ADMIN CALLBACK HANDLERS ──────────────────────────────────────────────────

async function handleAdminApprove(
  bot: TelegramBot, chatId: number,
  query: TelegramBot.CallbackQuery, targetChatId: string
): Promise<void> {
  await approveUser(bot, targetChatId, String(chatId));
  await bot.answerCallbackQuery(query.id, { text: `✅ تمت الموافقة` });
  if (query.message) {
    await bot.editMessageText(
      `✅ تمت الموافقة على \`${targetChatId}\``,
      { chat_id: chatId, message_id: query.message.message_id, parse_mode: "Markdown" }
    ).catch(() => {});
  }
}

async function handleAdminReject(
  bot: TelegramBot, chatId: number,
  query: TelegramBot.CallbackQuery, targetChatId: string
): Promise<void> {
  await rejectUser(bot, targetChatId, String(chatId));
  await bot.answerCallbackQuery(query.id, { text: `❌ تم الرفض` });
  if (query.message) {
    await bot.editMessageText(
      `❌ تم رفض \`${targetChatId}\``,
      { chat_id: chatId, message_id: query.message.message_id, parse_mode: "Markdown" }
    ).catch(() => {});
  }
}

async function handleAdminBlock(
  bot: TelegramBot, chatId: number,
  query: TelegramBot.CallbackQuery, targetChatId: string
): Promise<void> {
  await blockUser(bot, targetChatId, String(chatId), "تم حظرك من قبل الأدمن");
  await bot.answerCallbackQuery(query.id, { text: `🚷 تم الحظر` });
  if (query.message) {
    await bot.editMessageText(
      `🚷 تم حظر \`${targetChatId}\``,
      { chat_id: chatId, message_id: query.message.message_id, parse_mode: "Markdown" }
    ).catch(() => {});
  }
}

// ─── HARVARD PROFESSOR DEEP EXPLANATION ───────────────────────────────────────

async function handleEpDeepExplanation(bot: TelegramBot, chatId: number, epId: number): Promise<void> {
  if (!hasGroqKey()) { await sendMd(bot, chatId, `⚠️ AI is not configured\\.`); return; }

  const ep = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;

  const text = ep[0].transcript ?? ep[0].description ?? "";
  if (!text) {
    await sendMd(bot, chatId, softError("لا يوجد محتوى للتحليل", "قم بتفريغ الحلقة أولاً\\."));
    return;
  }

  const feed = await db.select({ title: feedsTable.title }).from(feedsTable)
    .where(eq(feedsTable.id, ep[0].feedId)).limit(1);

  await withSpinner(bot, chatId, "🎓 Harvard Professor analyzing", async () => {
    const explanation = await generateDeepExplanation(
      text, feed[0]?.title ?? "", ep[0].title
    );
    const chunks = splitLong(explanation, 4000);
    for (const chunk of chunks) {
      await bot.sendMessage(chatId, chunk);
    }
    await sendMd(bot, chatId, `💡 *انتهى الشرح العميق*`, {
      reply_markup: { inline_keyboard: [
        [{ text: "❓ 100 سؤال", callback_data: `ep:questions:${epId}` }],
        [{ text: "◀️ رجوع للحلقة", callback_data: `ep:${epId}` }],
        homeRow(),
      ]},
    });
  });
}

// ─── 100 CRITICAL THINKING QUESTIONS ─────────────────────────────────────────

async function handleEpQuestions(bot: TelegramBot, chatId: number, epId: number): Promise<void> {
  if (!hasGroqKey()) { await sendMd(bot, chatId, `⚠️ AI is not configured\\.`); return; }

  const ep = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;

  const text = ep[0].transcript ?? ep[0].description ?? "";
  if (!text) {
    await sendMd(bot, chatId, softError("لا يوجد محتوى للأسئلة", "قم بتفريغ الحلقة أولاً\\."));
    return;
  }

  const feed = await db.select({ title: feedsTable.title }).from(feedsTable)
    .where(eq(feedsTable.id, ep[0].feedId)).limit(1);

  await withSpinner(bot, chatId, "❓ Generating critical questions", async () => {
    const questions = await generateCriticalQuestions(
      text, feed[0]?.title ?? "", ep[0].title
    );
    const chunks = splitLong(questions, 4000);
    for (const chunk of chunks) {
      await bot.sendMessage(chatId, chunk);
    }
    await sendMd(bot, chatId, `❓ *تم توليد الأسئلة\\!*`, {
      reply_markup: { inline_keyboard: [
        [{ text: "🎲 100 سؤال جديد", callback_data: `questions_new:${epId}` }],
        [{ text: "💡 شرح عميق",      callback_data: `ep:deep:${epId}` }],
        [{ text: "◀️ رجوع للحلقة",   callback_data: `ep:${epId}` }],
        homeRow(),
      ]},
    });
  });
}

async function handleEpQuestionsNew(bot: TelegramBot, chatId: number, epId: number): Promise<void> {
  if (!hasGroqKey()) { await sendMd(bot, chatId, `⚠️ AI is not configured\\.`); return; }

  const ep = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;

  const text = ep[0].transcript ?? ep[0].description ?? "";
  if (!text) return;

  const feed = await db.select({ title: feedsTable.title }).from(feedsTable)
    .where(eq(feedsTable.id, ep[0].feedId)).limit(1);

  await withSpinner(bot, chatId, "🎲 Generating NEW questions", async () => {
    const questions = await generateCriticalQuestions(
      text, feed[0]?.title ?? "", ep[0].title, Date.now()
    );
    const chunks = splitLong(questions, 4000);
    for (const chunk of chunks) {
      await bot.sendMessage(chatId, chunk);
    }
    await sendMd(bot, chatId, `🎲 *تم توليد 100 سؤال جديدة\\!*`, {
      reply_markup: { inline_keyboard: [
        [{ text: "🎲 100 سؤال جديد", callback_data: `questions_new:${epId}` }],
        [{ text: "◀️ رجوع للحلقة",   callback_data: `ep:${epId}` }],
        homeRow(),
      ]},
    });
  });
}

// ─── SUB-MENU HANDLERS (NEW) ──────────────────────────────────────────────────

async function showEpAiMenu(bot: TelegramBot, chatId: number, msgId: number, epId: number): Promise<void> {
  const ep = await db.select({ title: episodesTable.title, transcript: episodesTable.transcript })
    .from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;

  const hasTranscript = Boolean(ep[0].transcript);
  await editMd(bot, chatId, msgId,
    [
      `🤖 *AI مساعد*`,
      `════════════════════`,
      `🎙 _${esc(trunc(ep[0].title, 34))}_`,
      DIV_SM,
      hasTranscript ? `✅ النص المفرَّغ متاح` : `💡 يمكنك تفريغ الحلقة أولاً للحصول على نتائج أفضل`,
    ].join("\n"),
    { reply_markup: { inline_keyboard: aiMenu(epId, hasTranscript) } } as any
  );
}

async function showEpManageMenu(bot: TelegramBot, chatId: number, msgId: number, epId: number): Promise<void> {
  const ep = await db.select({ title: episodesTable.title }).from(episodesTable)
    .where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;

  await editMd(bot, chatId, msgId,
    [
      `⚙️ *إدارة الحلقة*`,
      `════════════════════`,
      `🎙 _${esc(trunc(ep[0].title, 34))}_`,
    ].join("\n"),
    { reply_markup: { inline_keyboard: manageMenu(epId) } } as any
  );
}

async function showEpSleepMenu(bot: TelegramBot, chatId: number, msgId: number, epId: number): Promise<void> {
  const ep = await db.select({ title: episodesTable.title }).from(episodesTable)
    .where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;

  await editMd(bot, chatId, msgId,
    [
      `⏱ *مؤقت النوم*`,
      `════════════════════`,
      `اختر المدة التي تريد الاستماع فيها:`,
    ].join("\n"),
    { reply_markup: { inline_keyboard: sleepTimerMenu(epId) } } as any
  );
}

async function handleEpBookmark(
  bot: TelegramBot, chatId: number, _msgId: number, epId: number
): Promise<void> {
  const ep = await db.select({ title: episodesTable.title }).from(episodesTable)
    .where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;

  const exists = await db.select({ id: bookmarksTable.id }).from(bookmarksTable)
    .where(and(eq(bookmarksTable.chatId, String(chatId)), eq(bookmarksTable.episodeId, epId)))
    .limit(1);

  if (exists[0]) {
    await db.delete(bookmarksTable)
      .where(and(eq(bookmarksTable.chatId, String(chatId)), eq(bookmarksTable.episodeId, epId)));
    await sendMd(bot, chatId, `🔖 *إزالة الإشارة*\n${DIV}\n_تم إزالة الإشارة من "${esc(trunc(ep[0].title, 28))}"_`, {
      reply_markup: { inline_keyboard: [[{ text: "◀️ رجوع", callback_data: `ep:manage:${epId}` }]] },
    });
  } else {
    await db.insert(bookmarksTable).values({
      chatId: String(chatId), episodeId: epId,
    }).onConflictDoNothing();
    await sendMd(bot, chatId, `🔖 *تمت الإشارة\\!*\n${DIV}\n_"${esc(trunc(ep[0].title, 28))}" في إشاراتك المرجعية_`, {
      reply_markup: { inline_keyboard: [[{ text: "◀️ رجوع", callback_data: `ep:manage:${epId}` }]] },
    });
  }
}

async function handleEpTranslate(bot: TelegramBot, chatId: number, epId: number): Promise<void> {
  if (!hasGroqKey()) { await sendMd(bot, chatId, `⚠️ _GROQ_API_KEY غير مهيأ_`); return; }

  const ep = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;

  const content = ep[0].transcript ?? ep[0].description ?? ep[0].title;

  await withSpinner(bot, chatId, "🌍 جاري الترجمة", async () => {
    const { translateText } = await import("./ai.js");
    const translated = await translateText(content.slice(0, 1500));

    const lines = [
      `🌍 *ترجمة الحلقة*`,
      DIV,
      `🎙 _${esc(trunc(ep[0].title, 30))}_`,
      DIV_SM,
      esc(trunc(translated, 800)),
    ];
    await sendMd(bot, chatId, lines.join("\n"), {
      reply_markup: { inline_keyboard: [[{ text: "◀️ رجوع للحلقة", callback_data: `ep:${epId}` }]] },
    });
  });
}

async function handleEpQuote(bot: TelegramBot, chatId: number, epId: number): Promise<void> {
  if (!hasGroqKey()) { await sendMd(bot, chatId, `⚠️ _GROQ_API_KEY غير مهيأ_`); return; }

  const ep = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;

  const feed = await db.select({ title: feedsTable.title }).from(feedsTable)
    .where(eq(feedsTable.id, ep[0].feedId)).limit(1);

  const content = ep[0].transcript ?? ep[0].description ?? "";
  if (!content.trim()) {
    await sendMd(bot, chatId, softError("لا يوجد محتوى", "قم بتفريغ الحلقة أولاً\\."));
    return;
  }

  await withSpinner(bot, chatId, "💡 استخراج الاقتباس", async () => {
    const { extractBestQuote } = await import("./ai.js");
    const quote = await extractBestQuote(content.slice(0, 3000), ep[0].title);
    const card  = quoteCard(quote, ep[0].title, feed[0]?.title);

    await sendMd(bot, chatId, card, {
      reply_markup: { inline_keyboard: [
        [{ text: "🔄 اقتباس آخر",   callback_data: `ep:quote:${epId}` }],
        [{ text: "◀️ رجوع للحلقة", callback_data: `ep:${epId}` }],
      ]},
    });
  });
}

async function handleEpAnalytics(
  bot: TelegramBot, chatId: number, msgId: number, epId: number
): Promise<void> {
  const ep = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;

  const wordCount = ep[0].transcript
    ? ep[0].transcript.split(/\s+/).filter(Boolean).length
    : null;

  const card = analyticsCard({
    title: ep[0].title,
    duration: ep[0].duration,
    pubDate: ep[0].pubDate,
    wordCount: wordCount ?? undefined,
  });

  await editMd(bot, chatId, msgId, card,
    { reply_markup: { inline_keyboard: [[{ text: "◀️ رجوع", callback_data: `ep:manage:${epId}` }]] } } as any
  );
}

// ─── NEW COMMANDS ──────────────────────────────────────────────────────────────

async function cmdRandom(bot: TelegramBot, chatId: number): Promise<void> {
  const feeds = await db.select({ id: feedsTable.id }).from(feedsTable)
    .where(eq(feedsTable.chatId, String(chatId)));

  if (!feeds.length) {
    await sendMd(bot, chatId, softError("لا توجد بودكاستات", "أضف بودكاست أولاً بـ /add"));
    return;
  }

  const feedIds = feeds.map((f) => f.id);
  const eps = await db.select().from(episodesTable)
    .where(and(
      inArray(episodesTable.feedId, feedIds),
      sql`${episodesTable.listened} IS NULL OR ${episodesTable.listened} = false`
    ))
    .orderBy(sql`RANDOM()`)
    .limit(1);

  if (!eps[0]) {
    await sendMd(bot, chatId, softError("لا توجد حلقات غير مسموعة", "جرّب تحديث بودكاستاتك\\."));
    return;
  }

  const feed = await db.select({ title: feedsTable.title }).from(feedsTable)
    .where(eq(feedsTable.id, eps[0].feedId)).limit(1);

  await sendMd(bot, chatId,
    [`🎲 *حلقة عشوائية*`, DIV, episodeCard({ ...eps[0], feedTitle: feed[0]?.title })].join("\n"),
    { reply_markup: { inline_keyboard: episodeActions(eps[0].id, { isPlayed: eps[0].listened ?? false }) } }
  );
}

async function cmdDigest(bot: TelegramBot, chatId: number): Promise<void> {
  const feeds = await db.select({ id: feedsTable.id }).from(feedsTable)
    .where(eq(feedsTable.chatId, String(chatId)));

  if (!feeds.length) {
    await sendMd(bot, chatId, softError("لا توجد اشتراكات", "أضف بودكاست بـ /add"));
    return;
  }

  const feedIds = feeds.map((f) => f.id);
  const since   = new Date(Date.now() - 7 * 24 * 3600 * 1000);

  const eps = await db.select({
    id: episodesTable.id,
    title: episodesTable.title,
    duration: episodesTable.duration,
    feedId: episodesTable.feedId,
  })
    .from(episodesTable)
    .where(and(
      inArray(episodesTable.feedId, feedIds),
      gt(episodesTable.pubDate, since),
    ))
    .orderBy(desc(episodesTable.pubDate))
    .limit(10);

  if (!eps.length) {
    await sendMd(bot, chatId, [`🌅 *الملخص الأسبوعي*`, DIV, `لا توجد حلقات جديدة هذا الأسبوع\\.`].join("\n"), {
      reply_markup: { inline_keyboard: [homeRow()] },
    });
    return;
  }

  const feedMap: Record<number, string> = {};
  for (const f of feeds) {
    const fd = await db.select({ id: feedsTable.id, title: feedsTable.title }).from(feedsTable)
      .where(eq(feedsTable.id, f.id)).limit(1);
    if (fd[0]) feedMap[fd[0].id] = fd[0].title;
  }

  const items = eps.map((e) => ({
    title: e.title, feedTitle: feedMap[e.feedId] ?? null, duration: e.duration,
  }));

  const msg = digestMsg(items);
  const kb = eps.slice(0, 5).map((e) => [{ text: `▶️ ${trunc(e.title, 24)}`, callback_data: `ep:${e.id}` }]);
  kb.push(homeRow());

  await sendMd(bot, chatId, msg, { reply_markup: { inline_keyboard: kb } });
}

async function cmdRecommend(bot: TelegramBot, chatId: number): Promise<void> {
  if (!hasGroqKey()) { await sendMd(bot, chatId, `⚠️ _AI not configured \\(GROQ\\_API\\_KEY missing\\)_`); return; }

  const history = await db.select({ title: episodesTable.title })
    .from(episodesTable)
    .where(and(
      eq(episodesTable.listened, true),
      sql`${episodesTable.feedId} IN (SELECT id FROM feeds WHERE chat_id = ${String(chatId)})`
    ))
    .orderBy(desc(episodesTable.updatedAt))
    .limit(10);

  if (!history.length) {
    await sendMd(bot, chatId, softError("No listening history yet", "Listen to a few episodes first\\."));
    return;
  }

  await withSpinner(bot, chatId, "Generating AI recommendations", async () => {
    const titles  = history.map((e) => e.title);
    const recsArr = await getRecommendations(titles, "en");
    const recs = recsArr.length
      ? [`🎯 *Recommended for You*`, DIV, ...recsArr.map((r, i) => `${i + 1}\\. ${esc(r)}`)].join("\n")
      : `🎯 _No recommendations available right now\\._`;
    await sendMd(bot, chatId, recs);
    await sendMd(bot, chatId, doneMsg("Recommendations ready!"), {
      reply_markup: { inline_keyboard: [[{ text: "🌍 Discover More", callback_data: "cmd:browse" }], homeRow()] },
    });
  });
}

// ─── NEW COMMAND HANDLERS ──────────────────────────────────────────────────────

async function cmdStreak(bot: TelegramBot, chatId: number): Promise<void> {
  const eps = await db.select({ updatedAt: episodesTable.updatedAt })
    .from(episodesTable)
    .where(and(
      eq(episodesTable.listened, true),
      sql`${episodesTable.feedId} IN (SELECT id FROM feeds WHERE chat_id = ${String(chatId)})`
    ))
    .orderBy(desc(episodesTable.updatedAt));

  if (!eps.length) {
    await sendMd(bot, chatId, softError("No streak yet", "Listen to your first episode to start\\!"));
    return;
  }

  // Calculate streak: consecutive days
  const days = new Set(eps.map((e) => new Date(e.updatedAt ?? new Date()).toDateString()));
  const sortedDays = Array.from(days).map((d) => new Date(d)).sort((a, b) => b.getTime() - a.getTime());
  let streak = 0;
  let check  = new Date(); check.setHours(0,0,0,0);
  for (const d of sortedDays) {
    const diff = Math.round((check.getTime() - d.getTime()) / 86400000);
    if (diff <= 1) { streak++; check = d; check.setHours(0,0,0,0); } else break;
  }

  await sendMd(bot, chatId, streakMsg(streak, days.size), {
    reply_markup: { inline_keyboard: [homeRow()] },
  });
}

async function cmdHistory(bot: TelegramBot, chatId: number): Promise<void> {
  const eps = await db.select({
    title: episodesTable.title,
    feedId: episodesTable.feedId,
    updatedAt: episodesTable.updatedAt,
  })
    .from(episodesTable)
    .where(and(
      eq(episodesTable.listened, true),
      sql`${episodesTable.feedId} IN (SELECT id FROM feeds WHERE chat_id = ${String(chatId)})`
    ))
    .orderBy(desc(episodesTable.updatedAt))
    .limit(20);

  const feedIds = [...new Set(eps.map((e) => e.feedId))];
  const feeds   = feedIds.length ? await db.select({ id: feedsTable.id, title: feedsTable.title })
    .from(feedsTable).where(inArray(feedsTable.id, feedIds)) : [];
  const feedMap: Record<number, string> = {};
  for (const f of feeds) feedMap[f.id] = f.title;

  const items = eps.map((e) => ({
    title: e.title, feedTitle: feedMap[e.feedId] ?? null, listenedAt: e.updatedAt,
  }));

  await sendMd(bot, chatId, historyMsg(items), { reply_markup: { inline_keyboard: [homeRow()] } });
}

async function cmdRecent(bot: TelegramBot, chatId: number): Promise<void> {
  const feeds = await db.select({ id: feedsTable.id }).from(feedsTable)
    .where(eq(feedsTable.chatId, String(chatId)));
  if (!feeds.length) { await sendMd(bot, chatId, softError("No podcasts yet", "Add one with /add")); return; }
  const feedIds = feeds.map((f) => f.id);

  const eps = await db.select().from(episodesTable)
    .where(and(inArray(episodesTable.feedId, feedIds), eq(episodesTable.listened, true)))
    .orderBy(desc(episodesTable.updatedAt))
    .limit(5);

  if (!eps.length) { await sendMd(bot, chatId, softError("Nothing recently played", "Start listening\\!")); return; }

  const kb: TelegramBot.InlineKeyboardButton[][] = eps.map((e) => [
    { text: `▶️ ${trunc(e.title, 26)}`, callback_data: `ep:${e.id}` },
  ]);
  kb.push(homeRow());

  await sendMd(bot, chatId,
    [`*${V.logo}*`, V.dbl, `*RECENTLY PLAYED*`, V.wave, eps.map((e, i) => `*${i+1}\\.* ${esc(trunc(e.title, 30))}`).join("\n")].join("\n"),
    { reply_markup: { inline_keyboard: kb } }
  );
}

async function cmdPopular(bot: TelegramBot, chatId: number): Promise<void> {
  const feeds = await db.select({ id: feedsTable.id }).from(feedsTable)
    .where(eq(feedsTable.chatId, String(chatId)));
  if (!feeds.length) { await sendMd(bot, chatId, softError("No podcasts yet", "Add one with /add")); return; }

  const feedIds = feeds.map((f) => f.id);
  const eps = await db.select({
    id: episodesTable.id, title: episodesTable.title, progress: episodesTable.progress,
  })
    .from(episodesTable)
    .where(and(inArray(episodesTable.feedId, feedIds), gt(episodesTable.progress, 0)))
    .orderBy(desc(episodesTable.progress))
    .limit(5);

  if (!eps.length) { await sendMd(bot, chatId, softError("No play data yet", "Start listening\\!")); return; }

  const kb: TelegramBot.InlineKeyboardButton[][] = eps.map((e) => [
    { text: `▶️ ${trunc(e.title, 26)}`, callback_data: `ep:${e.id}` },
  ]);
  kb.push(homeRow());

  await sendMd(bot, chatId,
    [`*${V.logo}*`, V.dbl, `*MOST PLAYED*`, V.wave,
     eps.map((e, i) => `*${i+1}\\.* ${esc(trunc(e.title, 30))} \\— ${Math.round((e.progress??0)*100)}%`).join("\n")
    ].join("\n"),
    { reply_markup: { inline_keyboard: kb } }
  );
}

async function cmdNewEpisodes(bot: TelegramBot, chatId: number): Promise<void> {
  const feeds = await db.select({ id: feedsTable.id }).from(feedsTable)
    .where(eq(feedsTable.chatId, String(chatId)));
  if (!feeds.length) { await sendMd(bot, chatId, softError("No podcasts yet", "Add one with /add")); return; }

  const feedIds = feeds.map((f) => f.id);
  const since   = new Date(Date.now() - 48 * 3600 * 1000);

  const eps = await db.select().from(episodesTable)
    .where(and(inArray(episodesTable.feedId, feedIds), gt(episodesTable.pubDate, since)))
    .orderBy(desc(episodesTable.pubDate))
    .limit(10);

  if (!eps.length) {
    await sendMd(bot, chatId, [`*${V.logo}*`, V.dbl, `*NEW EPISODES*`, V.wave, `_No new episodes in the last 48 hours_`].join("\n"), {
      reply_markup: { inline_keyboard: [homeRow()] },
    });
    return;
  }

  const kb: TelegramBot.InlineKeyboardButton[][] = eps.slice(0, 5).map((e) => [
    { text: `▶️ ${trunc(e.title, 26)}`, callback_data: `ep:${e.id}` },
  ]);
  kb.push(homeRow());

  await sendMd(bot, chatId,
    [`*${V.logo}*`, V.dbl, `*NEW \\(LAST 48H\\)*`, V.wave,
     eps.map((e, i) => `*${i+1}\\.* ${esc(trunc(e.title, 30))}`).join("\n")
    ].join("\n"),
    { reply_markup: { inline_keyboard: kb } }
  );
}

async function cmdExport(bot: TelegramBot, chatId: number): Promise<void> {
  await sendMd(bot, chatId,
    [`*${V.logo}*`, V.dbl, `*EXPORT LIBRARY*`, V.wave, `Choose your export format:`].join("\n"),
    { reply_markup: { inline_keyboard: exportFormatKb() } }
  );
}

async function handleExportOpml(bot: TelegramBot, chatId: number): Promise<void> {
  const feeds = await db.select().from(feedsTable).where(eq(feedsTable.chatId, String(chatId)));
  if (!feeds.length) { await sendMd(bot, chatId, softError("Nothing to export", "Subscribe to podcasts first\\.")); return; }

  const opml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<opml version="1.0">`,
    `  <head><title>iCast Library</title></head>`,
    `  <body>`,
    ...feeds.map((f) => `    <outline type="rss" text="${f.title.replace(/"/g,'&quot;')}" xmlUrl="${f.url}"/>`),
    `  </body>`,
    `</opml>`,
  ].join("\n");

  const buf  = Buffer.from(opml, "utf-8");
  await bot.sendDocument(chatId, buf, {
    caption: exportReadyMsg("OPML", feeds.length),
    parse_mode: "MarkdownV2",
  }, { filename: "icast-library.opml", contentType: "text/xml" });
}

async function handleExportJson(bot: TelegramBot, chatId: number): Promise<void> {
  const feeds = await db.select().from(feedsTable).where(eq(feedsTable.chatId, String(chatId)));
  if (!feeds.length) { await sendMd(bot, chatId, softError("Nothing to export", "Subscribe to podcasts first\\.")); return; }

  const data = feeds.map((f) => ({ title: f.title, url: f.url, author: f.author }));
  const buf  = Buffer.from(JSON.stringify(data, null, 2), "utf-8");
  await bot.sendDocument(chatId, buf, {
    caption: exportReadyMsg("JSON", feeds.length),
    parse_mode: "MarkdownV2",
  }, { filename: "icast-library.json", contentType: "application/json" });
}

async function cmdMentions(bot: TelegramBot, chatId: number, keyword: string): Promise<void> {
  if (!keyword) {
    await sendMd(bot, chatId, `🔍 *Transcript Search*\n${DIV}\nUsage: /mentions \\<keyword\\>`);
    return;
  }
  const feeds = await db.select({ id: feedsTable.id }).from(feedsTable)
    .where(eq(feedsTable.chatId, String(chatId)));
  if (!feeds.length) { await sendMd(bot, chatId, softError("No podcasts yet", "Add one with /add")); return; }

  const feedIds = feeds.map((f) => f.id);
  const eps = await db.select({ id: episodesTable.id, title: episodesTable.title, transcript: episodesTable.transcript, feedId: episodesTable.feedId })
    .from(episodesTable)
    .where(and(inArray(episodesTable.feedId, feedIds), isNotNull(episodesTable.transcript)))
    .limit(50);

  const kw  = keyword.toLowerCase();
  const hits = eps
    .filter((e) => e.transcript?.toLowerCase().includes(kw))
    .map((e) => {
      const idx     = e.transcript!.toLowerCase().indexOf(kw);
      const snippet = e.transcript!.slice(Math.max(0, idx - 40), idx + 80).replace(/\n/g, " ").trim();
      return { id: e.id, title: e.title, feedTitle: null as string | null, snippet };
    })
    .slice(0, 6);

  const msg = mentionsMsg(keyword, hits);
  const kb: TelegramBot.InlineKeyboardButton[][] = hits.map((h) => [
    { text: `▶️ ${trunc(h.title, 28)}`, callback_data: `ep:${h.id}` },
  ]);
  kb.push(homeRow());

  await sendMd(bot, chatId, msg, { reply_markup: { inline_keyboard: kb } });
}

async function cmdGoal(bot: TelegramBot, chatId: number, setMins?: number): Promise<void> {
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const eps   = await db.select({ duration: episodesTable.duration })
    .from(episodesTable)
    .where(and(
      eq(episodesTable.listened, true),
      gt(episodesTable.updatedAt, since),
      sql`${episodesTable.feedId} IN (SELECT id FROM feeds WHERE chat_id = ${String(chatId)})`
    ));
  const mins = eps.reduce((acc, e) => acc + Math.round(parseDuration(e.duration) / 60), 0);
  const goal  = setMins && setMins > 0 ? setMins : 120;
  await sendMd(bot, chatId, goalMsg(goal, mins), { reply_markup: { inline_keyboard: [homeRow()] } });
}

async function cmdNow(bot: TelegramBot, chatId: number): Promise<void> {
  const feeds = await db.select({ id: feedsTable.id }).from(feedsTable)
    .where(eq(feedsTable.chatId, String(chatId)));
  if (!feeds.length) { await sendMd(bot, chatId, softError("No podcasts yet", "Add one with /add")); return; }
  const feedIds = feeds.map((f) => f.id);

  // Find episode with highest progress that's not complete
  const eps = await db.select().from(episodesTable)
    .where(and(
      inArray(episodesTable.feedId, feedIds),
      eq(episodesTable.listened, false),
      gt(episodesTable.progress, 0),
    ))
    .orderBy(desc(episodesTable.progress))
    .limit(1);

  if (!eps[0]) {
    // Fall back to last listened
    const last = await db.select().from(episodesTable)
      .where(and(inArray(episodesTable.feedId, feedIds), eq(episodesTable.listened, true)))
      .orderBy(desc(episodesTable.updatedAt)).limit(1);
    if (!last[0]) { await sendMd(bot, chatId, softError("Nothing playing", "Browse /latest to start\\!")); return; }
    await showEpisodeDetail(bot, chatId, 0, last[0].id);
    return;
  }

  await showEpisodeDetail(bot, chatId, 0, eps[0].id);
}

async function cmdCompareStart(bot: TelegramBot, chatId: number, epId?: number): Promise<void> {
  if (!hasGroqKey()) { await sendMd(bot, chatId, `⚠️ _AI not configured_`); return; }
  if (!epId) {
    await sendMd(bot, chatId, `🆚 *Compare Episodes*\n${DIV}\nUsage: /compare \\<episode\\_id\\>\n\n_First browse /latest to find an episode ID_`);
    return;
  }
  const ep = await db.select({ title: episodesTable.title, feedId: episodesTable.feedId }).from(episodesTable)
    .where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) { await sendMd(bot, chatId, softError("Episode not found", "")); return; }

  const others = await db.select({ id: episodesTable.id, title: episodesTable.title })
    .from(episodesTable)
    .where(and(eq(episodesTable.feedId, ep[0].feedId), sql`${episodesTable.id} != ${epId}`))
    .orderBy(desc(episodesTable.pubDate))
    .limit(5);

  if (!others.length) { await sendMd(bot, chatId, softError("Not enough episodes to compare", "Add more episodes first\\.")); return; }

  const { compareStartKb } = await import("./keyboards.js");
  await sendMd(bot, chatId,
    `🆚 *Compare* _${esc(trunc(ep[0].title, 28))}_ *with:*`,
    { reply_markup: { inline_keyboard: compareStartKb(epId, others) } }
  );
}

async function handleEpCompare(bot: TelegramBot, chatId: number, ep1Id: number, ep2Id: number): Promise<void> {
  if (!hasGroqKey()) { await sendMd(bot, chatId, `⚠️ _AI not configured_`); return; }

  const [ep1, ep2] = await Promise.all([
    db.select().from(episodesTable).where(eq(episodesTable.id, ep1Id)).limit(1),
    db.select().from(episodesTable).where(eq(episodesTable.id, ep2Id)).limit(1),
  ]);
  if (!ep1[0] || !ep2[0]) { await sendMd(bot, chatId, softError("Episode not found", "")); return; }

  const t1 = ep1[0].transcript ?? ep1[0].description ?? ep1[0].title;
  const t2 = ep2[0].transcript ?? ep2[0].description ?? ep2[0].title;

  await withSpinner(bot, chatId, "Comparing episodes with AI", async () => {
    const groq = (await import("./ai.js")).getGroq ? null : null;
    const { summarizeText } = await import("./ai.js");
    const s1 = await summarizeText(t1.slice(0, 2000));
    const s2 = await summarizeText(t2.slice(0, 2000));

    const comparison = [
      `🆚 *Episode Comparison*`,
      V.dbl,
      `*A:* ${esc(trunc(ep1[0].title, 34))}`,
      `_${esc(trunc(s1, 200))}_`,
      ``,
      V.thin,
      ``,
      `*B:* ${esc(trunc(ep2[0].title, 34))}`,
      `_${esc(trunc(s2, 200))}_`,
    ].join("\n");
    await sendMd(bot, chatId, comparison, {
      reply_markup: { inline_keyboard: [
        [{ text: "▶️ Play A", callback_data: `ep:${ep1Id}` }, { text: "▶️ Play B", callback_data: `ep:${ep2Id}` }],
        homeRow(),
      ]},
    });
  });
}

async function showEpRemindMenu(bot: TelegramBot, chatId: number, msgId: number, epId: number): Promise<void> {
  const ep = await db.select({ title: episodesTable.title }).from(episodesTable)
    .where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;

  await editMd(bot, chatId, msgId,
    [`⏰ *Set a Reminder*`, V.dbl, `🎙 _${esc(trunc(ep[0].title, 34))}_`, ``, `When should I remind you?`].join("\n"),
    { reply_markup: { inline_keyboard: remindMenu(epId) } } as any
  );
}

async function handleEpRemind(
  bot: TelegramBot, chatId: number, queryId: string, epId: number, mins: number
): Promise<void> {
  const ep = await db.select({ title: episodesTable.title }).from(episodesTable)
    .where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;

  await bot.answerCallbackQuery(queryId, { text: `⏰ Reminder set for ${mins} minutes` });
  await sendMd(bot, chatId, reminderMsg(ep[0].title, mins), {
    reply_markup: { inline_keyboard: [[{ text: "◀️ Back", callback_data: `ep:${epId}` }]] },
  });

  setTimeout(async () => {
    await sendMd(bot, chatId, reminderDueMsg(ep[0].title), {
      reply_markup: { inline_keyboard: [[{ text: "▶️ Play Now", callback_data: `ep:${epId}` }], homeRow()] },
    }).catch(() => {});
  }, mins * 60 * 1000);
}

async function handleEpSkip(
  bot: TelegramBot, chatId: number, msgId: number, epId: number
): Promise<void> {
  const ep = await db.select({ title: episodesTable.title }).from(episodesTable)
    .where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;

  await db.update(episodesTable).set({ listened: true, progress: 0, updatedAt: new Date() })
    .where(eq(episodesTable.id, epId));

  await editMd(bot, chatId, msgId,
    `⏩ *Episode Skipped*\n${DIV}\n_"${esc(trunc(ep[0].title, 30))}" marked as skipped_`,
    { reply_markup: { inline_keyboard: [homeRow()] } } as any
  );
}

async function showFeedNotifMenu(bot: TelegramBot, chatId: number, msgId: number, feedId: number): Promise<void> {
  const feed = await db.select({ title: feedsTable.title }).from(feedsTable)
    .where(eq(feedsTable.id, feedId)).limit(1);
  if (!feed[0]) return;

  await editMd(bot, chatId, msgId,
    [`🔔 *Notification Settings*`, V.dbl, `📻 _${esc(trunc(feed[0].title, 32))}_`, ``, `Choose notification preference:`].join("\n"),
    { reply_markup: { inline_keyboard: feedNotifMenu(feedId, "all") } } as any
  );
}

async function handleSetFeedNotif(
  bot: TelegramBot, chatId: number, msgId: number, feedId: number, setting: string
): Promise<void> {
  await bot.editMessageReplyMarkup(
    { inline_keyboard: feedNotifMenu(feedId, setting) },
    { chat_id: chatId, message_id: msgId }
  ).catch(() => {});
  await bot.answerCallbackQuery("", { text: `Notifications: ${setting === "all" ? "All episodes" : "Silent"}` }).catch(() => {});
}

// ─── ADMIN SETUP ───────────────────────────────────────────────────────────────

async function handleAdminSetup(bot: TelegramBot, chatId: number, input: string): Promise<void> {
  const superAdminId  = process.env.SUPERADMIN_CHAT_ID?.trim();
  const adminSecret   = process.env.ADMIN_SECRET?.trim();

  // If SUPERADMIN_CHAT_ID matches this chat — auto-promote
  if (superAdminId && String(chatId) === superAdminId) {
    await db.update(usersTable)
      .set({ role: "superadmin" })
      .where(eq(usersTable.chatId, String(chatId)));
    await sendMd(bot, chatId,
      [`🛡 *Superadmin Access Granted*`, V.dbl, `Your account has been promoted to *Superadmin*\\.`, ``, `Use /admin to open the admin panel\\.`].join("\n"),
      { reply_markup: { keyboard: ADMIN_KEYBOARD, resize_keyboard: true } }
    );
    return;
  }

  // Secret-based promotion
  if (!adminSecret) {
    await sendMd(bot, chatId,
      [`🛡 *Admin Setup*`, V.dbl, `To set up admin access, configure one of these:`, ``, `${V.dot} Set SUPERADMIN\\_CHAT\\_ID env var to your chat ID \\(*${esc(String(chatId))}*\\)`, `${V.dot} Set ADMIN\\_SECRET env var and use /adminsetup \\<secret\\>`].join("\n")
    );
    return;
  }

  if (!input || input !== adminSecret) {
    await sendMd(bot, chatId, `❌ *Incorrect secret*\n${DIV}\n_Usage: /adminsetup \\<secret\\>_`);
    return;
  }

  await db.update(usersTable)
    .set({ role: "admin" })
    .where(eq(usersTable.chatId, String(chatId)));
  await sendMd(bot, chatId,
    [`🛡 *Admin Access Granted*`, V.dbl, `Your account has been promoted to *Admin*\\.`, ``, `Use /admin to open the admin panel\\.`].join("\n"),
    { reply_markup: { keyboard: ADMIN_KEYBOARD, resize_keyboard: true } }
  );
}

