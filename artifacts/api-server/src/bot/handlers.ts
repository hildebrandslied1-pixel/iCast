import TelegramBot from "node-telegram-bot-api";
import { db, feedsTable, episodesTable, favoritesTable, queueTable, tagsTable, episodeTagsTable } from "@workspace/db";
import { eq, and, desc, like, count, sql } from "drizzle-orm";
import { fetchFeed } from "./rss.js";
import {
  fetchTopCharts, searchPodcasts, resolveRssFeed,
  getCountriesPage, totalCountryPages, findCountry,
  podcastCache, getCachedPodcast,
} from "./discover.js";
import { generateTranscriptPdf } from "./pdf.js";
import { transcribeEpisodeFull, generateSummary, generateDetailedExplanation, hasWhisperKey, hasDeepseekKey } from "./ai.js";
import { sendEpisodeAudio } from "./downloader.js";
import {
  fmt, divider, shortDivider, truncate, episodeCard, feedCard,
  formatDate, parseDuration, formatDuration, progressBar,
} from "./formatter.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const PAGE_SIZE  = 5;
const CHART_PAGE = 10;

// ─── Persistent Reply Keyboard (Telegram "control panel") ────────────────────

const CONTROL_PANEL: TelegramBot.ReplyKeyboardMarkup = {
  keyboard: [
    [{ text: "📻 Feeds" },     { text: "🆕 Latest" },    { text: "🌍 Trending" }],
    [{ text: "🌐 Browse" },    { text: "❤️ Favourites" }, { text: "⏭ Queue" }],
    [{ text: "🏷 Tags" },      { text: "📊 Stats" },      { text: "🔄 Refresh" }],
    [{ text: "➕ Add RSS" },   { text: "🔎 Search" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

// Maps button label → handler name
const PANEL_BUTTONS: Record<string, string> = {
  "📻 Feeds":       "feeds",
  "🆕 Latest":      "latest",
  "🌍 Trending":    "trending",
  "🌐 Browse":      "browse",
  "❤️ Favourites":  "favourites",
  "⏭ Queue":        "queue",
  "🏷 Tags":        "tags",
  "📊 Stats":       "stats",
  "🔄 Refresh":     "refresh",
  "➕ Add RSS":     "add",
  "🔎 Search":      "search",
};

// ─── Session ──────────────────────────────────────────────────────────────────

type SessionAction =
  | "awaiting_rss"
  | "awaiting_search"
  | "awaiting_browse"
  | "awaiting_country_code"
  | "awaiting_tag_name"
  | "awaiting_tag_ep";       // adding episode to tag — stores epId in extra

interface Session {
  action?: SessionAction;
  extra?: number;            // e.g. epId when awaiting_tag_ep
}

const sessions = new Map<number, Session>();
const getSession = (id: number): Session => { if (!sessions.has(id)) sessions.set(id, {}); return sessions.get(id)!; };
const clearSession = (id: number): void => { sessions.set(id, {}); };

// ─── Helpers ──────────────────────────────────────────────────────────────────

type Opts = TelegramBot.SendMessageOptions;

const sendMd = (bot: TelegramBot, chatId: number, text: string, opts?: Opts) =>
  bot.sendMessage(chatId, text, { parse_mode: "Markdown", ...opts });

const editMd = (
  bot: TelegramBot, chatId: number, msgId: number, text: string,
  keyboard?: TelegramBot.InlineKeyboardMarkup,
) =>
  bot.editMessageText(text, {
    chat_id: chatId, message_id: msgId,
    parse_mode: "Markdown", reply_markup: keyboard,
    disable_web_page_preview: true,
  });

const HOME_BTN = { text: "🏠 Home", callback_data: "menu" } as const;
type IKBRow    = { text: string; callback_data: string }[];
const homeRow  = (): IKBRow => [HOME_BTN];

// ─── REGISTER ────────────────────────────────────────────────────────────────

export function registerHandlers(bot: TelegramBot): void {

  // ── Slash commands ──────────────────────────────────────────────────────
  bot.onText(/\/start/, (msg) => { void sendMenu(bot, msg.chat.id); });
  bot.onText(/\/help/,  (msg) => { void sendMenu(bot, msg.chat.id); });
  bot.onText(/\/menu/,  (msg) => { void sendMenu(bot, msg.chat.id); });

  for (const [cmd, handler] of [
    [/\/feeds/,      "feeds"],
    [/\/latest/,     "latest"],
    [/\/queue/,      "queue"],
    [/\/favourites/, "favourites"],
    [/\/favorites/,  "favourites"],
    [/\/tags/,       "tags"],
    [/\/stats/,      "stats"],
    [/\/refresh/,    "refresh"],
  ] as [RegExp, string][]) {
    bot.onText(cmd, (msg) => { void routeCommand(bot, msg.chat.id, handler); });
  }

  bot.onText(/\/trending/, (msg) => { void showCountryPicker(bot, msg.chat.id, 0); });

  bot.onText(/\/add/, (msg) => {
    getSession(msg.chat.id).action = "awaiting_rss";
    void sendMd(bot, msg.chat.id, fmt([
      "📡 *Add a Podcast*", divider(),
      "Send the RSS or Atom feed URL:",
      "_Example: https://feeds.example.com/podcast.xml_",
    ]), { reply_markup: { inline_keyboard: [homeRow()] } });
  });

  bot.onText(/\/search/, (msg) => {
    getSession(msg.chat.id).action = "awaiting_search";
    void sendMd(bot, msg.chat.id, fmt([
      "🔎 *Search Your Episodes*", divider(), "Enter a keyword:",
    ]), { reply_markup: { inline_keyboard: [homeRow()] } });
  });

  bot.onText(/\/browse/, (msg) => {
    getSession(msg.chat.id).action = "awaiting_browse";
    void sendMd(bot, msg.chat.id, fmt([
      "🌐 *Browse iTunes*", divider(), "Enter a show name or topic:",
    ]), { reply_markup: { inline_keyboard: [homeRow()] } });
  });

  // ── Text messages ───────────────────────────────────────────────────────
  bot.on("message", (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;
    const chatId = msg.chat.id;
    const text   = msg.text.trim();
    const sess   = getSession(chatId);

    // Panel button press
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
        else void sendMd(bot, chatId, "❌ Please enter a valid 2-letter code (e.g. `us`, `sa`, `de`).");
        break;
      }
      case "awaiting_tag_name":
        clearSession(chatId);
        void createTag(bot, chatId, text.slice(0, 50));
        break;
      default:
        if (text.startsWith("http")) void handleAddRss(bot, chatId, text);
        else void sendMenu(bot, chatId);
    }
  });

  // ── Callback queries ────────────────────────────────────────────────────
  bot.on("callback_query", (query) => {
    if (!query.message || !query.data) return;
    const chatId = query.message.chat.id;
    const msgId  = query.message.message_id;
    void bot.answerCallbackQuery(query.id);
    void routeCallback(bot, chatId, msgId, query.data);
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
    case "trending":
      await showCountryPicker(bot, chatId, 0);
      break;
    case "add":
      getSession(chatId).action = "awaiting_rss";
      await sendMd(bot, chatId, fmt([
        "📡 *Add a Podcast*", divider(), "Send the RSS or Atom feed URL:",
      ]), { reply_markup: { inline_keyboard: [homeRow()] } });
      break;
    case "search":
      getSession(chatId).action = "awaiting_search";
      await sendMd(bot, chatId, fmt([
        "🔎 *Search Episodes*", divider(), "Enter a keyword:",
      ]), { reply_markup: { inline_keyboard: [homeRow()] } });
      break;
    case "browse":
      getSession(chatId).action = "awaiting_browse";
      await sendMd(bot, chatId, fmt([
        "🌐 *Browse iTunes*", divider(), "Enter a show name or topic:",
        "_Examples: science · comedy · tech_",
      ]), { reply_markup: { inline_keyboard: [homeRow()] } });
      break;
  }
}

// ─── CALLBACK ROUTER ─────────────────────────────────────────────────────────

async function routeCallback(
  bot: TelegramBot, chatId: number, msgId: number, data: string
): Promise<void> {
  if (data === "noop") return;
  if (data === "menu") { await editMenu(bot, chatId, msgId); return; }

  // cmd: shortcuts from inline menu
  if (data.startsWith("cmd:")) {
    const cmd = data.slice(4);
    if (["feeds","latest","queue","favourites","tags","stats","refresh","trending","add","search","browse"].includes(cmd)) {
      if (cmd === "trending") { await editMd(bot, chatId, msgId, "⏳"); await showCountryPicker(bot, chatId, 0, msgId); return; }
      if (cmd === "add") {
        getSession(chatId).action = "awaiting_rss";
        await editMd(bot, chatId, msgId, fmt(["📡 *Add a Podcast*", divider(), "Send the RSS or Atom feed URL:"]), { inline_keyboard: [homeRow()] });
        return;
      }
      if (cmd === "search") {
        getSession(chatId).action = "awaiting_search";
        await editMd(bot, chatId, msgId, fmt(["🔎 *Search Episodes*", divider(), "Enter a keyword:"]), { inline_keyboard: [homeRow()] });
        return;
      }
      if (cmd === "browse") {
        getSession(chatId).action = "awaiting_browse";
        await editMd(bot, chatId, msgId, fmt(["🌐 *Browse iTunes*", divider(), "Enter a show name or topic:"]), { inline_keyboard: [homeRow()] });
        return;
      }
      await cmdDispatch(bot, chatId, msgId, cmd); return;
    }
  }

  // Feed & episode navigation
  if (data.startsWith("feed:"))           { await showFeedEpisodes(bot, chatId, msgId, +data.slice(5), 0); return; }
  if (data.startsWith("eplist:"))         { const [,f,p] = data.split(":").map(Number); await showFeedEpisodes(bot, chatId, msgId, f, p); return; }
  if (data.startsWith("ep:"))             { await showEpisodeDetail(bot, chatId, msgId, +data.slice(3)); return; }
  if (data.startsWith("fav:"))            { await toggleFavourite(bot, chatId, msgId, +data.slice(4)); return; }
  if (data.startsWith("queue_add:"))      { await addToQueue(bot, chatId, msgId, +data.slice(10)); return; }
  if (data.startsWith("queue_rm:"))       { await removeFromQueue(chatId, +data.slice(9)); await cmdQueue(bot, chatId, msgId); return; }
  if (data.startsWith("listened:"))       { await markListened(bot, chatId, msgId, +data.slice(9)); return; }
  if (data.startsWith("del_feed:"))       { await deleteFeed(bot, chatId, msgId, +data.slice(9)); return; }
  if (data.startsWith("refresh_feed:"))   { await refreshSingleFeed(bot, chatId, msgId, +data.slice(12)); return; }

  // Downloads & AI
  if (data.startsWith("download:"))       { void handleDownload(bot, chatId, +data.slice(9)); return; }
  if (data.startsWith("ai_summary:"))     { void handleAiSummary(bot, chatId, +data.slice(11)); return; }
  if (data.startsWith("ai_detail:"))      { void handleAiDetail(bot, chatId, +data.slice(10)); return; }
  if (data.startsWith("transcript:"))     { void handleTranscriptPdf(bot, chatId, +data.slice(11)); return; }

  // Tags
  if (data.startsWith("tag_list:"))       { await showTagEpisodes(bot, chatId, msgId, +data.slice(9), 0); return; }
  if (data.startsWith("tag_page:"))       { const [,t,p] = data.split(":").map(Number); await showTagEpisodes(bot, chatId, msgId, t, p); return; }
  if (data.startsWith("tag_del:"))        { await deleteTag(bot, chatId, msgId, +data.slice(8)); return; }
  if (data.startsWith("tag_pick:"))       { await showTagPicker(bot, chatId, msgId, +data.slice(9)); return; }
  if (data.startsWith("tag_toggle:"))     { const [,e,t] = data.split(":").map(Number); await toggleEpisodeTag(bot, chatId, msgId, e, t); return; }
  if (data === "tag_new")                 { getSession(chatId).action = "awaiting_tag_name"; await editMd(bot, chatId, msgId, fmt(["🏷 *Create Tag*", divider(), "Type a name for the new tag:"]), { inline_keyboard: [homeRow()] }); return; }

  // Discovery
  if (data.startsWith("country_page:"))   { const [,p] = data.split(":"); await showCountryPicker(bot, chatId, +p, msgId); return; }
  if (data === "country_type")            { getSession(chatId).action = "awaiting_country_code"; await editMd(bot, chatId, msgId, fmt(["🔤 *Enter Country Code*", divider(), "Type a 2-letter code: `us` · `gb` · `sa` · `de` · `jp`"]), { inline_keyboard: [homeRow()] }); return; }
  if (data.startsWith("trend_c:"))        { const [,c,p] = data.split(":"); await showTopCharts(bot, chatId, +(p ?? 0), c, msgId); return; }
  if (data.startsWith("charts_page:"))    { const [,c,p] = data.split(":"); await showTopCharts(bot, chatId, +p, c, msgId); return; }
  if (data.startsWith("disc_sub:"))       { await subscribeFromDiscovery(bot, chatId, msgId, data.slice(9)); return; }
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
  }
}

// ─── MENU ─────────────────────────────────────────────────────────────────────

function menuText(): string {
  return fmt([
    "🎙 *Podcast Bot*", divider(),
    "Use the keyboard below to navigate.",
    "_All features are one tap away._",
  ]);
}

async function sendMenu(bot: TelegramBot, chatId: number): Promise<void> {
  await sendMd(bot, chatId, menuText(), { reply_markup: CONTROL_PANEL });
}

async function editMenu(bot: TelegramBot, chatId: number, msgId: number): Promise<void> {
  await editMd(bot, chatId, msgId, menuText());
  // Re-send control panel (inline edit can't restore reply keyboard)
  await sendMd(bot, chatId, "⌨️ _Keyboard restored._", { reply_markup: CONTROL_PANEL });
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
    if (entries[i + 1]) {
      row.push({ text: entries[i + 1][1], callback_data: `trend_c:${entries[i + 1][0]}:0` });
    }
    rows.push(row);
  }

  const nav: TelegramBot.InlineKeyboardButton[] = [];
  if (page > 0)               nav.push({ text: "◀️ Prev", callback_data: `country_page:${page - 1}` });
  nav.push({ text: `${page + 1}/${totalPages}`, callback_data: "noop" });
  if (page < totalPages - 1)  nav.push({ text: "Next ▶️", callback_data: `country_page:${page + 1}` });
  rows.push(nav);
  rows.push([{ text: "🔤 Enter Any Country Code", callback_data: "country_type" }]);
  rows.push(homeRow());

  const text = fmt(["🌍 *Trending Podcasts*", divider(), `Select a country · Page ${page + 1} of ${totalPages}`]);
  if (msgId) await editMd(bot, chatId, msgId, text, { inline_keyboard: rows });
  else       await sendMd(bot, chatId, text, { reply_markup: { inline_keyboard: rows } });
}

// ─── TOP CHARTS ───────────────────────────────────────────────────────────────

async function showTopCharts(
  bot: TelegramBot, chatId: number, page: number, country: string, msgId?: number
): Promise<void> {
  const label = findCountry(country) ?? country.toUpperCase();
  const loader = fmt(["⏳ *Loading Charts…*", divider(), `🌍 ${label}`]);

  let currentMsgId: number;
  if (msgId) { await editMd(bot, chatId, msgId, loader); currentMsgId = msgId; }
  else       { const m = await sendMd(bot, chatId, loader); currentMsgId = m.message_id; }

  try {
    const all        = await fetchTopCharts(country, 100);
    const totalPages = Math.max(1, Math.ceil(all.length / CHART_PAGE));
    const slice      = all.slice(page * CHART_PAGE, (page + 1) * CHART_PAGE);
    const start      = page * CHART_PAGE + 1;

    // callback_data: "disc_sub:{itunesId}" — never exceeds 64 bytes (max ~20 chars)
    const keyboard: TelegramBot.InlineKeyboardButton[][] = slice.map((p, i) => [{
      text: `${start + i}. ${truncate(p.name, 34)}`,
      callback_data: `disc_sub:${p.id}`,   // ← ID only, name in cache
    }]);

    const nav: TelegramBot.InlineKeyboardButton[] = [];
    if (page > 0)              nav.push({ text: "◀️ Prev", callback_data: `charts_page:${country}:${page - 1}` });
    if (page < totalPages - 1) nav.push({ text: "Next ▶️", callback_data: `charts_page:${country}:${page + 1}` });
    if (nav.length) keyboard.push(nav);
    keyboard.push([{ text: "🌍 Change Country", callback_data: "country_page:0" }]);
    keyboard.push(homeRow());

    await editMd(bot, chatId, currentMsgId, fmt([
      `🏆 *Top Podcasts · ${label}*`, divider(),
      `Page ${page + 1} of ${totalPages}`, shortDivider(),
      ...slice.map((p, i) =>
        `${start + i}. *${truncate(p.name, 36)}*\n    _${truncate(p.artist, 32)}_`
      ),
      divider(), "_Tap a podcast to subscribe._",
    ]), { inline_keyboard: keyboard });

  } catch (err: any) {
    await editMd(bot, chatId, currentMsgId, fmt([
      "❌ *Charts Unavailable*", divider(),
      truncate(String(err?.message ?? err), 160),
      "", "_Please try a different country._",
    ]), { inline_keyboard: [
      [{ text: "🌍 Try Another Country", callback_data: "country_page:0" }],
      homeRow(),
    ]});
  }
}

// ─── PODCAST SEARCH ───────────────────────────────────────────────────────────

async function handlePodcastSearch(bot: TelegramBot, chatId: number, query: string): Promise<void> {
  const loadMsg = await sendMd(bot, chatId, fmt(["🔍 *Searching iTunes…*", divider(), `"${truncate(query, 40)}"`]));

  try {
    const results = await searchPodcasts(query, "us", 20);
    if (!results.length) {
      await editMd(bot, chatId, loadMsg.message_id,
        fmt([`🔍 *No Results*`, divider(), `Nothing found for "${truncate(query, 30)}".`]),
        { inline_keyboard: [homeRow()] });
      return;
    }

    const keyboard: TelegramBot.InlineKeyboardButton[][] = results.map((p, i) => [{
      text: `${i + 1}. ${truncate(p.name, 34)}`,
      callback_data: `disc_sub:${p.id}`,   // ← ID only
    }]);
    keyboard.push(homeRow());

    await editMd(bot, chatId, loadMsg.message_id, fmt([
      `🌐 *"${truncate(query, 28)}" · ${results.length} results*`, divider(),
      ...results.map((p, i) =>
        `${i + 1}. *${truncate(p.name, 36)}*\n    _${truncate(p.artist, 30)}_`
      ),
      divider(), "_Tap to subscribe._",
    ]), { inline_keyboard: keyboard });

  } catch (err: any) {
    await editMd(bot, chatId, loadMsg.message_id,
      fmt(["❌ *Search Failed*", divider(), truncate(String(err?.message ?? err), 100)]),
      { inline_keyboard: [homeRow()] });
  }
}

// ─── SUBSCRIBE FROM DISCOVERY ─────────────────────────────────────────────────

async function subscribeFromDiscovery(
  bot: TelegramBot, chatId: number, msgId: number, itunesId: string
): Promise<void> {
  // Look up name from cache; fall back to iTunes lookup
  const cached = getCachedPodcast(itunesId);
  let name     = cached?.name ?? itunesId;

  // If we have the feedUrl from cache, use it directly
  let rssUrl = cached?.feedUrl ?? null;

  await editMd(bot, chatId, msgId, fmt(["⏳ *Resolving Feed…*", divider(), `📻 ${name}`]));

  try {
    if (!rssUrl) {
      rssUrl = await resolveRssFeed(itunesId);
      if (!rssUrl) {
        await editMd(bot, chatId, msgId, fmt([
          "❌ *RSS Feed Not Found*", divider(), `📻 ${name}`, "",
          "Apple Podcasts did not return an RSS URL. Try /add instead.",
        ]), { inline_keyboard: [homeRow()] });
        return;
      }
    }

    const existing = await db.select().from(feedsTable)
      .where(and(eq(feedsTable.chatId, String(chatId)), eq(feedsTable.url, rssUrl))).limit(1);
    if (existing.length) {
      await editMd(bot, chatId, msgId, fmt([
        "⚠️ *Already Subscribed*", divider(), `📻 ${name}`,
      ]), { inline_keyboard: [[{ text: "📻 Browse Feed", callback_data: `feed:${existing[0].id}` }], homeRow()] });
      return;
    }

    await editMd(bot, chatId, msgId, fmt([
      "⏳ *Fetching Episodes…*", divider(), `📻 ${name}`,
      "_This may take a moment for large feeds._",
    ]));

    const feedData = await fetchFeed(rssUrl);
    name           = feedData.title || name;
    const [feed]   = await db.insert(feedsTable).values({
      chatId: String(chatId), url: rssUrl, title: name, lastChecked: new Date(),
    }).returning();

    if (feedData.episodes.length) {
      const CHUNK = 100;
      for (let i = 0; i < feedData.episodes.length; i += CHUNK) {
        await db.insert(episodesTable).values(
          feedData.episodes.slice(i, i + CHUNK).map((ep) => ({
            feedId: feed.id, guid: ep.guid, title: ep.title,
            description: ep.description, audioUrl: ep.audioUrl,
            pubDate: ep.pubDate, duration: ep.duration,
          }))
        ).onConflictDoNothing();
      }
    }

    await editMd(bot, chatId, msgId, fmt([
      "✅ *Subscribed!*", divider(),
      `📻 *${truncate(name, 45)}*`,
      `🎙 ${feedData.episodes.length} episode${feedData.episodes.length !== 1 ? "s" : ""} loaded`,
    ]), { inline_keyboard: [
      [{ text: "📻 Browse Feed", callback_data: `feed:${feed.id}` }],
      homeRow(),
    ]});

  } catch (err: any) {
    await editMd(bot, chatId, msgId, fmt([
      "❌ *Subscription Failed*", divider(),
      truncate(String(err?.message ?? err), 120), "", "Try /add to add manually.",
    ]), { inline_keyboard: [homeRow()] });
  }
}

// ─── ADD VIA RSS ──────────────────────────────────────────────────────────────

async function handleAddRss(bot: TelegramBot, chatId: number, url: string): Promise<void> {
  if (!url.startsWith("http")) {
    await sendMd(bot, chatId, "❌ URL must begin with `http` or `https`.", { reply_markup: { inline_keyboard: [homeRow()] } });
    return;
  }
  const loadMsg = await sendMd(bot, chatId, fmt(["⏳ *Fetching Feed…*", divider(), `📡 ${truncate(url, 42)}`]));
  try {
    const feedData = await fetchFeed(url);
    const existing = await db.select().from(feedsTable)
      .where(and(eq(feedsTable.chatId, String(chatId)), eq(feedsTable.url, url))).limit(1);

    if (existing.length) {
      await editMd(bot, chatId, loadMsg.message_id,
        fmt(["⚠️ *Already Subscribed*", divider(), `📻 ${truncate(feedData.title, 45)}`]),
        { inline_keyboard: [[{ text: "📻 Browse Feed", callback_data: `feed:${existing[0].id}` }], homeRow()] });
      return;
    }

    const [feed] = await db.insert(feedsTable).values({
      chatId: String(chatId), url, title: feedData.title, lastChecked: new Date(),
    }).returning();

    const CHUNK = 100;
    for (let i = 0; i < feedData.episodes.length; i += CHUNK) {
      await db.insert(episodesTable).values(
        feedData.episodes.slice(i, i + CHUNK).map((ep) => ({
          feedId: feed.id, guid: ep.guid, title: ep.title,
          description: ep.description, audioUrl: ep.audioUrl,
          pubDate: ep.pubDate, duration: ep.duration,
        }))
      ).onConflictDoNothing();
    }

    await editMd(bot, chatId, loadMsg.message_id, fmt([
      "✅ *Subscribed!*", divider(),
      `📻 *${truncate(feedData.title, 45)}*`,
      `🎙 ${feedData.episodes.length} episode${feedData.episodes.length !== 1 ? "s" : ""} loaded`,
    ]), { inline_keyboard: [[{ text: "📻 Browse Feed", callback_data: `feed:${feed.id}` }], homeRow()] });

  } catch (err: any) {
    await editMd(bot, chatId, loadMsg.message_id, fmt([
      "❌ *Feed Could Not Be Loaded*", divider(),
      "Please verify the URL is a valid RSS or Atom feed.",
      "", `_${truncate(String(err?.message ?? err), 80)}_`,
    ]), { inline_keyboard: [homeRow()] });
  }
}

// ─── FEEDS ────────────────────────────────────────────────────────────────────

async function cmdFeeds(bot: TelegramBot, chatId: number, msgId?: number): Promise<void> {
  const feeds = await db.select().from(feedsTable)
    .where(eq(feedsTable.chatId, String(chatId))).orderBy(feedsTable.createdAt);

  if (!feeds.length) {
    const text = fmt(["📭 *No Subscriptions Yet*", divider(), "Use ➕ Add RSS or 🌍 Trending to subscribe."]);
    const kb   = { inline_keyboard: [[{ text: "➕ Add RSS", callback_data: "cmd:add" }, { text: "🌍 Trending", callback_data: "cmd:trending" }], homeRow()] };
    msgId ? await editMd(bot, chatId, msgId, text, kb) : await sendMd(bot, chatId, text, { reply_markup: kb });
    return;
  }

  const epCounts = await Promise.all(
    feeds.map((f) => db.select({ c: count() }).from(episodesTable).where(eq(episodesTable.feedId, f.id)))
  );
  const lines    = feeds.map((f, i) => feedCard({ index: i + 1, title: f.title, url: f.url, episodeCount: epCounts[i][0].c, lastChecked: f.lastChecked }));
  const keyboard = feeds.map((f, i) => [{ text: `${i + 1}. ${truncate(f.title, 30)}`, callback_data: `feed:${f.id}` }]);
  keyboard.push(homeRow());

  const text = fmt([`📻 *My Subscriptions · ${feeds.length}*`, divider(), ...lines, divider(), "_Tap a podcast to browse its episodes._"]);
  msgId ? await editMd(bot, chatId, msgId, text, { inline_keyboard: keyboard })
        : await sendMd(bot, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}

async function showFeedEpisodes(
  bot: TelegramBot, chatId: number, msgId: number, feedId: number, page: number
): Promise<void> {
  const feed = await db.select().from(feedsTable).where(eq(feedsTable.id, feedId)).limit(1);
  if (!feed[0]) return;

  const [{ c: totalCount }] = await db.select({ c: count() }).from(episodesTable).where(eq(episodesTable.feedId, feedId));
  const episodes = await db.select().from(episodesTable)
    .where(eq(episodesTable.feedId, feedId))
    .orderBy(desc(episodesTable.pubDate))
    .limit(PAGE_SIZE).offset(page * PAGE_SIZE);

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const startIdx   = page * PAGE_SIZE + 1;

  const keyboard: TelegramBot.InlineKeyboardButton[][] = episodes.map((ep, i) => [{
    text: `${startIdx + i}. ${ep.listened ? "✅" : "🔵"} ${truncate(ep.title, 30)}`,
    callback_data: `ep:${ep.id}`,
  }]);

  const navRow: TelegramBot.InlineKeyboardButton[] = [];
  if (page > 0)              navRow.push({ text: "◀️ Prev", callback_data: `eplist:${feedId}:${page - 1}` });
  navRow.push({ text: `${page + 1}/${totalPages}`, callback_data: "noop" });
  if (page < totalPages - 1) navRow.push({ text: "Next ▶️", callback_data: `eplist:${feedId}:${page + 1}` });
  keyboard.push(navRow);
  keyboard.push([
    { text: "🔄 Refresh", callback_data: `refresh_feed:${feedId}` },
    { text: "🗑 Remove",   callback_data: `del_feed:${feedId}` },
  ]);
  keyboard.push(homeRow());

  await editMd(bot, chatId, msgId, fmt([
    `📻 *${truncate(feed[0].title, 40)}*`, divider(),
    `🎙 ${totalCount} episode${totalCount !== 1 ? "s" : ""} · Page ${page + 1} of ${totalPages}`,
    shortDivider(),
    ...episodes.map((ep, i) =>
      `${startIdx + i}. ${ep.listened ? "✅" : "🔵"} ${truncate(ep.title, 42)}`
    ),
    divider(), "_Tap an episode for details._",
  ]), { inline_keyboard: keyboard });
}

// ─── EPISODE DETAIL ───────────────────────────────────────────────────────────

async function showEpisodeDetail(
  bot: TelegramBot, chatId: number, msgId: number, epId: number
): Promise<void> {
  const ep = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;

  const [feed, favRows, queueRows, epTagRows] = await Promise.all([
    db.select().from(feedsTable).where(eq(feedsTable.id, ep[0].feedId)).limit(1),
    db.select().from(favoritesTable).where(and(eq(favoritesTable.chatId, String(chatId)), eq(favoritesTable.episodeId, epId))).limit(1),
    db.select().from(queueTable).where(and(eq(queueTable.chatId, String(chatId)), eq(queueTable.episodeId, epId))).limit(1),
    db.select({ tagId: episodeTagsTable.tagId }).from(episodeTagsTable).where(eq(episodeTagsTable.episodeId, epId)),
  ]);

  const isFav        = favRows.length > 0;
  const inQueue      = queueRows.length > 0;
  const hasAudio     = Boolean(ep[0].audioUrl);
  const hasTranscript = Boolean(ep[0].transcript);
  const tagCount     = epTagRows.length;

  const card = episodeCard({
    title: ep[0].title, feedTitle: feed[0]?.title,
    pubDate: ep[0].pubDate, duration: ep[0].duration,
    listened: ep[0].listened ?? false, progress: ep[0].progress ?? 0,
    isFav, inQueue,
  });

  const desc = ep[0].description
    ? "\n" + divider() + "\n" + truncate(ep[0].description.replace(/<[^>]+>/g, ""), 200)
    : "";

  const keyboard: TelegramBot.InlineKeyboardButton[][] = [];

  keyboard.push([
    { text: isFav ? "💔 Unfavourite" : "❤️ Favourite", callback_data: `fav:${epId}` },
    { text: inQueue ? "✅ In Queue" : "⏭ Add to Queue", callback_data: `queue_add:${epId}` },
  ]);

  keyboard.push([
    { text: ep[0].listened ? "🔄 Mark Unplayed" : "✅ Mark Played", callback_data: `listened:${epId}` },
    { text: `🏷 Tags${tagCount ? ` (${tagCount})` : ""}`, callback_data: `tag_pick:${epId}` },
  ]);

  if (hasAudio) {
    keyboard.push([{ text: "📥 Download Episode", callback_data: `download:${epId}` }]);
  }

  // AI row
  if (hasWhisperKey()) {
    const transcriptLabel = hasTranscript ? "✅ Transcript Ready" : "📝 Generate Transcript";
    keyboard.push([{ text: transcriptLabel, callback_data: `transcript:${epId}` }]);
  }
  if (hasTranscript && hasDeepseekKey()) {
    keyboard.push([
      { text: "💡 Summary",   callback_data: `ai_summary:${epId}` },
      { text: "📚 Breakdown", callback_data: `ai_detail:${epId}` },
    ]);
  } else if (!hasTranscript && hasWhisperKey() && hasDeepseekKey()) {
    keyboard.push([{ text: "💡 Summary (transcribes first)", callback_data: `ai_summary:${epId}` }]);
  }

  keyboard.push([
    { text: "📄 Transcript PDF", callback_data: `transcript:${epId}` },
    { text: "◀️ Back",           callback_data: `feed:${ep[0].feedId}` },
  ]);
  keyboard.push(homeRow());

  await editMd(bot, chatId, msgId, card + desc, { inline_keyboard: keyboard });
}

// ─── DOWNLOAD + AUTO-TRANSCRIPT ───────────────────────────────────────────────

async function handleDownload(bot: TelegramBot, chatId: number, epId: number): Promise<void> {
  const ep = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]?.audioUrl) {
    await sendMd(bot, chatId, "❌ No audio URL for this episode.", { reply_markup: { inline_keyboard: [homeRow()] } });
    return;
  }
  const feed       = await db.select().from(feedsTable).where(eq(feedsTable.id, ep[0].feedId)).limit(1);
  const feedTitle  = feed[0]?.title ?? "Podcast";

  const statusMsg  = await sendMd(bot, chatId, fmt([
    "📥 *Preparing Download*", divider(),
    `🎙 *${truncate(ep[0].title, 50)}*`, "",
    hasWhisperKey() && !ep[0].transcript ? "📝 Transcribing first…" : "▶️ Starting download…",
  ]));

  const editStatus = async (text: string) => {
    await bot.editMessageText(text, {
      chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown",
    }).catch(() => {/* ignore flicker errors */});
  };

  let transcript = ep[0].transcript ?? null;

  // ── Step 1: Auto-transcribe ───────────────────────────────────────────────
  if (!transcript && hasWhisperKey()) {
    try {
      transcript = await transcribeEpisodeFull(ep[0].audioUrl, {
        onProgress: async (msg) => {
          await editStatus(fmt(["📥 *Downloading & Transcribing*", divider(), `🎙 *${truncate(ep[0].title, 50)}*`, "", msg]));
        },
      });
      await db.update(episodesTable)
        .set({ transcript, transcriptAt: new Date() })
        .where(eq(episodesTable.id, epId));
    } catch (err: any) {
      await editStatus(fmt([
        "📥 *Downloading Episode*", divider(),
        `🎙 *${truncate(ep[0].title, 50)}*`, "",
        `⚠️ Transcript failed (${truncate(String(err?.message ?? err), 60)})`,
        "Continuing with download…",
      ]));
    }
  }

  // ── Step 2: Send audio ────────────────────────────────────────────────────
  try {
    await sendEpisodeAudio({
      chatId, episodeTitle: ep[0].title, feedTitle,
      audioUrl: ep[0].audioUrl, episodeId: epId,
      onProgress: async (text) => {
        await editStatus(fmt(["📥 *Sending to Telegram*", divider(), `🎙 *${truncate(ep[0].title, 50)}*`, "", text]));
      },
    });
    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {/* ignore */});
  } catch (err: any) {
    await bot.editMessageText(fmt([
      "❌ *Upload Failed*", divider(), truncate(String(err?.message ?? err), 100),
    ]), {
      chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [
        ep[0].audioUrl ? [{ text: "🔗 Open Audio URL", url: ep[0].audioUrl }] : [],
        homeRow(),
      ].filter(r => r.length > 0) },
    });
    return;
  }

  // ── Step 3: Auto-summary after transcript ─────────────────────────────────
  if (transcript && hasDeepseekKey()) {
    try {
      const summary = await generateSummary(transcript, feedTitle, ep[0].title);
      for (const chunk of splitLong(summary, 3800)) {
        await sendMd(bot, chatId, fmt([
          "💡 *Episode Summary*", divider(),
          `🎙 *${truncate(ep[0].title, 48)}*`, divider(), chunk,
        ]), { reply_markup: { inline_keyboard: [
          [{ text: "📚 Full Breakdown", callback_data: `ai_detail:${epId}` }],
          homeRow(),
        ]}});
      }
    } catch { /* bonus feature — never fail download over this */ }
  }
}

// ─── AI: SUMMARY ──────────────────────────────────────────────────────────────

async function handleAiSummary(bot: TelegramBot, chatId: number, epId: number): Promise<void> {
  const ep   = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;
  const feed = await db.select().from(feedsTable).where(eq(feedsTable.id, ep[0].feedId)).limit(1);

  if (!hasDeepseekKey()) {
    await sendMd(bot, chatId, fmt(["🔑 *DeepSeek Key Required*", divider(), "Add `DEEPSEEK_API_KEY` in Secrets."]), { reply_markup: { inline_keyboard: [homeRow()] } });
    return;
  }

  let transcript = ep[0].transcript;
  if (!transcript) {
    if (!hasWhisperKey() || !ep[0].audioUrl) {
      await sendMd(bot, chatId, fmt(["⚠️ *Transcript Needed*", divider(), "Download the episode first — transcript is automatic."]), { reply_markup: { inline_keyboard: [[{ text: "📥 Download", callback_data: `download:${epId}` }], homeRow()] } });
      return;
    }
    const st = await sendMd(bot, chatId, fmt(["⏳ *Transcribing…*", divider(), truncate(ep[0].title, 50)]));
    try {
      transcript = await transcribeEpisodeFull(ep[0].audioUrl, {
        onProgress: async (msg) => {
          await bot.editMessageText(fmt(["⏳ *Transcribing…*", divider(), truncate(ep[0].title, 50), "", msg]),
            { chat_id: chatId, message_id: st.message_id, parse_mode: "Markdown" });
        },
      });
      await db.update(episodesTable).set({ transcript, transcriptAt: new Date() }).where(eq(episodesTable.id, epId));
      await bot.deleteMessage(chatId, st.message_id).catch(() => {});
    } catch (err: any) {
      await editMd(bot, chatId, st.message_id, fmt(["❌ *Transcription Failed*", divider(), truncate(String(err?.message ?? err), 100)]), { inline_keyboard: [homeRow()] });
      return;
    }
  }

  const gm = await sendMd(bot, chatId, fmt(["💡 *Generating Summary…*", divider(), truncate(ep[0].title, 50)]));
  try {
    const summary = await generateSummary(transcript, feed[0]?.title ?? "Podcast", ep[0].title);
    await bot.deleteMessage(chatId, gm.message_id).catch(() => {});
    for (const chunk of splitLong(summary, 3800)) {
      await sendMd(bot, chatId, fmt(["💡 *Episode Summary*", divider(), `🎙 *${truncate(ep[0].title, 48)}*`, divider(), chunk]),
        { reply_markup: { inline_keyboard: [[{ text: "📚 Full Breakdown", callback_data: `ai_detail:${epId}` }], homeRow()] }});
    }
  } catch (err: any) {
    await editMd(bot, chatId, gm.message_id, fmt(["❌ *Summary Failed*", divider(), truncate(String(err?.message ?? err), 100)]), { inline_keyboard: [homeRow()] });
  }
}

// ─── AI: DETAILED BREAKDOWN ───────────────────────────────────────────────────

async function handleAiDetail(bot: TelegramBot, chatId: number, epId: number): Promise<void> {
  const ep   = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;
  const feed = await db.select().from(feedsTable).where(eq(feedsTable.id, ep[0].feedId)).limit(1);

  if (!hasDeepseekKey()) {
    await sendMd(bot, chatId, fmt(["🔑 *DeepSeek Key Required*", divider(), "Add `DEEPSEEK_API_KEY` in Secrets."]), { reply_markup: { inline_keyboard: [homeRow()] } });
    return;
  }

  let transcript = ep[0].transcript;
  if (!transcript) {
    if (!hasWhisperKey() || !ep[0].audioUrl) {
      await sendMd(bot, chatId, fmt(["⚠️ *Transcript Needed*", divider(), "Download the episode first."]), { reply_markup: { inline_keyboard: [[{ text: "📥 Download", callback_data: `download:${epId}` }], homeRow()] } });
      return;
    }
    const st = await sendMd(bot, chatId, fmt(["⏳ *Transcribing…*", divider(), truncate(ep[0].title, 50)]));
    try {
      transcript = await transcribeEpisodeFull(ep[0].audioUrl, {
        onProgress: async (msg) => {
          await bot.editMessageText(fmt(["⏳ *Transcribing…*", divider(), truncate(ep[0].title, 50), "", msg]),
            { chat_id: chatId, message_id: st.message_id, parse_mode: "Markdown" });
        },
      });
      await db.update(episodesTable).set({ transcript, transcriptAt: new Date() }).where(eq(episodesTable.id, epId));
      await bot.deleteMessage(chatId, st.message_id).catch(() => {});
    } catch (err: any) {
      await editMd(bot, chatId, st.message_id, fmt(["❌ *Transcription Failed*", divider(), truncate(String(err?.message ?? err), 100)]), { inline_keyboard: [homeRow()] });
      return;
    }
  }

  const gm = await sendMd(bot, chatId, fmt(["📚 *Generating Detailed Breakdown…*", divider(), truncate(ep[0].title, 50), "_Deep analysis in progress…_"]));
  try {
    const detail = await generateDetailedExplanation(transcript, feed[0]?.title ?? "Podcast", ep[0].title);
    await bot.deleteMessage(chatId, gm.message_id).catch(() => {});
    const chunks = splitLong(detail, 3800);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      await sendMd(bot, chatId,
        fmt([`📚 *Breakdown${chunks.length > 1 ? ` · Part ${i + 1}/${chunks.length}` : ""}*`, divider(),
          `🎙 *${truncate(ep[0].title, 48)}*`, divider(), chunks[i]]),
        isLast ? { reply_markup: { inline_keyboard: [[{ text: "💡 Summary", callback_data: `ai_summary:${epId}` }, { text: "📄 PDF", callback_data: `transcript:${epId}` }], homeRow()] }} : undefined
      );
    }
  } catch (err: any) {
    await editMd(bot, chatId, gm.message_id, fmt(["❌ *Analysis Failed*", divider(), truncate(String(err?.message ?? err), 100)]), { inline_keyboard: [homeRow()] });
  }
}

// ─── TRANSCRIPT PDF ───────────────────────────────────────────────────────────

async function handleTranscriptPdf(bot: TelegramBot, chatId: number, epId: number): Promise<void> {
  const ep = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;
  const feed = await db.select().from(feedsTable).where(eq(feedsTable.id, ep[0].feedId)).limit(1);

  if (!hasWhisperKey()) {
    await sendMd(bot, chatId, fmt(["🔑 *OpenAI Key Required*", divider(), "Add `OPENAI_API_KEY` for Whisper transcription."]), { reply_markup: { inline_keyboard: [homeRow()] } });
    return;
  }
  if (!ep[0].audioUrl) {
    await sendMd(bot, chatId, "❌ No audio URL.", { reply_markup: { inline_keyboard: [homeRow()] } });
    return;
  }

  const st = await sendMd(bot, chatId, fmt(["📄 *Generating Transcript PDF…*", divider(), truncate(ep[0].title, 50), "_Transcribing audio…_"]));
  try {
    let transcript = ep[0].transcript;
    if (!transcript) {
      transcript = await transcribeEpisodeFull(ep[0].audioUrl, {
        onProgress: async (msg) => {
          await bot.editMessageText(fmt(["📄 *Generating Transcript PDF…*", divider(), truncate(ep[0].title, 50), "", msg]),
            { chat_id: chatId, message_id: st.message_id, parse_mode: "Markdown" });
        },
      });
      await db.update(episodesTable).set({ transcript, transcriptAt: new Date() }).where(eq(episodesTable.id, epId));
    }

    await bot.editMessageText(fmt(["📄 *Building PDF…*", divider(), truncate(ep[0].title, 50)]),
      { chat_id: chatId, message_id: st.message_id, parse_mode: "Markdown" });

    const pdfBuf = await generateTranscriptPdf({
      podcastTitle: feed[0]?.title ?? "Podcast",
      episodeTitle: ep[0].title, pubDate: ep[0].pubDate, duration: ep[0].duration, transcript,
    });

    await bot.deleteMessage(chatId, st.message_id).catch(() => {});
    await bot.sendDocument(chatId, pdfBuf as any,
      { caption: fmt(["📄 *Transcript*", divider(), `🎙 ${truncate(ep[0].title, 50)}`, `📻 ${truncate(feed[0]?.title ?? "", 40)}`]),
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "💡 Summary", callback_data: `ai_summary:${epId}` }], homeRow()] }},
      { filename: `transcript_ep${epId}.pdf`, contentType: "application/pdf" }
    );
  } catch (err: any) {
    await editMd(bot, chatId, st.message_id, fmt(["❌ *PDF Failed*", divider(), truncate(String(err?.message ?? err), 100)]), { inline_keyboard: [homeRow()] });
  }
}

// ─── LATEST ───────────────────────────────────────────────────────────────────

async function cmdLatest(bot: TelegramBot, chatId: number, msgId?: number): Promise<void> {
  const feeds = await db.select({ id: feedsTable.id }).from(feedsTable).where(eq(feedsTable.chatId, String(chatId)));
  if (!feeds.length) {
    const text = fmt(["📭 *No Subscriptions Yet*", divider(), "Add a podcast to see latest episodes."]);
    const kb   = { inline_keyboard: [[{ text: "➕ Add RSS", callback_data: "cmd:add" }], homeRow()] };
    msgId ? await editMd(bot, chatId, msgId, text, kb) : await sendMd(bot, chatId, text, { reply_markup: kb });
    return;
  }

  const arr      = sqlArr(feeds.map((f) => f.id));
  const episodes = await db.select().from(episodesTable)
    .where(sql`${episodesTable.feedId} = ANY(${arr})`)
    .orderBy(desc(episodesTable.pubDate)).limit(10);

  if (!episodes.length) {
    const text = fmt(["📭 *No Episodes Found*", "Use 🔄 Refresh to check for new ones."]);
    const kb   = { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: "cmd:refresh" }], homeRow()] };
    msgId ? await editMd(bot, chatId, msgId, text, kb) : await sendMd(bot, chatId, text, { reply_markup: kb });
    return;
  }

  const allFeeds = await db.select().from(feedsTable).where(eq(feedsTable.chatId, String(chatId)));
  const feedMap  = new Map(allFeeds.map((f) => [f.id, f.title]));
  const keyboard = episodes.map((ep, i) => [{ text: `${i + 1}. ${ep.listened ? "✅" : "🔵"} ${truncate(ep.title, 30)}`, callback_data: `ep:${ep.id}` }]);
  keyboard.push(homeRow());

  const text = fmt([
    `🆕 *Latest · ${episodes.length} Episodes*`, divider(),
    ...episodes.map((ep, i) =>
      `${i + 1}. ${ep.listened ? "✅" : "🔵"} *${truncate(ep.title, 38)}*\n    📻 ${truncate(feedMap.get(ep.feedId) ?? "—", 28)}`
    ),
    divider(), "_Tap an episode for details & download._",
  ]);
  msgId ? await editMd(bot, chatId, msgId, text, { inline_keyboard: keyboard })
        : await sendMd(bot, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}

// ─── QUEUE ────────────────────────────────────────────────────────────────────

async function cmdQueue(bot: TelegramBot, chatId: number, msgId?: number): Promise<void> {
  const queue = await db.select({
    episodeId: queueTable.episodeId, position: queueTable.position,
    title: episodesTable.title, listened: episodesTable.listened,
  }).from(queueTable)
    .innerJoin(episodesTable, eq(queueTable.episodeId, episodesTable.id))
    .where(eq(queueTable.chatId, String(chatId)))
    .orderBy(queueTable.position);

  const text     = queue.length
    ? fmt([`⏭ *Queue · ${queue.length}*`, divider(), ...queue.map((q, i) => `${i + 1}. ${q.listened ? "✅" : "🔵"} ${truncate(q.title, 42)}`)])
    : fmt(["📭 *Queue is Empty*", divider(), "Add episodes from Latest or Feeds."]);
  const keyboard = queue.map((q, i) => [
    { text: `${i + 1}. ${q.listened ? "✅" : "🔵"} ${truncate(q.title, 25)}`, callback_data: `ep:${q.episodeId}` },
    { text: "🗑", callback_data: `queue_rm:${q.episodeId}` },
  ]);
  keyboard.push(homeRow());
  msgId ? await editMd(bot, chatId, msgId, text, { inline_keyboard: keyboard })
        : await sendMd(bot, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}

// ─── FAVOURITES ───────────────────────────────────────────────────────────────

async function cmdFavourites(bot: TelegramBot, chatId: number, msgId?: number): Promise<void> {
  const favs = await db.select({ episodeId: episodesTable.id, title: episodesTable.title, listened: episodesTable.listened })
    .from(favoritesTable)
    .innerJoin(episodesTable, eq(favoritesTable.episodeId, episodesTable.id))
    .where(eq(favoritesTable.chatId, String(chatId)))
    .orderBy(desc(favoritesTable.createdAt)).limit(20);

  const text     = favs.length
    ? fmt([`❤️ *Favourites · ${favs.length}*`, divider(), ...favs.map((f, i) => `${i + 1}. ${f.listened ? "✅" : "🔵"} ${truncate(f.title, 42)}`)])
    : fmt(["📭 *No Favourites Yet*", divider(), "Tap ❤️ on any episode to save it here."]);
  const keyboard = favs.map((f, i) => [{ text: `${i + 1}. ${f.listened ? "✅" : "🔵"} ${truncate(f.title, 30)}`, callback_data: `ep:${f.episodeId}` }]);
  keyboard.push(homeRow());
  msgId ? await editMd(bot, chatId, msgId, text, { inline_keyboard: keyboard })
        : await sendMd(bot, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}

// ─── TAGS ─────────────────────────────────────────────────────────────────────

async function cmdTags(bot: TelegramBot, chatId: number, msgId?: number): Promise<void> {
  const tags = await db.select().from(tagsTable)
    .where(eq(tagsTable.chatId, String(chatId))).orderBy(tagsTable.name);

  if (!tags.length) {
    const text = fmt(["🏷 *No Tags Yet*", divider(), "Create tags to organise your episodes into folders.", "", "Tap ➕ to create your first tag."]);
    const kb   = { inline_keyboard: [[{ text: "➕ Create Tag", callback_data: "tag_new" }], homeRow()] };
    msgId ? await editMd(bot, chatId, msgId, text, kb) : await sendMd(bot, chatId, text, { reply_markup: kb });
    return;
  }

  // Get episode counts per tag
  const counts = await Promise.all(tags.map((t) =>
    db.select({ c: count() }).from(episodeTagsTable).where(eq(episodeTagsTable.tagId, t.id))
  ));

  const keyboard: TelegramBot.InlineKeyboardButton[][] = tags.map((t, i) => [
    { text: `🏷 ${truncate(t.name, 28)} (${counts[i][0].c})`, callback_data: `tag_list:${t.id}` },
    { text: "🗑", callback_data: `tag_del:${t.id}` },
  ]);
  keyboard.push([{ text: "➕ Create Tag", callback_data: "tag_new" }]);
  keyboard.push(homeRow());

  const text = fmt([
    `🏷 *Tags · ${tags.length}*`, divider(),
    ...tags.map((t, i) => `🏷 *${truncate(t.name, 36)}* — ${counts[i][0].c} episode${counts[i][0].c !== 1 ? "s" : ""}`),
    divider(), "_Tap a tag to browse its episodes._",
  ]);
  msgId ? await editMd(bot, chatId, msgId, text, { inline_keyboard: keyboard })
        : await sendMd(bot, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}

async function createTag(bot: TelegramBot, chatId: number, name: string): Promise<void> {
  if (!name.trim()) { await sendMd(bot, chatId, "❌ Tag name cannot be empty."); return; }
  const existing = await db.select().from(tagsTable)
    .where(and(eq(tagsTable.chatId, String(chatId)), eq(tagsTable.name, name))).limit(1);
  if (existing.length) {
    await sendMd(bot, chatId, fmt(["⚠️ *Tag Already Exists*", divider(), `🏷 ${name}`]), { reply_markup: { inline_keyboard: [homeRow()] } });
    return;
  }
  const [tag] = await db.insert(tagsTable).values({ chatId: String(chatId), name }).returning();
  await sendMd(bot, chatId, fmt(["✅ *Tag Created*", divider(), `🏷 *${tag.name}*`, "", "Open an episode and tap 🏷 Tags to add it here."]),
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
    await editMd(bot, chatId, msgId, fmt([
      `🏷 *${truncate(tag[0].name, 40)}*`, divider(), "No episodes in this tag yet.",
      "", "Open an episode and tap 🏷 Tags to add it.",
    ]), { inline_keyboard: [[{ text: "🏷 Back to Tags", callback_data: "cmd:tags" }], homeRow()] });
    return;
  }

  const arr      = sqlArr(epIds);
  const total    = epIds.length;
  const episodes = await db.select().from(episodesTable)
    .where(sql`${episodesTable.id} = ANY(${arr})`)
    .orderBy(desc(episodesTable.pubDate))
    .limit(PAGE_SIZE).offset(page * PAGE_SIZE);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const startIdx   = page * PAGE_SIZE + 1;

  const keyboard: TelegramBot.InlineKeyboardButton[][] = episodes.map((ep, i) => [{
    text: `${startIdx + i}. ${ep.listened ? "✅" : "🔵"} ${truncate(ep.title, 30)}`,
    callback_data: `ep:${ep.id}`,
  }]);

  const navRow: TelegramBot.InlineKeyboardButton[] = [];
  if (page > 0)              navRow.push({ text: "◀️ Prev", callback_data: `tag_page:${tagId}:${page - 1}` });
  navRow.push({ text: `${page + 1}/${totalPages}`, callback_data: "noop" });
  if (page < totalPages - 1) navRow.push({ text: "Next ▶️", callback_data: `tag_page:${tagId}:${page + 1}` });
  keyboard.push(navRow);
  keyboard.push([{ text: "🗑 Delete Tag", callback_data: `tag_del:${tagId}` }, { text: "🏷 All Tags", callback_data: "cmd:tags" }]);
  keyboard.push(homeRow());

  await editMd(bot, chatId, msgId, fmt([
    `🏷 *${truncate(tag[0].name, 40)}*`, divider(),
    `${total} episode${total !== 1 ? "s" : ""} · Page ${page + 1} of ${totalPages}`,
    shortDivider(),
    ...episodes.map((ep, i) => `${startIdx + i}. ${ep.listened ? "✅" : "🔵"} ${truncate(ep.title, 42)}`),
  ]), { inline_keyboard: keyboard });
}

async function showTagPicker(
  bot: TelegramBot, chatId: number, msgId: number, epId: number
): Promise<void> {
  const tags = await db.select().from(tagsTable).where(eq(tagsTable.chatId, String(chatId))).orderBy(tagsTable.name);

  if (!tags.length) {
    await editMd(bot, chatId, msgId, fmt([
      "🏷 *No Tags Yet*", divider(), "Create a tag first.",
    ]), { inline_keyboard: [[{ text: "➕ Create Tag", callback_data: "tag_new" }], homeRow()] });
    return;
  }

  const epTags = await db.select({ tagId: episodeTagsTable.tagId })
    .from(episodeTagsTable).where(eq(episodeTagsTable.episodeId, epId));
  const epTagSet = new Set(epTags.map((r) => r.tagId));

  const keyboard: TelegramBot.InlineKeyboardButton[][] = tags.map((t) => [{
    text: `${epTagSet.has(t.id) ? "✅" : "🔲"} ${truncate(t.name, 30)}`,
    callback_data: `tag_toggle:${epId}:${t.id}`,
  }]);
  keyboard.push([{ text: "➕ Create New Tag", callback_data: "tag_new" }]);
  keyboard.push([{ text: "◀️ Back to Episode", callback_data: `ep:${epId}` }]);

  await editMd(bot, chatId, msgId, fmt([
    "🏷 *Add to Tag*", divider(),
    "✅ = already in tag  ·  🔲 = not in tag",
    "_Tap to toggle._",
  ]), { inline_keyboard: keyboard });
}

async function toggleEpisodeTag(
  bot: TelegramBot, chatId: number, msgId: number, epId: number, tagId: number
): Promise<void> {
  const existing = await db.select().from(episodeTagsTable)
    .where(and(eq(episodeTagsTable.episodeId, epId), eq(episodeTagsTable.tagId, tagId))).limit(1);

  if (existing.length) {
    await db.delete(episodeTagsTable).where(eq(episodeTagsTable.id, existing[0].id));
  } else {
    await db.insert(episodeTagsTable).values({ episodeId: epId, tagId });
  }
  // Refresh tag picker
  await showTagPicker(bot, chatId, msgId, epId);
}

async function deleteTag(
  bot: TelegramBot, chatId: number, msgId: number, tagId: number
): Promise<void> {
  const tag = await db.select().from(tagsTable).where(eq(tagsTable.id, tagId)).limit(1);
  if (!tag[0]) return;
  await db.delete(episodeTagsTable).where(eq(episodeTagsTable.tagId, tagId));
  await db.delete(tagsTable).where(eq(tagsTable.id, tagId));
  await editMd(bot, chatId, msgId, fmt([
    "🗑 *Tag Deleted*", divider(), `🏷 ${tag[0].name}`,
  ]), { inline_keyboard: [[{ text: "🏷 View Tags", callback_data: "cmd:tags" }], homeRow()] });
}

// ─── SEARCH ───────────────────────────────────────────────────────────────────

async function handleEpisodeSearch(bot: TelegramBot, chatId: number, query: string): Promise<void> {
  const feeds = await db.select({ id: feedsTable.id }).from(feedsTable).where(eq(feedsTable.chatId, String(chatId)));
  if (!feeds.length) {
    await sendMd(bot, chatId, "📭 No subscriptions. Subscribe first.", { reply_markup: { inline_keyboard: [homeRow()] } });
    return;
  }
  const arr     = sqlArr(feeds.map((f) => f.id));
  const results = await db.select().from(episodesTable)
    .where(and(sql`${episodesTable.feedId} = ANY(${arr})`, like(episodesTable.title, `%${query}%`)))
    .orderBy(desc(episodesTable.pubDate)).limit(15);

  if (!results.length) {
    await sendMd(bot, chatId, fmt([`🔎 *No Results for "${truncate(query, 30)}"*`, divider(), "Try a different keyword."]), { reply_markup: { inline_keyboard: [homeRow()] } });
    return;
  }

  const keyboard = results.map((ep, i) => [{ text: `${i + 1}. ${truncate(ep.title, 32)}`, callback_data: `ep:${ep.id}` }]);
  keyboard.push(homeRow());
  await sendMd(bot, chatId, fmt([
    `🔎 *"${truncate(query, 25)}" · ${results.length} results*`, divider(),
    ...results.map((ep, i) => `${i + 1}. ${ep.listened ? "✅" : "🔵"} ${truncate(ep.title, 42)}`),
  ]), { reply_markup: { inline_keyboard: keyboard } });
}

// ─── STATS ────────────────────────────────────────────────────────────────────

async function cmdStats(bot: TelegramBot, chatId: number, msgId?: number): Promise<void> {
  const feeds = await db.select({ id: feedsTable.id }).from(feedsTable).where(eq(feedsTable.chatId, String(chatId)));
  if (!feeds.length) {
    const text = fmt(["📭 *No Statistics Yet*", divider(), "Subscribe to a podcast to start."]);
    const kb   = { inline_keyboard: [homeRow()] };
    msgId ? await editMd(bot, chatId, msgId, text, kb) : await sendMd(bot, chatId, text, { reply_markup: kb });
    return;
  }

  const arr = sqlArr(feeds.map((f) => f.id));
  const [[{c:total}],[{c:listened}],[{c:favCount}],[{c:queueCount}],[{c:transcribed}],[{c:tagCount}]] =
    await Promise.all([
      db.select({c:count()}).from(episodesTable).where(sql`${episodesTable.feedId} = ANY(${arr})`),
      db.select({c:count()}).from(episodesTable).where(and(sql`${episodesTable.feedId} = ANY(${arr})`, eq(episodesTable.listened, true))),
      db.select({c:count()}).from(favoritesTable).where(eq(favoritesTable.chatId, String(chatId))),
      db.select({c:count()}).from(queueTable).where(eq(queueTable.chatId, String(chatId))),
      db.select({c:count()}).from(episodesTable).where(and(sql`${episodesTable.feedId} = ANY(${arr})`, sql`${episodesTable.transcript} IS NOT NULL`)),
      db.select({c:count()}).from(tagsTable).where(eq(tagsTable.chatId, String(chatId))),
    ]);

  const pct  = total > 0 ? Math.round((listened / total) * 100) : 0;
  const text = fmt([
    "📊 *Listening Statistics*", divider(),
    `📻 Subscriptions  · ${feeds.length}`,
    `🎙 Total Episodes  · ${total}`,
    `✅ Played          · ${listened}`,
    `🔵 Unplayed        · ${total - listened}`,
    `📝 Transcribed     · ${transcribed}`,
    "",
    `${progressBar(pct)} ${pct}%`,
    divider(),
    `❤️ Favourites  · ${favCount}`,
    `⏭ Queue        · ${queueCount}`,
    `🏷 Tags         · ${tagCount}`,
  ]);
  const kb = { inline_keyboard: [homeRow()] };
  msgId ? await editMd(bot, chatId, msgId, text, kb) : await sendMd(bot, chatId, text, { reply_markup: kb });
}

// ─── REFRESH ──────────────────────────────────────────────────────────────────

async function refreshSingleFeed(
  bot: TelegramBot, chatId: number, msgId: number, feedId: number
): Promise<void> {
  const feed = await db.select().from(feedsTable).where(eq(feedsTable.id, feedId)).limit(1);
  if (!feed[0]) return;
  await editMd(bot, chatId, msgId, fmt(["🔄 *Refreshing…*", divider(), `📻 ${truncate(feed[0].title, 40)}`]));
  try {
    const feedData = await fetchFeed(feed[0].url);
    let newCount = 0;
    for (const ep of feedData.episodes) {
      const exists = await db.select({id:episodesTable.id}).from(episodesTable)
        .where(and(eq(episodesTable.feedId, feedId), eq(episodesTable.guid, ep.guid))).limit(1);
      if (!exists.length) {
        await db.insert(episodesTable).values({ feedId, guid: ep.guid, title: ep.title, description: ep.description, audioUrl: ep.audioUrl, pubDate: ep.pubDate, duration: ep.duration });
        newCount++;
      }
    }
    await db.update(feedsTable).set({ lastChecked: new Date() }).where(eq(feedsTable.id, feedId));
    await editMd(bot, chatId, msgId, fmt([
      "✅ *Refreshed*", divider(), `📻 ${truncate(feed[0].title, 40)}`, `🆕 ${newCount} new episode${newCount !== 1 ? "s" : ""}`,
    ]), { inline_keyboard: [[{ text: "📻 Browse Feed", callback_data: `feed:${feedId}` }], homeRow()] });
  } catch (err: any) {
    await editMd(bot, chatId, msgId, fmt(["❌ *Refresh Failed*", divider(), truncate(String(err?.message ?? err), 80)]), { inline_keyboard: [homeRow()] });
  }
}

async function cmdRefreshAll(bot: TelegramBot, chatId: number, msgId?: number): Promise<void> {
  const feeds = await db.select().from(feedsTable).where(eq(feedsTable.chatId, String(chatId)));
  if (!feeds.length) {
    const text = fmt(["📭 *No Subscriptions to Refresh*"]);
    const kb   = { inline_keyboard: [homeRow()] };
    msgId ? await editMd(bot, chatId, msgId, text, kb) : await sendMd(bot, chatId, text, { reply_markup: kb });
    return;
  }

  const loadText = fmt([`🔄 *Refreshing ${feeds.length} Feed${feeds.length !== 1 ? "s" : ""}…*`, divider(), "⏳ Please wait…"]);
  let curId: number;
  if (msgId) { await editMd(bot, chatId, msgId, loadText); curId = msgId; }
  else       { const m = await sendMd(bot, chatId, loadText); curId = m.message_id; }

  let totalNew = 0;
  for (const feed of feeds) {
    try {
      const feedData = await fetchFeed(feed.url);
      for (const ep of feedData.episodes) {
        const exists = await db.select({id:episodesTable.id}).from(episodesTable)
          .where(and(eq(episodesTable.feedId, feed.id), eq(episodesTable.guid, ep.guid))).limit(1);
        if (!exists.length) {
          await db.insert(episodesTable).values({ feedId: feed.id, guid: ep.guid, title: ep.title, description: ep.description, audioUrl: ep.audioUrl, pubDate: ep.pubDate, duration: ep.duration });
          totalNew++;
        }
      }
      await db.update(feedsTable).set({ lastChecked: new Date() }).where(eq(feedsTable.id, feed.id));
    } catch { /* skip failed feeds */ }
  }

  await editMd(bot, chatId, curId, fmt([
    "✅ *All Feeds Refreshed*", divider(),
    `📻 ${feeds.length} subscription${feeds.length !== 1 ? "s" : ""}`,
    `🆕 ${totalNew} new episode${totalNew !== 1 ? "s" : ""} found`,
  ]), { inline_keyboard: [[{ text: "🆕 View Latest", callback_data: "cmd:latest" }], homeRow()] });
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

async function toggleFavourite(bot: TelegramBot, chatId: number, msgId: number, epId: number): Promise<void> {
  const ex = await db.select().from(favoritesTable)
    .where(and(eq(favoritesTable.chatId, String(chatId)), eq(favoritesTable.episodeId, epId))).limit(1);
  if (ex.length) await db.delete(favoritesTable).where(eq(favoritesTable.id, ex[0].id));
  else           await db.insert(favoritesTable).values({ chatId: String(chatId), episodeId: epId });
  await showEpisodeDetail(bot, chatId, msgId, epId);
}

async function addToQueue(bot: TelegramBot, chatId: number, msgId: number, epId: number): Promise<void> {
  const ex = await db.select().from(queueTable)
    .where(and(eq(queueTable.chatId, String(chatId)), eq(queueTable.episodeId, epId))).limit(1);
  if (!ex.length) {
    const [{m}] = await db.select({ m: sql<number>`COALESCE(MAX(${queueTable.position}), 0)` }).from(queueTable).where(eq(queueTable.chatId, String(chatId)));
    await db.insert(queueTable).values({ chatId: String(chatId), episodeId: epId, position: (m ?? 0) + 1 });
  }
  await showEpisodeDetail(bot, chatId, msgId, epId);
}

async function removeFromQueue(chatId: number, epId: number): Promise<void> {
  await db.delete(queueTable).where(and(eq(queueTable.chatId, String(chatId)), eq(queueTable.episodeId, epId)));
}

async function markListened(bot: TelegramBot, chatId: number, msgId: number, epId: number): Promise<void> {
  const ep = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;
  await db.update(episodesTable).set({ listened: !ep[0].listened, progress: !ep[0].listened ? 1 : 0 }).where(eq(episodesTable.id, epId));
  await showEpisodeDetail(bot, chatId, msgId, epId);
}

async function deleteFeed(bot: TelegramBot, chatId: number, msgId: number, feedId: number): Promise<void> {
  const feed = await db.select().from(feedsTable).where(eq(feedsTable.id, feedId)).limit(1);
  if (!feed[0]) return;
  const eps = await db.select({ id: episodesTable.id }).from(episodesTable).where(eq(episodesTable.feedId, feedId));
  for (const ep of eps) {
    await db.delete(favoritesTable).where(eq(favoritesTable.episodeId, ep.id));
    await db.delete(queueTable).where(eq(queueTable.episodeId, ep.id));
    await db.delete(episodeTagsTable).where(eq(episodeTagsTable.episodeId, ep.id));
  }
  await db.delete(episodesTable).where(eq(episodesTable.feedId, feedId));
  await db.delete(feedsTable).where(eq(feedsTable.id, feedId));
  await editMd(bot, chatId, msgId, fmt([
    "🗑 *Subscription Removed*", divider(), `📻 ${truncate(feed[0].title, 45)}`,
  ]), { inline_keyboard: [[{ text: "📻 My Feeds", callback_data: "cmd:feeds" }], homeRow()] });
}

// Split long text into Telegram-safe chunks
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

// Build a Postgres ANY() array literal for Drizzle
function sqlArr(ids: number[]): ReturnType<typeof sql> {
  return sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::int[]`;
}
