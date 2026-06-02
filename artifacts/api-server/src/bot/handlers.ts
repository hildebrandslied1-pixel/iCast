import TelegramBot from "node-telegram-bot-api";
import { db, feedsTable, episodesTable, favoritesTable, queueTable } from "@workspace/db";
import { eq, and, desc, like, count, sql } from "drizzle-orm";
import { fetchFeed } from "./rss.js";
import {
  fetchTopCharts, searchPodcasts, resolveRssFeed,
  getCountriesPage, totalCountryPages, findCountry,
  COUNTRIES_PAGE_SIZE,
} from "./discover.js";
import { generateTranscriptPdf } from "./pdf.js";
import { transcribeEpisodeFull, generateSummary, generateDetailedExplanation, hasWhisperKey, hasDeepseekKey } from "./ai.js";
import { sendEpisodeAudio } from "./downloader.js";
import {
  fmt, divider, shortDivider, truncate, episodeCard, feedCard,
  formatDate, parseDuration, formatDuration, progressBar,
} from "./formatter.js";

const PAGE_SIZE   = 5;
const CHART_PAGE  = 10;

type SessionAction =
  | "awaiting_rss"
  | "awaiting_search"
  | "awaiting_browse"
  | "awaiting_country_code";

const sessions = new Map<number, { action?: SessionAction }>();

function getSession(id: number) {
  if (!sessions.has(id)) sessions.set(id, {});
  return sessions.get(id)!;
}
function clearSession(id: number) { sessions.set(id, {}); }

// ── send helpers ─────────────────────────────────────────────────────────────
type Opts = TelegramBot.SendMessageOptions;
const sendMd = (bot: TelegramBot, chatId: number, text: string, opts?: Opts) =>
  bot.sendMessage(chatId, text, { parse_mode: "Markdown", ...opts });

const editMd = (
  bot: TelegramBot, chatId: number, msgId: number, text: string,
  keyboard?: TelegramBot.InlineKeyboardMarkup
) =>
  bot.editMessageText(text, {
    chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
    reply_markup: keyboard, disable_web_page_preview: true,
  });

const HOME_BTN: TelegramBot.InlineKeyboardButton = { text: "🏠 Home", callback_data: "menu" };

function homeRow(): TelegramBot.InlineKeyboardButton[] { return [HOME_BTN]; }

// ─── MAIN MENU ────────────────────────────────────────────────────────────────

function mainMenuText(): string {
  return fmt([
    "🎙 *Podcast Bot*",
    divider(),
    "Your personal podcast manager.",
    "Everything is a button — no commands to memorise.",
    divider(),
    "_Tap a button below to get started:_",
  ]);
}

function mainMenuKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "📻 My Feeds",       callback_data: "cmd:feeds" },
        { text: "🆕 Latest",          callback_data: "cmd:latest" },
      ],
      [
        { text: "🌍 Trending",        callback_data: "cmd:trending" },
        { text: "🌐 Browse iTunes",   callback_data: "cmd:browse" },
      ],
      [
        { text: "❤️ Favourites",      callback_data: "cmd:favourites" },
        { text: "⏭ Queue",            callback_data: "cmd:queue" },
      ],
      [
        { text: "📊 Stats",           callback_data: "cmd:stats" },
        { text: "🔄 Refresh All",     callback_data: "cmd:refresh" },
      ],
      [
        { text: "➕ Add RSS",         callback_data: "cmd:add" },
        { text: "🔎 Search Episodes", callback_data: "cmd:search" },
      ],
    ],
  };
}

// ─── REGISTER HANDLERS ────────────────────────────────────────────────────────

export function registerHandlers(bot: TelegramBot): void {
  const send = (chatId: number, text: string, opts?: Opts) =>
    sendMd(bot, chatId, text, opts);

  // ── Slash commands ─────────────────────────────────────────────────────────
  bot.onText(/\/start/, (msg) => { void sendMenu(bot, msg.chat.id); });
  bot.onText(/\/help/,  (msg) => { void sendMenu(bot, msg.chat.id); });
  bot.onText(/\/menu/,  (msg) => { void sendMenu(bot, msg.chat.id); });

  bot.onText(/\/feeds/,      (msg) => { void cmdFeeds(bot, msg.chat.id); });
  bot.onText(/\/latest/,     (msg) => { void cmdLatest(bot, msg.chat.id); });
  bot.onText(/\/queue/,      (msg) => { void cmdQueue(bot, msg.chat.id); });
  bot.onText(/\/favourites/, (msg) => { void cmdFavourites(bot, msg.chat.id); });
  bot.onText(/\/favorites/,  (msg) => { void cmdFavourites(bot, msg.chat.id); });
  bot.onText(/\/stats/,      (msg) => { void cmdStats(bot, msg.chat.id); });
  bot.onText(/\/refresh/,    (msg) => { void cmdRefreshAll(bot, msg.chat.id); });
  bot.onText(/\/trending/,   (msg) => { void showCountryPicker(bot, msg.chat.id, 0); });

  bot.onText(/\/add/, (msg) => {
    getSession(msg.chat.id).action = "awaiting_rss";
    void send(msg.chat.id, fmt([
      "📡 *Add a Podcast*",
      divider(),
      "Please send the RSS or Atom feed URL:",
      "",
      "_Example: https://feeds.example.com/podcast.xml_",
    ]), { reply_markup: { inline_keyboard: [homeRow()] } });
  });

  bot.onText(/\/search/, (msg) => {
    getSession(msg.chat.id).action = "awaiting_search";
    void send(msg.chat.id, fmt([
      "🔎 *Search Your Episodes*",
      divider(),
      "Enter a search keyword:",
    ]), { reply_markup: { inline_keyboard: [homeRow()] } });
  });

  bot.onText(/\/browse/, (msg) => {
    getSession(msg.chat.id).action = "awaiting_browse";
    void send(msg.chat.id, fmt([
      "🌐 *Browse iTunes Catalogue*",
      divider(),
      "Enter a keyword, show name, or topic:",
      "",
      "_Examples: true crime · technology · comedy_",
    ]), { reply_markup: { inline_keyboard: [homeRow()] } });
  });

  // ── Text messages ──────────────────────────────────────────────────────────
  bot.on("message", (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;
    const chatId = msg.chat.id;
    const text   = msg.text.trim();
    const sess   = getSession(chatId);

    if (sess.action === "awaiting_rss") {
      clearSession(chatId);
      void handleAddRss(bot, chatId, text);
    } else if (sess.action === "awaiting_search") {
      clearSession(chatId);
      void handleEpisodeSearch(bot, chatId, text);
    } else if (sess.action === "awaiting_browse") {
      clearSession(chatId);
      void handlePodcastSearch(bot, chatId, text);
    } else if (sess.action === "awaiting_country_code") {
      clearSession(chatId);
      const code = text.toLowerCase().replace(/[^a-z]/g, "");
      if (code.length === 2) {
        void showTopCharts(bot, chatId, 0, code);
      } else {
        void send(chatId, "❌ Please enter a valid 2-letter code (e.g. `us`, `de`, `sa`).");
      }
    } else if (text.startsWith("http")) {
      void handleAddRss(bot, chatId, text);
    } else {
      void sendMenu(bot, chatId);
    }
  });

  // ── Callback queries ───────────────────────────────────────────────────────
  bot.on("callback_query", (query) => {
    if (!query.message || !query.data) return;
    const chatId = query.message.chat.id;
    const msgId  = query.message.message_id;
    const data   = query.data;
    void bot.answerCallbackQuery(query.id);
    void routeCallback(bot, chatId, msgId, data);
  });
}

// ─── CALLBACK ROUTER ──────────────────────────────────────────────────────────

async function routeCallback(
  bot: TelegramBot, chatId: number, msgId: number, data: string
): Promise<void> {
  // noop guard
  if (data === "noop") return;

  // Main menu
  if (data === "menu") { await editMenu(bot, chatId, msgId); return; }

  // Slash-equivalent commands via buttons
  if (data.startsWith("cmd:")) {
    const cmd = data.slice(4);
    switch (cmd) {
      case "feeds":      await cmdFeeds(bot, chatId, msgId);      return;
      case "latest":     await cmdLatest(bot, chatId, msgId);     return;
      case "queue":      await cmdQueue(bot, chatId, msgId);      return;
      case "favourites": await cmdFavourites(bot, chatId, msgId); return;
      case "stats":      await cmdStats(bot, chatId, msgId);      return;
      case "refresh":    await cmdRefreshAll(bot, chatId, msgId); return;
      case "trending":
        await editMd(bot, chatId, msgId, mainMenuText());
        await showCountryPicker(bot, chatId, 0, msgId); return;
      case "add":
        getSession(chatId).action = "awaiting_rss";
        await editMd(bot, chatId, msgId, fmt([
          "📡 *Add a Podcast*", divider(),
          "Please send the RSS or Atom feed URL:",
          "_Example: https://feeds.example.com/podcast.xml_",
        ]), { inline_keyboard: [homeRow()] });
        return;
      case "search":
        getSession(chatId).action = "awaiting_search";
        await editMd(bot, chatId, msgId, fmt([
          "🔎 *Search Your Episodes*", divider(), "Enter a keyword:",
        ]), { inline_keyboard: [homeRow()] });
        return;
      case "browse":
        getSession(chatId).action = "awaiting_browse";
        await editMd(bot, chatId, msgId, fmt([
          "🌐 *Browse iTunes*", divider(),
          "Enter a show name or topic:",
          "_Examples: science · comedy · business_",
        ]), { inline_keyboard: [homeRow()] });
        return;
    }
  }

  // Feed browsing
  if (data.startsWith("feed:"))        { await showFeedEpisodes(bot, chatId, msgId, +data.split(":")[1], 0);            return; }
  if (data.startsWith("eplist:"))      { const [,f,p] = data.split(":").map(Number); await showFeedEpisodes(bot, chatId, msgId, f, p); return; }
  if (data.startsWith("ep:"))          { await showEpisodeDetail(bot, chatId, msgId, +data.split(":")[1]);               return; }
  if (data.startsWith("fav:"))         { await toggleFavourite(bot, chatId, msgId, +data.split(":")[1]);                 return; }
  if (data.startsWith("queue_add:"))   { await addToQueue(bot, chatId, msgId, +data.split(":")[1]);                      return; }
  if (data.startsWith("queue_rm:"))    { await removeFromQueue(bot, chatId, +data.split(":")[1]); await cmdQueue(bot, chatId, msgId); return; }
  if (data.startsWith("listened:"))    { await markListened(bot, chatId, msgId, +data.split(":")[1]);                    return; }
  if (data.startsWith("del_feed:"))    { await deleteFeed(bot, chatId, msgId, +data.split(":")[1]);                      return; }
  if (data.startsWith("refresh_feed:")) { await refreshSingleFeed(bot, chatId, msgId, +data.split(":")[1]);              return; }

  // Downloads & AI
  if (data.startsWith("download:"))   { void handleDownload(bot, chatId, +data.split(":")[1]);           return; }
  if (data.startsWith("ai_summary:")) { void handleAiSummary(bot, chatId, +data.split(":")[1]);          return; }
  if (data.startsWith("ai_detail:"))  { void handleAiDetail(bot, chatId, +data.split(":")[1]);           return; }
  if (data.startsWith("transcript:")) { void handleTranscriptPdf(bot, chatId, +data.split(":")[1]);      return; }

  // Discovery
  if (data.startsWith("country_page:"))  { const [,p,inl] = data.split(":"); await showCountryPicker(bot, chatId, +p, inl === "1" ? msgId : undefined); return; }
  if (data === "country_type")            {
    getSession(chatId).action = "awaiting_country_code";
    await editMd(bot, chatId, msgId, fmt([
      "🔤 *Enter Country Code*", divider(),
      "Type any 2-letter country code:",
      "_Examples: `us` · `gb` · `sa` · `de` · `jp`_",
    ]), { inline_keyboard: [homeRow()] });
    return;
  }
  if (data.startsWith("trend_c:")) {
    const [,country,page] = data.split(":");
    await showTopCharts(bot, chatId, +(page ?? 0), country, msgId);
    return;
  }
  if (data.startsWith("charts_page:")) {
    const [,country,page] = data.split(":");
    await showTopCharts(bot, chatId, +page, country, msgId);
    return;
  }
  if (data.startsWith("disc_sub:")) {
    const parts = data.split(":");
    await subscribeFromDiscovery(bot, chatId, msgId, parts[1], decodeURIComponent(parts.slice(2).join(":")));
    return;
  }
}

// ─── MENU ─────────────────────────────────────────────────────────────────────

async function sendMenu(bot: TelegramBot, chatId: number) {
  await sendMd(bot, chatId, mainMenuText(), { reply_markup: mainMenuKeyboard() });
}

async function editMenu(bot: TelegramBot, chatId: number, msgId: number) {
  await editMd(bot, chatId, msgId, mainMenuText(), mainMenuKeyboard());
}

// ─── COUNTRY PICKER ───────────────────────────────────────────────────────────

async function showCountryPicker(
  bot: TelegramBot, chatId: number, page: number, msgId?: number
) {
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
  if (page > 0)              nav.push({ text: "◀️ Prev", callback_data: `country_page:${page - 1}` });
  nav.push({ text: `${page + 1}/${totalPages}`, callback_data: "noop" });
  if (page < totalPages - 1) nav.push({ text: "Next ▶️", callback_data: `country_page:${page + 1}` });
  rows.push(nav);
  rows.push([{ text: "🔤 Enter Any Country Code", callback_data: "country_type" }]);
  rows.push(homeRow());

  const text = fmt([
    "🌍 *Trending Podcasts*", divider(),
    `Choose a country · Page ${page + 1} of ${totalPages}`,
  ]);

  if (msgId) {
    await editMd(bot, chatId, msgId, text, { inline_keyboard: rows });
  } else {
    await sendMd(bot, chatId, text, { reply_markup: { inline_keyboard: rows } });
  }
}

// ─── TOP CHARTS ───────────────────────────────────────────────────────────────

async function showTopCharts(
  bot: TelegramBot, chatId: number, page: number, country: string, msgId?: number
) {
  const countryName = findCountry(country) ?? country.toUpperCase();

  const loadingText = fmt(["⏳ *Loading Charts…*", divider(), `🌍 ${countryName}`]);

  if (msgId) {
    await editMd(bot, chatId, msgId, loadingText);
  } else {
    const m = await sendMd(bot, chatId, loadingText);
    msgId   = m.message_id;
  }

  try {
    const all        = await fetchTopCharts(country, 100);
    const totalPages = Math.max(1, Math.ceil(all.length / CHART_PAGE));
    const slice      = all.slice(page * CHART_PAGE, (page + 1) * CHART_PAGE);
    const startIdx   = page * CHART_PAGE + 1;

    const lines = [
      `🏆 *Top Podcasts · ${countryName}*`,
      divider(),
      `Page ${page + 1} of ${totalPages}`,
      shortDivider(),
      ...slice.map((p, i) =>
        `${startIdx + i}. *${truncate(p.name, 36)}*\n    _${truncate(p.artist, 32)}_`
      ),
      divider(),
      "_Tap a podcast to subscribe._",
    ];

    const keyboard: TelegramBot.InlineKeyboardButton[][] = slice.map((p, i) => [{
      text: `${startIdx + i}. ${truncate(p.name, 34)}`,
      callback_data: `disc_sub:${p.id}:${encodeURIComponent(p.name.slice(0, 36))}`,
    }]);

    const navRow: TelegramBot.InlineKeyboardButton[] = [];
    if (page > 0)              navRow.push({ text: "◀️ Prev", callback_data: `charts_page:${country}:${page - 1}` });
    if (page < totalPages - 1) navRow.push({ text: "Next ▶️", callback_data: `charts_page:${country}:${page + 1}` });
    if (navRow.length)         keyboard.push(navRow);

    keyboard.push([{ text: "🌍 Change Country", callback_data: "country_page:0" }]);
    keyboard.push(homeRow());

    await editMd(bot, chatId, msgId, lines.join("\n"), { inline_keyboard: keyboard });
  } catch (err: any) {
    await editMd(bot, chatId, msgId, fmt([
      "❌ *Charts Unavailable*", divider(),
      truncate(String(err?.message ?? err), 150),
      "", "Please try a different country.",
    ]), {
      inline_keyboard: [
        [{ text: "🌍 Try Another Country", callback_data: "country_page:0" }],
        homeRow(),
      ],
    });
  }
}

// ─── PODCAST SEARCH (iTunes) ──────────────────────────────────────────────────

async function handlePodcastSearch(bot: TelegramBot, chatId: number, query: string) {
  const loadMsg = await sendMd(bot, chatId, fmt([
    "🔍 *Searching iTunes…*", divider(),
    `"${truncate(query, 40)}"`,
  ]));

  try {
    const results = await searchPodcasts(query, "us", 20);

    if (!results.length) {
      await editMd(bot, chatId, loadMsg.message_id, fmt([
        `🔍 *No Results*`, divider(), `No podcasts found for "${truncate(query, 30)}".`,
      ]), { inline_keyboard: [homeRow()] });
      return;
    }

    const keyboard: TelegramBot.InlineKeyboardButton[][] = results.map((p, i) => [{
      text: `${i + 1}. ${truncate(p.name, 34)}`,
      callback_data: `disc_sub:${p.id}:${encodeURIComponent(p.name.slice(0, 36))}`,
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
    await editMd(bot, chatId, loadMsg.message_id, fmt([
      "❌ *Search Failed*", divider(),
      truncate(String(err?.message ?? err), 100),
    ]), { inline_keyboard: [homeRow()] });
  }
}

// ─── SUBSCRIBE FROM DISCOVERY ─────────────────────────────────────────────────

async function subscribeFromDiscovery(
  bot: TelegramBot, chatId: number, msgId: number, itunesId: string, name: string
) {
  await editMd(bot, chatId, msgId, fmt([
    "⏳ *Resolving Feed…*", divider(), `📻 ${name}`,
  ]));

  try {
    const rssUrl = await resolveRssFeed(itunesId);
    if (!rssUrl) {
      await editMd(bot, chatId, msgId, fmt([
        "❌ *RSS Feed Not Found*", divider(), `📻 ${name}`, "",
        "Apple Podcasts did not provide an RSS URL.",
        "Try adding it manually via ➕ Add RSS.",
      ]), { inline_keyboard: [homeRow()] });
      return;
    }

    const existing = await db.select().from(feedsTable)
      .where(and(eq(feedsTable.chatId, String(chatId)), eq(feedsTable.url, rssUrl))).limit(1);

    if (existing.length) {
      await editMd(bot, chatId, msgId, fmt([
        "⚠️ *Already Subscribed*", divider(), `📻 ${name}`, "", "Use 📻 My Feeds to browse it.",
      ]), { inline_keyboard: [[{ text: "📻 My Feeds", callback_data: "cmd:feeds" }], homeRow()] });
      return;
    }

    await editMd(bot, chatId, msgId, fmt([
      "⏳ *Fetching Episodes…*", divider(), `📻 ${name}`, "",
      "_This may take a moment for large feeds._",
    ]));

    const feedData = await fetchFeed(rssUrl);
    const [feed]   = await db.insert(feedsTable).values({
      chatId: String(chatId), url: rssUrl, title: feedData.title || name, lastChecked: new Date(),
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
      `📻 *${truncate(feedData.title || name, 45)}*`,
      `🎙 ${feedData.episodes.length} episode${feedData.episodes.length !== 1 ? "s" : ""} loaded`,
    ]), { inline_keyboard: [
      [{ text: "📻 Browse Feed", callback_data: `feed:${feed.id}` }],
      homeRow(),
    ]});
  } catch (err: any) {
    await editMd(bot, chatId, msgId, fmt([
      "❌ *Subscription Failed*", divider(),
      truncate(String(err?.message ?? err), 120),
      "", "Try adding manually via ➕ Add RSS.",
    ]), { inline_keyboard: [homeRow()] });
  }
}

// ─── ADD VIA RSS ──────────────────────────────────────────────────────────────

async function handleAddRss(bot: TelegramBot, chatId: number, url: string) {
  if (!url.startsWith("http")) {
    await sendMd(bot, chatId, "❌ URL must begin with `http` or `https`.", {
      reply_markup: { inline_keyboard: [homeRow()] },
    });
    return;
  }

  const loadMsg = await sendMd(bot, chatId, fmt([
    "⏳ *Fetching Feed…*", divider(), `📡 ${truncate(url, 42)}`,
  ]));

  try {
    const feedData = await fetchFeed(url);

    const existing = await db.select().from(feedsTable)
      .where(and(eq(feedsTable.chatId, String(chatId)), eq(feedsTable.url, url))).limit(1);

    if (existing.length) {
      await editMd(bot, chatId, loadMsg.message_id, fmt([
        "⚠️ *Already Subscribed*", divider(),
        `📻 ${truncate(feedData.title, 45)}`,
      ]), { inline_keyboard: [[{ text: "📻 Browse Feed", callback_data: `feed:${existing[0].id}` }], homeRow()] });
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
    ]), { inline_keyboard: [
      [{ text: "📻 Browse Feed", callback_data: `feed:${feed.id}` }],
      homeRow(),
    ]});
  } catch (err: any) {
    await editMd(bot, chatId, loadMsg.message_id, fmt([
      "❌ *Feed Could Not Be Loaded*", divider(),
      "Please verify the URL is a valid RSS or Atom feed.",
      "", `_${truncate(String(err?.message ?? err), 80)}_`,
    ]), { inline_keyboard: [homeRow()] });
  }
}

// ─── FEEDS ────────────────────────────────────────────────────────────────────

async function cmdFeeds(bot: TelegramBot, chatId: number, msgId?: number) {
  const feeds = await db.select().from(feedsTable)
    .where(eq(feedsTable.chatId, String(chatId)))
    .orderBy(feedsTable.createdAt);

  if (!feeds.length) {
    const text    = fmt(["📭 *No Subscriptions Yet*", divider(), "Use ➕ Add RSS or 🌍 Trending to subscribe."]);
    const kb: TelegramBot.InlineKeyboardMarkup = { inline_keyboard: [
      [{ text: "➕ Add RSS", callback_data: "cmd:add" }, { text: "🌍 Trending", callback_data: "cmd:trending" }],
      [{ text: "🌐 Browse iTunes", callback_data: "cmd:browse" }],
      homeRow(),
    ]};
    msgId ? await editMd(bot, chatId, msgId, text, kb) : await sendMd(bot, chatId, text, { reply_markup: kb });
    return;
  }

  const epCounts = await Promise.all(
    feeds.map((f) => db.select({ c: count() }).from(episodesTable).where(eq(episodesTable.feedId, f.id)))
  );

  const lines = feeds.map((f, i) => feedCard({
    index: i + 1, title: f.title, url: f.url,
    episodeCount: epCounts[i][0].c, lastChecked: f.lastChecked,
  }));

  const keyboard: TelegramBot.InlineKeyboardButton[][] = feeds.map((f, i) => [{
    text: `${i + 1}. ${truncate(f.title, 30)}`,
    callback_data: `feed:${f.id}`,
  }]);
  keyboard.push(homeRow());

  const text = fmt([
    `📻 *My Subscriptions · ${feeds.length}*`, divider(),
    ...lines, divider(), "_Tap a podcast to browse its episodes._",
  ]);

  msgId ? await editMd(bot, chatId, msgId, text, { inline_keyboard: keyboard })
        : await sendMd(bot, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}

async function showFeedEpisodes(
  bot: TelegramBot, chatId: number, msgId: number, feedId: number, page: number
) {
  const feed = await db.select().from(feedsTable).where(eq(feedsTable.id, feedId)).limit(1);
  if (!feed[0]) return;

  const [{ c: totalCount }] = await db.select({ c: count() }).from(episodesTable)
    .where(eq(episodesTable.feedId, feedId));

  const episodes = await db.select().from(episodesTable)
    .where(eq(episodesTable.feedId, feedId))
    .orderBy(desc(episodesTable.pubDate))
    .limit(PAGE_SIZE)
    .offset(page * PAGE_SIZE);

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

async function showEpisodeDetail(bot: TelegramBot, chatId: number, msgId: number, epId: number) {
  const ep = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;

  const [feed, favRows, queueRows] = await Promise.all([
    db.select().from(feedsTable).where(eq(feedsTable.id, ep[0].feedId)).limit(1),
    db.select().from(favoritesTable)
      .where(and(eq(favoritesTable.chatId, String(chatId)), eq(favoritesTable.episodeId, epId))).limit(1),
    db.select().from(queueTable)
      .where(and(eq(queueTable.chatId, String(chatId)), eq(queueTable.episodeId, epId))).limit(1),
  ]);

  const isFav    = favRows.length > 0;
  const inQueue  = queueRows.length > 0;
  const audioUrl = ep[0].audioUrl ?? "";
  const hasAudio = Boolean(audioUrl);
  const hasTranscript = Boolean(ep[0].transcript);

  const card = episodeCard({
    title: ep[0].title, feedTitle: feed[0]?.title,
    pubDate: ep[0].pubDate, duration: ep[0].duration,
    listened: ep[0].listened ?? false, progress: ep[0].progress ?? 0,
    isFav, inQueue,
  });

  const desc = ep[0].description
    ? "\n" + divider() + "\n" + truncate(ep[0].description.replace(/<[^>]+>/g, ""), 200)
    : "";

  // Transcript status badge
  const transcriptBadge = hasTranscript ? "✅ Transcript Ready" : hasWhisperKey() ? "📝 Transcript Available" : "🔑 Transcript (API key needed)";

  const keyboard: TelegramBot.InlineKeyboardButton[][] = [];

  // Row 1: Favourite + Queue
  keyboard.push([
    { text: isFav ? "💔 Unfavourite" : "❤️ Favourite", callback_data: `fav:${epId}` },
    { text: inQueue ? "✅ In Queue" : "⏭ Add to Queue", callback_data: `queue_add:${epId}` },
  ]);

  // Row 2: Mark played
  keyboard.push([
    { text: ep[0].listened ? "🔄 Mark Unplayed" : "✅ Mark Played", callback_data: `listened:${epId}` },
  ]);

  // Row 3: Download (forces Telegram download + auto-transcript)
  if (hasAudio) {
    keyboard.push([
      { text: "📥 Download Episode", callback_data: `download:${epId}` },
    ]);
  }

  // Row 4: AI features (enabled when transcript exists or Whisper/DeepSeek available)
  const aiRow: TelegramBot.InlineKeyboardButton[] = [];
  if (hasWhisperKey() || hasTranscript) {
    aiRow.push({ text: transcriptBadge, callback_data: hasWhisperKey() ? `transcript:${epId}` : "noop" });
  }
  if (aiRow.length) keyboard.push(aiRow);

  if (hasTranscript && hasDeepseekKey()) {
    keyboard.push([
      { text: "💡 Summary",            callback_data: `ai_summary:${epId}` },
      { text: "📚 Detailed Breakdown", callback_data: `ai_detail:${epId}` },
    ]);
  } else if (!hasTranscript && (hasWhisperKey() && hasDeepseekKey())) {
    keyboard.push([
      { text: "💡 Summary (after transcript)", callback_data: `ai_summary:${epId}` },
    ]);
  }

  // Row last: PDF + Back
  keyboard.push([
    { text: "📄 Transcript PDF", callback_data: `transcript:${epId}` },
    { text: "◀️ Back",           callback_data: `feed:${ep[0].feedId}` },
  ]);
  keyboard.push(homeRow());

  await editMd(bot, chatId, msgId, card + desc, { inline_keyboard: keyboard });
}

// ─── DOWNLOAD + AUTO-TRANSCRIPT ───────────────────────────────────────────────

async function handleDownload(bot: TelegramBot, chatId: number, epId: number) {
  const ep = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]?.audioUrl) {
    await sendMd(bot, chatId, "❌ This episode has no audio URL.", { reply_markup: { inline_keyboard: [homeRow()] } });
    return;
  }

  const feed = await db.select().from(feedsTable).where(eq(feedsTable.id, ep[0].feedId)).limit(1);
  const feedTitle  = feed[0]?.title ?? "Podcast";
  const episodeTitle = ep[0].title;

  // ── Step 1: Transcription (mandatory, runs first) ──────────────────────────
  const statusMsg = await sendMd(bot, chatId, fmt([
    "📥 *Starting Download*", divider(),
    `🎙 *${truncate(episodeTitle, 50)}*`, "",
    hasWhisperKey() && !ep[0].transcript
      ? "📝 Transcribing first (this is required)…"
      : ep[0].transcript
      ? "✅ Transcript already exists — proceeding to download…"
      : "⚠️ No Whisper key — skipping transcript…",
  ]));

  let transcript = ep[0].transcript ?? null;

  if (!transcript && hasWhisperKey()) {
    try {
      transcript = await transcribeEpisodeFull(ep[0].audioUrl, {
        onProgress: async (msg) => {
          await bot.editMessageText(fmt([
            "📥 *Downloading Episode*", divider(),
            `🎙 *${truncate(episodeTitle, 50)}*`,
            "", msg,
          ]), { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" });
        },
      });

      // Save transcript to DB
      await db.update(episodesTable)
        .set({ transcript, transcriptAt: new Date() })
        .where(eq(episodesTable.id, epId));
    } catch (err: any) {
      // Log but continue — transcript failure should not block download
      await bot.editMessageText(fmt([
        "📥 *Downloading Episode*", divider(),
        `🎙 *${truncate(episodeTitle, 50)}*`, "",
        `⚠️ Transcript failed: ${truncate(String(err?.message ?? err), 80)}`,
        "Continuing with download…",
      ]), { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" });
    }
  }

  // ── Step 2: Send audio file ────────────────────────────────────────────────
  try {
    await sendEpisodeAudio({
      chatId, episodeTitle, feedTitle, audioUrl: ep[0].audioUrl, episodeId: epId,
      onProgress: async (text) => {
        await bot.editMessageText(fmt([
          "📥 *Sending to Telegram*", divider(),
          `🎙 *${truncate(episodeTitle, 50)}*`, "", text,
        ]), { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" });
        return undefined;
      },
    });

    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {/* ignore */});
  } catch (err: any) {
    await bot.editMessageText(fmt([
      "❌ *Upload to Telegram Failed*", divider(),
      truncate(String(err?.message ?? err), 100),
      "", "The file may be inaccessible. Try using the direct URL instead.",
    ]), { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [
            [{ text: "🔗 Open Audio URL", url: ep[0].audioUrl }],
            homeRow(),
          ]},
    });
  }

  // ── Step 3: Send AI summary if transcript + DeepSeek available ────────────
  if (transcript && hasDeepseekKey()) {
    try {
      const summary = await generateSummary(transcript, feedTitle, episodeTitle);
      const chunks  = splitLong(summary, 3800);
      for (const chunk of chunks) {
        await sendMd(bot, chatId, fmt([
          "💡 *Episode Summary*", divider(),
          `🎙 *${truncate(episodeTitle, 48)}*`,
          divider(), chunk,
        ]), { reply_markup: { inline_keyboard: [
          [{ text: "📚 Full Breakdown", callback_data: `ai_detail:${epId}` }],
          homeRow(),
        ]}});
      }
    } catch {
      /* Summary is bonus — do not show error */
    }
  }
}

// ─── AI: SUMMARY ──────────────────────────────────────────────────────────────

async function handleAiSummary(bot: TelegramBot, chatId: number, epId: number) {
  const ep   = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;
  const feed = await db.select().from(feedsTable).where(eq(feedsTable.id, ep[0].feedId)).limit(1);

  if (!hasDeepseekKey()) {
    await sendMd(bot, chatId, fmt([
      "🔑 *DeepSeek API Key Required*", divider(),
      "Add `DEEPSEEK_API_KEY` in Secrets to enable AI summaries.",
    ]), { reply_markup: { inline_keyboard: [homeRow()] } });
    return;
  }

  // Auto-transcribe if no transcript yet
  let transcript = ep[0].transcript;
  if (!transcript) {
    if (!hasWhisperKey()) {
      await sendMd(bot, chatId, fmt([
        "🔑 *OpenAI API Key Required*", divider(),
        "Add `OPENAI_API_KEY` in Secrets to enable Whisper transcription.",
      ]), { reply_markup: { inline_keyboard: [homeRow()] } });
      return;
    }
    if (!ep[0].audioUrl) {
      await sendMd(bot, chatId, "❌ No audio URL for this episode.", { reply_markup: { inline_keyboard: [homeRow()] } });
      return;
    }
    const statusMsg = await sendMd(bot, chatId, fmt([
      "⏳ *Transcribing Episode…*", divider(),
      `🎙 ${truncate(ep[0].title, 50)}`, "",
      "_Required for AI summary. Please wait…_",
    ]));

    try {
      transcript = await transcribeEpisodeFull(ep[0].audioUrl, {
        onProgress: async (msg) => {
          await bot.editMessageText(fmt([
            "⏳ *Transcribing…*", divider(),
            `🎙 ${truncate(ep[0].title, 50)}`, "", msg,
          ]), { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" });
        },
      });
      await db.update(episodesTable).set({ transcript, transcriptAt: new Date() }).where(eq(episodesTable.id, epId));
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {/* ignore */});
    } catch (err: any) {
      await editMd(bot, chatId, statusMsg.message_id, fmt([
        "❌ *Transcription Failed*", divider(),
        truncate(String(err?.message ?? err), 100),
      ]), { inline_keyboard: [homeRow()] });
      return;
    }
  }

  const genMsg = await sendMd(bot, chatId, fmt([
    "💡 *Generating Summary…*", divider(),
    `🎙 ${truncate(ep[0].title, 50)}`,
  ]));

  try {
    const summary = await generateSummary(transcript, feed[0]?.title ?? "Podcast", ep[0].title);
    await bot.deleteMessage(chatId, genMsg.message_id).catch(() => {/* ignore */});

    const chunks = splitLong(summary, 3800);
    for (const chunk of chunks) {
      await sendMd(bot, chatId, fmt([
        "💡 *Episode Summary*", divider(),
        `🎙 *${truncate(ep[0].title, 48)}*`,
        `📻 ${truncate(feed[0]?.title ?? "", 36)}`,
        divider(), chunk,
      ]), { reply_markup: { inline_keyboard: [
        [{ text: "📚 Full Breakdown", callback_data: `ai_detail:${epId}` }],
        [{ text: "📄 Transcript PDF", callback_data: `transcript:${epId}` }],
        homeRow(),
      ]}});
    }
  } catch (err: any) {
    await editMd(bot, chatId, genMsg.message_id, fmt([
      "❌ *Summary Failed*", divider(),
      truncate(String(err?.message ?? err), 100),
    ]), { inline_keyboard: [homeRow()] });
  }
}

// ─── AI: DETAILED BREAKDOWN ───────────────────────────────────────────────────

async function handleAiDetail(bot: TelegramBot, chatId: number, epId: number) {
  const ep   = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;
  const feed = await db.select().from(feedsTable).where(eq(feedsTable.id, ep[0].feedId)).limit(1);

  if (!hasDeepseekKey()) {
    await sendMd(bot, chatId, fmt([
      "🔑 *DeepSeek API Key Required*", divider(),
      "Add `DEEPSEEK_API_KEY` to Secrets.",
    ]), { reply_markup: { inline_keyboard: [homeRow()] } });
    return;
  }

  let transcript = ep[0].transcript;
  if (!transcript) {
    if (!hasWhisperKey() || !ep[0].audioUrl) {
      await sendMd(bot, chatId, fmt([
        "⚠️ *Transcript Required*", divider(),
        "Please download the episode first — transcription is automatic.",
      ]), { reply_markup: { inline_keyboard: [
        [{ text: "📥 Download Episode", callback_data: `download:${epId}` }],
        homeRow(),
      ]}});
      return;
    }

    const statusMsg = await sendMd(bot, chatId, fmt([
      "⏳ *Transcribing Episode…*", divider(),
      `🎙 ${truncate(ep[0].title, 50)}`,
    ]));

    try {
      transcript = await transcribeEpisodeFull(ep[0].audioUrl, {
        onProgress: async (msg) => {
          await bot.editMessageText(fmt([
            "⏳ *Transcribing…*", divider(),
            `🎙 ${truncate(ep[0].title, 50)}`, "", msg,
          ]), { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" });
        },
      });
      await db.update(episodesTable).set({ transcript, transcriptAt: new Date() }).where(eq(episodesTable.id, epId));
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {/* ignore */});
    } catch (err: any) {
      await editMd(bot, chatId, statusMsg.message_id, fmt([
        "❌ *Transcription Failed*", divider(),
        truncate(String(err?.message ?? err), 100),
      ]), { inline_keyboard: [homeRow()] });
      return;
    }
  }

  const genMsg = await sendMd(bot, chatId, fmt([
    "📚 *Generating Detailed Breakdown…*", divider(),
    `🎙 ${truncate(ep[0].title, 50)}`,
    "_This is a deep analysis — please wait…_",
  ]));

  try {
    const detail = await generateDetailedExplanation(transcript, feed[0]?.title ?? "Podcast", ep[0].title);
    await bot.deleteMessage(chatId, genMsg.message_id).catch(() => {/* ignore */});

    const chunks = splitLong(detail, 3800);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      await sendMd(bot, chatId, fmt([
        `📚 *Detailed Breakdown${chunks.length > 1 ? ` · Part ${i + 1}/${chunks.length}` : ""}*`,
        divider(),
        `🎙 *${truncate(ep[0].title, 48)}*`,
        `📻 ${truncate(feed[0]?.title ?? "", 36)}`,
        divider(), chunks[i],
      ]), isLast ? { reply_markup: { inline_keyboard: [
        [{ text: "💡 Summary",        callback_data: `ai_summary:${epId}` }],
        [{ text: "📄 Transcript PDF", callback_data: `transcript:${epId}` }],
        homeRow(),
      ]}} : undefined);
    }
  } catch (err: any) {
    await editMd(bot, chatId, genMsg.message_id, fmt([
      "❌ *Analysis Failed*", divider(),
      truncate(String(err?.message ?? err), 100),
    ]), { inline_keyboard: [homeRow()] });
  }
}

// ─── TRANSCRIPT PDF ───────────────────────────────────────────────────────────

async function handleTranscriptPdf(bot: TelegramBot, chatId: number, epId: number) {
  const ep   = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;
  const feed = await db.select().from(feedsTable).where(eq(feedsTable.id, ep[0].feedId)).limit(1);

  if (!hasWhisperKey()) {
    await sendMd(bot, chatId, fmt([
      "🔑 *OpenAI API Key Required*", divider(),
      "Add `OPENAI_API_KEY` to Secrets for Whisper transcription.",
    ]), { reply_markup: { inline_keyboard: [homeRow()] } });
    return;
  }

  if (!ep[0].audioUrl) {
    await sendMd(bot, chatId, "❌ No audio URL for this episode.", { reply_markup: { inline_keyboard: [homeRow()] } });
    return;
  }

  const statusMsg = await sendMd(bot, chatId, fmt([
    "📄 *Generating Transcript PDF…*", divider(),
    `🎙 ${truncate(ep[0].title, 50)}`,
    "_Transcribing audio — please wait…_",
  ]));

  try {
    // Transcribe if not cached
    let transcript = ep[0].transcript;
    if (!transcript) {
      transcript = await transcribeEpisodeFull(ep[0].audioUrl, {
        onProgress: async (msg) => {
          await bot.editMessageText(fmt([
            "📄 *Generating Transcript PDF…*", divider(),
            `🎙 ${truncate(ep[0].title, 50)}`, "", msg,
          ]), { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" });
        },
      });
      await db.update(episodesTable).set({ transcript, transcriptAt: new Date() })
        .where(eq(episodesTable.id, epId));
    }

    await bot.editMessageText(fmt([
      "📄 *Building PDF…*", divider(),
      `🎙 ${truncate(ep[0].title, 50)}`,
    ]), { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" });

    const pdfBuf = await generateTranscriptPdf({
      podcastTitle: feed[0]?.title ?? "Podcast",
      episodeTitle: ep[0].title,
      pubDate: ep[0].pubDate,
      duration: ep[0].duration,
      transcript,
    });

    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {/* ignore */});

    await bot.sendDocument(chatId, pdfBuf as any, {
      caption: fmt([
        "📄 *Transcript*", divider(),
        `🎙 ${truncate(ep[0].title, 50)}`,
        `📻 ${truncate(feed[0]?.title ?? "", 40)}`,
      ]),
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [
        [{ text: "💡 Summary",  callback_data: `ai_summary:${epId}` }],
        homeRow(),
      ]},
    }, { filename: `transcript_ep${epId}.pdf`, contentType: "application/pdf" });
  } catch (err: any) {
    await editMd(bot, chatId, statusMsg.message_id, fmt([
      "❌ *Transcript PDF Failed*", divider(),
      truncate(String(err?.message ?? err), 100),
    ]), { inline_keyboard: [homeRow()] });
  }
}

// ─── LATEST ───────────────────────────────────────────────────────────────────

async function cmdLatest(bot: TelegramBot, chatId: number, msgId?: number) {
  const feeds = await db.select({ id: feedsTable.id }).from(feedsTable)
    .where(eq(feedsTable.chatId, String(chatId)));

  if (!feeds.length) {
    const text = fmt(["📭 *No Subscriptions Yet*", divider(), "Add a podcast to see latest episodes."]);
    const kb   = { inline_keyboard: [[{ text: "➕ Add RSS", callback_data: "cmd:add" }], homeRow()] };
    msgId ? await editMd(bot, chatId, msgId, text, kb)
          : await sendMd(bot, chatId, text, { reply_markup: kb });
    return;
  }

  const feedIds = feeds.map((f) => f.id);
  const arr = sql`ARRAY[${sql.join(feedIds.map((id) => sql`${id}`), sql`, `)}]::int[]`;

  const episodes = await db.select().from(episodesTable)
    .where(sql`${episodesTable.feedId} = ANY(${arr})`)
    .orderBy(desc(episodesTable.pubDate))
    .limit(10);

  if (!episodes.length) {
    const text = fmt(["📭 *No Episodes Found*", "/refresh to check for new ones."]);
    const kb   = { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: "cmd:refresh" }], homeRow()] };
    msgId ? await editMd(bot, chatId, msgId, text, kb)
          : await sendMd(bot, chatId, text, { reply_markup: kb });
    return;
  }

  const allFeeds = await db.select().from(feedsTable).where(eq(feedsTable.chatId, String(chatId)));
  const feedMap  = new Map(allFeeds.map((f) => [f.id, f.title]));

  const keyboard: TelegramBot.InlineKeyboardButton[][] = episodes.map((ep, i) => [{
    text: `${i + 1}. ${ep.listened ? "✅" : "🔵"} ${truncate(ep.title, 30)}`,
    callback_data: `ep:${ep.id}`,
  }]);
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

async function cmdQueue(bot: TelegramBot, chatId: number, msgId?: number) {
  const queue = await db.select({
    episodeId: queueTable.episodeId, position: queueTable.position,
    title: episodesTable.title, listened: episodesTable.listened,
  })
    .from(queueTable)
    .innerJoin(episodesTable, eq(queueTable.episodeId, episodesTable.id))
    .where(eq(queueTable.chatId, String(chatId)))
    .orderBy(queueTable.position);

  const text = queue.length
    ? fmt([
        `⏭ *Queue · ${queue.length}*`, divider(),
        ...queue.map((q, i) => `${i + 1}. ${q.listened ? "✅" : "🔵"} ${truncate(q.title, 42)}`),
      ])
    : fmt(["📭 *Queue is Empty*", divider(), "Add episodes from Latest or Feeds."]);

  const keyboard: TelegramBot.InlineKeyboardButton[][] = queue.map((q, i) => [
    { text: `${i + 1}. ${q.listened ? "✅" : "🔵"} ${truncate(q.title, 25)}`, callback_data: `ep:${q.episodeId}` },
    { text: "🗑", callback_data: `queue_rm:${q.episodeId}` },
  ]);
  keyboard.push(homeRow());

  msgId ? await editMd(bot, chatId, msgId, text, { inline_keyboard: keyboard })
        : await sendMd(bot, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}

// ─── FAVOURITES ───────────────────────────────────────────────────────────────

async function cmdFavourites(bot: TelegramBot, chatId: number, msgId?: number) {
  const favs = await db.select({
    episodeId: episodesTable.id, title: episodesTable.title, listened: episodesTable.listened,
  })
    .from(favoritesTable)
    .innerJoin(episodesTable, eq(favoritesTable.episodeId, episodesTable.id))
    .where(eq(favoritesTable.chatId, String(chatId)))
    .orderBy(desc(favoritesTable.createdAt))
    .limit(20);

  const text = favs.length
    ? fmt([
        `❤️ *Favourites · ${favs.length}*`, divider(),
        ...favs.map((f, i) => `${i + 1}. ${f.listened ? "✅" : "🔵"} ${truncate(f.title, 42)}`),
      ])
    : fmt(["📭 *No Favourites Yet*", divider(), "Tap ❤️ on any episode to save it here."]);

  const keyboard: TelegramBot.InlineKeyboardButton[][] = favs.map((f, i) => [{
    text: `${i + 1}. ${f.listened ? "✅" : "🔵"} ${truncate(f.title, 30)}`,
    callback_data: `ep:${f.episodeId}`,
  }]);
  keyboard.push(homeRow());

  msgId ? await editMd(bot, chatId, msgId, text, { inline_keyboard: keyboard })
        : await sendMd(bot, chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}

// ─── EPISODE SEARCH ───────────────────────────────────────────────────────────

async function handleEpisodeSearch(bot: TelegramBot, chatId: number, query: string) {
  const feeds = await db.select({ id: feedsTable.id }).from(feedsTable)
    .where(eq(feedsTable.chatId, String(chatId)));

  if (!feeds.length) {
    await sendMd(bot, chatId, "📭 No subscriptions found. Please subscribe first.", {
      reply_markup: { inline_keyboard: [homeRow()] },
    });
    return;
  }

  const feedIds = feeds.map((f) => f.id);
  const arr = sql`ARRAY[${sql.join(feedIds.map((id) => sql`${id}`), sql`, `)}]::int[]`;

  const results = await db.select().from(episodesTable)
    .where(and(
      sql`${episodesTable.feedId} = ANY(${arr})`,
      like(episodesTable.title, `%${query}%`)
    ))
    .orderBy(desc(episodesTable.pubDate))
    .limit(15);

  if (!results.length) {
    await sendMd(bot, chatId, fmt([
      `🔍 *No Results for "${truncate(query, 30)}"*`, divider(), "Try a different keyword.",
    ]), { reply_markup: { inline_keyboard: [homeRow()] } });
    return;
  }

  const keyboard: TelegramBot.InlineKeyboardButton[][] = results.map((ep, i) => [{
    text: `${i + 1}. ${truncate(ep.title, 32)}`, callback_data: `ep:${ep.id}`,
  }]);
  keyboard.push(homeRow());

  await sendMd(bot, chatId, fmt([
    `🔍 *"${truncate(query, 25)}" · ${results.length} results*`, divider(),
    ...results.map((ep, i) => `${i + 1}. ${ep.listened ? "✅" : "🔵"} ${truncate(ep.title, 42)}`),
  ]), { reply_markup: { inline_keyboard: keyboard } });
}

// ─── STATS ────────────────────────────────────────────────────────────────────

async function cmdStats(bot: TelegramBot, chatId: number, msgId?: number) {
  const feeds = await db.select({ id: feedsTable.id }).from(feedsTable)
    .where(eq(feedsTable.chatId, String(chatId)));

  if (!feeds.length) {
    const text = fmt(["📭 *No Statistics Yet*", divider(), "Subscribe to a podcast to start."]);
    const kb   = { inline_keyboard: [homeRow()] };
    msgId ? await editMd(bot, chatId, msgId, text, kb)
          : await sendMd(bot, chatId, text, { reply_markup: kb });
    return;
  }

  const feedIds = feeds.map((f) => f.id);
  const arr = sql`ARRAY[${sql.join(feedIds.map((id) => sql`${id}`), sql`, `)}]::int[]`;

  const [[{c: total}],[{c: listened}],[{c: favCount}],[{c: queueCount}],[{c: transcribed}]] =
    await Promise.all([
      db.select({ c: count() }).from(episodesTable).where(sql`${episodesTable.feedId} = ANY(${arr})`),
      db.select({ c: count() }).from(episodesTable).where(and(sql`${episodesTable.feedId} = ANY(${arr})`, eq(episodesTable.listened, true))),
      db.select({ c: count() }).from(favoritesTable).where(eq(favoritesTable.chatId, String(chatId))),
      db.select({ c: count() }).from(queueTable).where(eq(queueTable.chatId, String(chatId))),
      db.select({ c: count() }).from(episodesTable).where(and(sql`${episodesTable.feedId} = ANY(${arr})`, sql`${episodesTable.transcript} IS NOT NULL`)),
    ]);

  const pct = total > 0 ? Math.round((listened / total) * 100) : 0;

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
  ]);

  const kb = { inline_keyboard: [homeRow()] };
  msgId ? await editMd(bot, chatId, msgId, text, kb)
        : await sendMd(bot, chatId, text, { reply_markup: kb });
}

// ─── REFRESH ──────────────────────────────────────────────────────────────────

async function refreshSingleFeed(bot: TelegramBot, chatId: number, msgId: number, feedId: number) {
  const feed = await db.select().from(feedsTable).where(eq(feedsTable.id, feedId)).limit(1);
  if (!feed[0]) return;

  await editMd(bot, chatId, msgId, fmt([
    "🔄 *Refreshing…*", divider(), `📻 ${truncate(feed[0].title, 40)}`,
  ]));

  try {
    const feedData = await fetchFeed(feed[0].url);
    let newCount = 0;

    for (const ep of feedData.episodes) {
      const exists = await db.select({ id: episodesTable.id }).from(episodesTable)
        .where(and(eq(episodesTable.feedId, feedId), eq(episodesTable.guid, ep.guid))).limit(1);
      if (!exists.length) {
        await db.insert(episodesTable).values({
          feedId, guid: ep.guid, title: ep.title, description: ep.description,
          audioUrl: ep.audioUrl, pubDate: ep.pubDate, duration: ep.duration,
        });
        newCount++;
      }
    }

    await db.update(feedsTable).set({ lastChecked: new Date() }).where(eq(feedsTable.id, feedId));

    await editMd(bot, chatId, msgId, fmt([
      "✅ *Refreshed*", divider(),
      `📻 ${truncate(feed[0].title, 40)}`,
      `🆕 ${newCount} new episode${newCount !== 1 ? "s" : ""}`,
    ]), { inline_keyboard: [
      [{ text: "📻 Browse Feed", callback_data: `feed:${feedId}` }],
      homeRow(),
    ]});
  } catch (err: any) {
    await editMd(bot, chatId, msgId, fmt([
      "❌ *Refresh Failed*", divider(),
      truncate(String(err?.message ?? err), 80),
    ]), { inline_keyboard: [homeRow()] });
  }
}

async function cmdRefreshAll(bot: TelegramBot, chatId: number, msgId?: number) {
  const feeds = await db.select().from(feedsTable).where(eq(feedsTable.chatId, String(chatId)));

  if (!feeds.length) {
    const text = fmt(["📭 *No Subscriptions to Refresh*"]);
    const kb   = { inline_keyboard: [homeRow()] };
    msgId ? await editMd(bot, chatId, msgId, text, kb)
          : await sendMd(bot, chatId, text, { reply_markup: kb });
    return;
  }

  const loadText = fmt([
    `🔄 *Refreshing ${feeds.length} Feed${feeds.length !== 1 ? "s" : ""}…*`,
    divider(), "⏳ Please wait…",
  ]);

  let currentMsgId: number;
  if (msgId) {
    await editMd(bot, chatId, msgId, loadText);
    currentMsgId = msgId;
  } else {
    const m = await sendMd(bot, chatId, loadText);
    currentMsgId = m.message_id;
  }

  let totalNew = 0;
  for (const feed of feeds) {
    try {
      const feedData = await fetchFeed(feed.url);
      for (const ep of feedData.episodes) {
        const exists = await db.select({ id: episodesTable.id }).from(episodesTable)
          .where(and(eq(episodesTable.feedId, feed.id), eq(episodesTable.guid, ep.guid))).limit(1);
        if (!exists.length) {
          await db.insert(episodesTable).values({
            feedId: feed.id, guid: ep.guid, title: ep.title, description: ep.description,
            audioUrl: ep.audioUrl, pubDate: ep.pubDate, duration: ep.duration,
          });
          totalNew++;
        }
      }
      await db.update(feedsTable).set({ lastChecked: new Date() }).where(eq(feedsTable.id, feed.id));
    } catch { /* skip failed feeds silently */ }
  }

  await editMd(bot, chatId, currentMsgId, fmt([
    "✅ *All Feeds Refreshed*", divider(),
    `📻 ${feeds.length} subscription${feeds.length !== 1 ? "s" : ""}`,
    `🆕 ${totalNew} new episode${totalNew !== 1 ? "s" : ""} found`,
  ]), { inline_keyboard: [
    [{ text: "🆕 View Latest", callback_data: "cmd:latest" }],
    homeRow(),
  ]});
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

async function toggleFavourite(bot: TelegramBot, chatId: number, msgId: number, epId: number) {
  const existing = await db.select().from(favoritesTable)
    .where(and(eq(favoritesTable.chatId, String(chatId)), eq(favoritesTable.episodeId, epId))).limit(1);
  if (existing.length) {
    await db.delete(favoritesTable).where(eq(favoritesTable.id, existing[0].id));
  } else {
    await db.insert(favoritesTable).values({ chatId: String(chatId), episodeId: epId });
  }
  await showEpisodeDetail(bot, chatId, msgId, epId);
}

async function addToQueue(bot: TelegramBot, chatId: number, msgId: number, epId: number) {
  const existing = await db.select().from(queueTable)
    .where(and(eq(queueTable.chatId, String(chatId)), eq(queueTable.episodeId, epId))).limit(1);
  if (!existing.length) {
    const [{ m }] = await db.select({ m: sql<number>`COALESCE(MAX(${queueTable.position}), 0)` })
      .from(queueTable).where(eq(queueTable.chatId, String(chatId)));
    await db.insert(queueTable).values({ chatId: String(chatId), episodeId: epId, position: (m ?? 0) + 1 });
  }
  await showEpisodeDetail(bot, chatId, msgId, epId);
}

async function removeFromQueue(bot: TelegramBot, chatId: number, epId: number) {
  await db.delete(queueTable)
    .where(and(eq(queueTable.chatId, String(chatId)), eq(queueTable.episodeId, epId)));
}

async function markListened(bot: TelegramBot, chatId: number, msgId: number, epId: number) {
  const ep = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;
  await db.update(episodesTable)
    .set({ listened: !ep[0].listened, progress: !ep[0].listened ? 1 : 0 })
    .where(eq(episodesTable.id, epId));
  await showEpisodeDetail(bot, chatId, msgId, epId);
}

async function deleteFeed(bot: TelegramBot, chatId: number, msgId: number, feedId: number) {
  const feed = await db.select().from(feedsTable).where(eq(feedsTable.id, feedId)).limit(1);
  if (!feed[0]) return;

  const eps = await db.select({ id: episodesTable.id }).from(episodesTable)
    .where(eq(episodesTable.feedId, feedId));

  for (const ep of eps) {
    await db.delete(favoritesTable).where(eq(favoritesTable.episodeId, ep.id));
    await db.delete(queueTable).where(eq(queueTable.episodeId, ep.id));
  }
  await db.delete(episodesTable).where(eq(episodesTable.feedId, feedId));
  await db.delete(feedsTable).where(eq(feedsTable.id, feedId));

  await editMd(bot, chatId, msgId, fmt([
    "🗑 *Subscription Removed*", divider(),
    `📻 ${truncate(feed[0].title, 45)}`,
  ]), { inline_keyboard: [
    [{ text: "📻 My Feeds", callback_data: "cmd:feeds" }],
    homeRow(),
  ]});
}

// Split text into Telegram-safe chunks (≤ 4096 chars)
function splitLong(text: string, max = 4000): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf("\n\n", max);
    if (cut < max * 0.6) cut = remaining.lastIndexOf("\n", max);
    if (cut < 1) cut = max;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
