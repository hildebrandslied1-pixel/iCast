import TelegramBot from "node-telegram-bot-api";
import { db, feedsTable, episodesTable, favoritesTable, queueTable } from "@workspace/db";
import { eq, and, desc, like, count, sql } from "drizzle-orm";
import { fetchFeed } from "./rss.js";
import {
  fetchTopCharts, searchPodcasts, resolveRssFeed,
  ALL_COUNTRIES, getCountriesPage, totalCountryPages, findCountry,
  COUNTRIES_PAGE_SIZE, type DiscoveredPodcast,
} from "./discover.js";
import { generateTranscriptPdf } from "./pdf.js";
import {
  fmt, divider, shortDivider, truncate, episodeCard, feedCard,
  welcomeMsg, formatDate, parseDuration, formatDuration, progressBar,
} from "./formatter.js";

const PAGE_SIZE = 5;

type SessionState = {
  action?: "awaiting_rss" | "awaiting_search" | "awaiting_browse" | "awaiting_country_code";
  browseCountry?: string;
};

const sessions = new Map<number, SessionState>();

function getSession(chatId: number): SessionState {
  if (!sessions.has(chatId)) sessions.set(chatId, {});
  return sessions.get(chatId)!;
}

function clearSession(chatId: number) {
  sessions.set(chatId, {});
}

export function registerHandlers(bot: TelegramBot) {
  const send = (chatId: number, text: string, opts?: TelegramBot.SendMessageOptions) =>
    bot.sendMessage(chatId, text, { parse_mode: "Markdown", ...opts });

  // ─── /start & /help ───────────────────────────────────────────────────────
  bot.onText(/\/start/, async (msg) => { await send(msg.chat.id, welcomeMsg()); });
  bot.onText(/\/help/,  async (msg) => { await send(msg.chat.id, welcomeMsg()); });

  // ─── /add ─────────────────────────────────────────────────────────────────
  bot.onText(/\/add/, async (msg) => {
    const chatId = msg.chat.id;
    getSession(chatId).action = "awaiting_rss";
    await send(chatId, fmt([
      "📡 *Add a Podcast*",
      divider(),
      "Please send the RSS or Atom feed URL:",
      "",
      "_Example: https://feeds.example.com/podcast.xml_",
    ]));
  });

  // ─── /feeds ───────────────────────────────────────────────────────────────
  bot.onText(/\/feeds/,      async (msg) => { await showFeeds(bot, msg.chat.id); });
  bot.onText(/\/latest/,     async (msg) => { await showLatest(bot, msg.chat.id); });
  bot.onText(/\/queue/,      async (msg) => { await showQueue(bot, msg.chat.id); });
  bot.onText(/\/favourites/, async (msg) => { await showFavourites(bot, msg.chat.id); });
  bot.onText(/\/favorites/,  async (msg) => { await showFavourites(bot, msg.chat.id); });
  bot.onText(/\/stats/,      async (msg) => { await showStats(bot, msg.chat.id); });
  bot.onText(/\/refresh/,    async (msg) => { await refreshAllFeeds(bot, msg.chat.id); });

  // ─── /search ──────────────────────────────────────────────────────────────
  bot.onText(/\/search/, async (msg) => {
    const chatId = msg.chat.id;
    getSession(chatId).action = "awaiting_search";
    await send(chatId, fmt([
      "🔍 *Search Your Episodes*",
      divider(),
      "Please enter your search query:",
    ]));
  });

  // ─── /browse ──────────────────────────────────────────────────────────────
  bot.onText(/\/browse/, async (msg) => {
    const chatId = msg.chat.id;
    getSession(chatId).action = "awaiting_browse";
    await send(chatId, fmt([
      "🌐 *Browse All Podcasts*",
      divider(),
      "Search the entire iTunes catalogue.",
      "Enter any keyword, show name, or topic:",
      "",
      "_Examples: true crime · business · comedy_",
    ]));
  });

  // ─── /trending ────────────────────────────────────────────────────────────
  bot.onText(/\/trending/, async (msg) => {
    await showCountryPicker(bot, msg.chat.id, 0, false);
  });

  // ─── Text messages ────────────────────────────────────────────────────────
  bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const session = getSession(chatId);

    if (session.action === "awaiting_rss") {
      clearSession(chatId);
      await handleAddRss(bot, chatId, text);
    } else if (session.action === "awaiting_search") {
      clearSession(chatId);
      await handleEpisodeSearch(bot, chatId, text);
    } else if (session.action === "awaiting_browse") {
      clearSession(chatId);
      await handlePodcastSearch(bot, chatId, text, "us");
    } else if (session.action === "awaiting_country_code") {
      clearSession(chatId);
      const code = text.toLowerCase().trim().replace(/[^a-z]/g, "");
      if (code.length === 2) {
        await showTopCharts(bot, chatId, 0, code, false);
      } else {
        await send(chatId, "❌ Please enter a valid 2-letter country code (e.g. `us`, `de`, `jp`).");
      }
    } else if (text.startsWith("http")) {
      await handleAddRss(bot, chatId, text);
    } else {
      await send(chatId, fmt([
        "🤔 I beg your pardon, I didn't quite follow that.",
        "Type /help to view all available commands.",
      ]));
    }
  });

  // ─── Callbacks ────────────────────────────────────────────────────────────
  bot.on("callback_query", async (query) => {
    if (!query.message || !query.data) return;
    const chatId  = query.message.chat.id;
    const msgId   = query.message.message_id;
    const data    = query.data;

    await bot.answerCallbackQuery(query.id);

    // Subscribed feed/episode navigation
    if      (data.startsWith("feed:"))         { await showFeedEpisodes(bot, chatId, msgId, +data.split(":")[1], 0); }
    else if (data.startsWith("eplist:"))        { const [,f,p] = data.split(":").map(Number); await showFeedEpisodes(bot, chatId, msgId, f, p); }
    else if (data.startsWith("ep:"))            { await showEpisodeDetail(bot, chatId, msgId, +data.split(":")[1]); }
    else if (data.startsWith("fav:"))           { await toggleFavourite(bot, chatId, msgId, +data.split(":")[1]); }
    else if (data.startsWith("queue_add:"))     { await addToQueue(bot, chatId, msgId, +data.split(":")[1]); }
    else if (data.startsWith("queue_rm:"))      { await removeFromQueue(bot, chatId, +data.split(":")[1]); await showQueue(bot, chatId); }
    else if (data.startsWith("listened:"))      { await markListened(bot, chatId, msgId, +data.split(":")[1]); }
    else if (data.startsWith("del_feed:"))      { await deleteFeed(bot, chatId, msgId, +data.split(":")[1]); }
    else if (data.startsWith("refresh_feed:"))  { await refreshFeed(bot, chatId, msgId, +data.split(":")[1]); }
    else if (data.startsWith("transcript:"))    { await doTranscript(bot, chatId, +data.split(":")[1]); }
    else if (data === "back_feeds")             { await showFeedsInline(bot, chatId, msgId); }

    // Browse & trending
    else if (data.startsWith("country_page:")) {
      const [, page, inline] = data.split(":");
      await showCountryPicker(bot, chatId, +page, inline === "1", msgId);
    }
    else if (data === "country_type") {
      getSession(chatId).action = "awaiting_country_code";
      await bot.editMessageText(fmt([
        "🔤 *Enter Country Code*",
        divider(),
        "Please type a 2-letter country code:",
        "",
        "_Examples: `us` · `gb` · `de` · `jp` · `br`_",
      ]), { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" });
    }
    else if (data.startsWith("trend_c:")) {
      const [, country, page, inline] = data.split(":");
      await showTopCharts(bot, chatId, +(page ?? 0), country, inline === "1", msgId);
    }
    else if (data.startsWith("charts_page:")) {
      const [, country, page] = data.split(":");
      await showTopCharts(bot, chatId, +page, country, true, msgId);
    }
    else if (data.startsWith("disc_sub:")) {
      const parts = data.split(":");
      const itunesId = parts[1];
      const name = decodeURIComponent(parts.slice(2).join(":"));
      await subscribeFromDiscovery(bot, chatId, msgId, itunesId, name);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// COUNTRY PICKER  (paginated · all 60+ countries · type-in option)
// ═══════════════════════════════════════════════════════════════════════════

async function showCountryPicker(
  bot: TelegramBot, chatId: number, page: number,
  inline: boolean, msgId?: number
) {
  const entries = getCountriesPage(page);
  const totalPages = totalCountryPages();

  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  for (let i = 0; i < entries.length; i += 2) {
    const row: TelegramBot.InlineKeyboardButton[] = [
      { text: entries[i][1], callback_data: `trend_c:${entries[i][0]}:0:${inline ? 1 : 0}` },
    ];
    if (entries[i + 1]) {
      row.push({ text: entries[i + 1][1], callback_data: `trend_c:${entries[i + 1][0]}:0:${inline ? 1 : 0}` });
    }
    rows.push(row);
  }

  const nav: TelegramBot.InlineKeyboardButton[] = [];
  if (page > 0)           nav.push({ text: "◀️ Prev", callback_data: `country_page:${page - 1}:${inline ? 1 : 0}` });
  nav.push({ text: `${page + 1}/${totalPages}`, callback_data: "noop" });
  if (page < totalPages - 1) nav.push({ text: "Next ▶️", callback_data: `country_page:${page + 1}:${inline ? 1 : 0}` });
  rows.push(nav);
  rows.push([{ text: "🔤 Enter Any Country Code", callback_data: "country_type" }]);

  const text = fmt([
    "🌍 *Trending Charts*",
    divider(),
    `Select a country · Page ${page + 1} of ${totalPages}`,
  ]);

  if (inline && msgId) {
    await bot.editMessageText(text, {
      chat_id: chatId, message_id: msgId,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: rows },
    });
  } else {
    await bot.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: rows },
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TOP CHARTS  (paginated · 5 per page)
// ═══════════════════════════════════════════════════════════════════════════

async function showTopCharts(
  bot: TelegramBot, chatId: number, page: number,
  country: string, inline: boolean, msgId?: number
) {
  const countryName = findCountry(country) ?? country.toUpperCase();
  const CHART_PAGE = 10;

  const edit = async (text: string, keyboard?: TelegramBot.InlineKeyboardMarkup) => {
    if (inline && msgId) {
      await bot.editMessageText(text, {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: keyboard, disable_web_page_preview: true,
      });
    } else {
      const m = await bot.sendMessage(chatId, text, {
        parse_mode: "Markdown", reply_markup: keyboard,
        disable_web_page_preview: true,
      });
      // make subsequent calls treat it as inline
      inline = true;
      msgId  = m.message_id;
    }
  };

  await edit(fmt([
    `⏳ *Loading Charts…*`,
    divider(),
    `🌍 ${countryName}`,
  ]));

  try {
    const all = await fetchTopCharts(country, 100);
    const totalPages = Math.ceil(all.length / CHART_PAGE);
    const slice = all.slice(page * CHART_PAGE, (page + 1) * CHART_PAGE);
    const startIdx = page * CHART_PAGE + 1;

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
    if (navRow.length) keyboard.push(navRow);

    keyboard.push([{ text: "🌍 Change Country", callback_data: "country_page:0:1" }]);

    await edit(lines.join("\n"), { inline_keyboard: keyboard });
  } catch (err: any) {
    await edit(fmt([
      "❌ *Charts Unavailable*",
      divider(),
      `Could not retrieve charts for ${countryName}.`,
      "",
      `_${truncate(String(err?.message ?? err), 80)}_`,
      "",
      "Try a different country or use /browse to search.",
    ]), {
      inline_keyboard: [
        [{ text: "🌍 Try Another Country", callback_data: "country_page:0:1" }],
        [{ text: "🔍 Browse Instead", callback_data: "noop" }],
      ],
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PODCAST SEARCH  (/browse · iTunes catalogue)
// ═══════════════════════════════════════════════════════════════════════════

async function handlePodcastSearch(
  bot: TelegramBot, chatId: number, query: string, country: string
) {
  const send = (t: string, o?: TelegramBot.SendMessageOptions) =>
    bot.sendMessage(chatId, t, { parse_mode: "Markdown", ...o });

  const loadMsg = await send(fmt([
    `🔍 *Searching iTunes…*`,
    divider(),
    `"${truncate(query, 40)}"`,
  ]));

  try {
    const results = await searchPodcasts(query, country, 20);

    if (!results.length) {
      await bot.editMessageText(fmt([
        `🔍 *No Results for "${truncate(query, 30)}"*`,
        divider(),
        "Try a different keyword.",
      ]), { chat_id: chatId, message_id: loadMsg.message_id, parse_mode: "Markdown" });
      return;
    }

    const lines = [
      `🌐 *"${truncate(query, 28)}" · ${results.length} podcasts*`,
      divider(),
      ...results.map((p, i) =>
        `${i + 1}. *${truncate(p.name, 36)}*\n    _${truncate(p.artist, 30)}_`
      ),
      divider(),
      "_Tap to subscribe._",
    ];

    const keyboard: TelegramBot.InlineKeyboardButton[][] = results.map((p, i) => [{
      text: `${i + 1}. ${truncate(p.name, 34)}`,
      callback_data: `disc_sub:${p.id}:${encodeURIComponent(p.name.slice(0, 36))}`,
    }]);

    await bot.editMessageText(lines.join("\n"), {
      chat_id: chatId,
      message_id: loadMsg.message_id,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard },
    });
  } catch (err: any) {
    await bot.editMessageText(fmt([
      "❌ *Search Failed*",
      divider(),
      `_${truncate(String(err?.message ?? err), 80)}_`,
    ]), { chat_id: chatId, message_id: loadMsg.message_id, parse_mode: "Markdown" });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SUBSCRIBE FROM DISCOVERY
// ═══════════════════════════════════════════════════════════════════════════

async function subscribeFromDiscovery(
  bot: TelegramBot, chatId: number, msgId: number, itunesId: string, name: string
) {
  await bot.editMessageText(fmt([
    "⏳ *Resolving Feed…*",
    divider(),
    `📻 ${name}`,
  ]), { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" });

  try {
    const rssUrl = await resolveRssFeed(itunesId);
    if (!rssUrl) {
      await bot.editMessageText(fmt([
        "❌ *RSS Feed Not Found*",
        divider(),
        `📻 ${name}`,
        "",
        "Apple Podcasts did not return an RSS URL.",
        "Try adding it manually via /add.",
      ]), { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" });
      return;
    }

    // Already subscribed?
    const existing = await db.select().from(feedsTable)
      .where(and(eq(feedsTable.chatId, String(chatId)), eq(feedsTable.url, rssUrl)))
      .limit(1);

    if (existing.length > 0) {
      await bot.editMessageText(fmt([
        "⚠️ *Already Subscribed*",
        divider(),
        `📻 ${name}`,
        "",
        "You are already subscribed to this podcast.",
        "Use /feeds to browse it.",
      ]), { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" });
      return;
    }

    // Fetch all episodes (no arbitrary cap)
    const feedData = await fetchFeed(rssUrl);
    const [feed] = await db.insert(feedsTable).values({
      chatId: String(chatId),
      url: rssUrl,
      title: feedData.title || name,
      lastChecked: new Date(),
    }).returning();

    if (feedData.episodes.length > 0) {
      // Insert in chunks to avoid query size limits
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

    await bot.editMessageText(fmt([
      "✅ *Subscription Added*",
      divider(),
      `📻 *${truncate(feedData.title || name, 45)}*`,
      `🎙 ${feedData.episodes.length} episode${feedData.episodes.length === 1 ? "" : "s"} loaded`,
      "",
      "Use /feeds to browse · /latest for newest episodes",
    ]), { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" });

  } catch (err: any) {
    await bot.editMessageText(fmt([
      "❌ *Subscription Failed*",
      divider(),
      `_${truncate(String(err?.message ?? err), 80)}_`,
      "",
      "Try adding manually via /add.",
    ]), { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ADD VIA RSS
// ═══════════════════════════════════════════════════════════════════════════

async function handleAddRss(bot: TelegramBot, chatId: number, url: string) {
  const send = (t: string, o?: TelegramBot.SendMessageOptions) =>
    bot.sendMessage(chatId, t, { parse_mode: "Markdown", ...o });

  if (!url.startsWith("http")) {
    await send("❌ That URL does not appear to be valid. It must begin with http or https.");
    return;
  }

  const loadMsg = await send(fmt([
    "⏳ *Fetching Podcast Feed…*",
    divider(),
    `📡 ${truncate(url, 40)}`,
  ]));

  try {
    const feedData = await fetchFeed(url);

    const existing = await db.select().from(feedsTable)
      .where(and(eq(feedsTable.chatId, String(chatId)), eq(feedsTable.url, url)))
      .limit(1);

    if (existing.length > 0) {
      await bot.editMessageText(fmt([
        "⚠️ *Already Subscribed*",
        divider(),
        `📻 ${truncate(feedData.title, 45)}`,
        "",
        "You are already subscribed to this podcast.",
      ]), { chat_id: chatId, message_id: loadMsg.message_id, parse_mode: "Markdown" });
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

    await bot.editMessageText(fmt([
      "✅ *Subscription Added*",
      divider(),
      `📻 *${truncate(feedData.title, 45)}*`,
      `🎙 ${feedData.episodes.length} episode${feedData.episodes.length === 1 ? "" : "s"} loaded`,
      "",
      "Use /feeds to browse · /latest for newest episodes",
    ]), { chat_id: chatId, message_id: loadMsg.message_id, parse_mode: "Markdown" });

  } catch (err: any) {
    await bot.editMessageText(fmt([
      "❌ *Feed Could Not Be Loaded*",
      divider(),
      "Please verify the URL is a valid RSS or Atom feed.",
      "",
      `_Error: ${truncate(String(err?.message ?? err), 80)}_`,
    ]), { chat_id: chatId, message_id: loadMsg.message_id, parse_mode: "Markdown" });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FEEDS
// ═══════════════════════════════════════════════════════════════════════════

async function showFeeds(bot: TelegramBot, chatId: number) {
  const feeds = await db.select().from(feedsTable)
    .where(eq(feedsTable.chatId, String(chatId)))
    .orderBy(feedsTable.createdAt);

  if (feeds.length === 0) {
    await bot.sendMessage(chatId, fmt([
      "📭 *No Subscriptions Yet*",
      divider(),
      "/add — Subscribe via RSS URL",
      "/browse — Search the iTunes catalogue",
      "/trending — Discover by country charts",
    ]), { parse_mode: "Markdown" });
    return;
  }

  const epCounts = await Promise.all(
    feeds.map((f) => db.select({ c: count() }).from(episodesTable).where(eq(episodesTable.feedId, f.id)))
  );

  const lines = feeds.map((f, i) =>
    feedCard({ index: i + 1, title: f.title, url: f.url, episodeCount: epCounts[i][0].c, lastChecked: f.lastChecked })
  );

  const keyboard = feeds.map((f, i) => [{
    text: `${i + 1}. ${truncate(f.title, 30)}`,
    callback_data: `feed:${f.id}`,
  }]);

  await bot.sendMessage(chatId, fmt([
    `📻 *Your Subscriptions · ${feeds.length}*`,
    divider(),
    ...lines,
    divider(),
    "_Tap a podcast to browse its episodes._",
  ]), { parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } });
}

async function showFeedsInline(bot: TelegramBot, chatId: number, msgId: number) {
  const feeds = await db.select().from(feedsTable)
    .where(eq(feedsTable.chatId, String(chatId)))
    .orderBy(feedsTable.createdAt);

  if (feeds.length === 0) {
    await bot.editMessageText(fmt([
      "📭 *No Subscriptions Yet*",
      "/add — Subscribe via RSS URL",
    ]), { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" });
    return;
  }

  const keyboard = feeds.map((f, i) => [{
    text: `${i + 1}. ${truncate(f.title, 30)}`,
    callback_data: `feed:${f.id}`,
  }]);

  await bot.editMessageText(fmt([
    `📻 *Your Subscriptions · ${feeds.length}*`,
    divider(),
    ...feeds.map((f, i) => `${i + 1}. ${truncate(f.title, 42)}`),
    divider(),
    "_Tap a podcast to browse its episodes._",
  ]), {
    chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard },
  });
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
  navRow.push({ text: `${page + 1} / ${totalPages}`, callback_data: "noop" });
  if (page < totalPages - 1) navRow.push({ text: "Next ▶️", callback_data: `eplist:${feedId}:${page + 1}` });
  keyboard.push(navRow);

  keyboard.push([
    { text: "🔄 Refresh",  callback_data: `refresh_feed:${feedId}` },
    { text: "🗑 Remove",   callback_data: `del_feed:${feedId}` },
    { text: "◀️ Back",     callback_data: "back_feeds" },
  ]);

  await bot.editMessageText(fmt([
    `📻 *${truncate(feed[0].title, 40)}*`,
    divider(),
    `🎙 ${totalCount} episode${totalCount === 1 ? "" : "s"} · Page ${page + 1} of ${totalPages}`,
    shortDivider(),
    ...episodes.map((ep, i) =>
      `${startIdx + i}. ${ep.listened ? "✅" : "🔵"} ${truncate(ep.title, 42)}`
    ),
    divider(),
    "_Tap an episode for details._",
  ]), {
    chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// EPISODE DETAIL  (with Play + Download URL buttons)
// ═══════════════════════════════════════════════════════════════════════════

async function showEpisodeDetail(bot: TelegramBot, chatId: number, msgId: number, epId: number) {
  const ep = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;

  const [feed, favRows, queueRows] = await Promise.all([
    db.select().from(feedsTable).where(eq(feedsTable.id, ep[0].feedId)).limit(1),
    db.select().from(favoritesTable)
      .where(and(eq(favoritesTable.chatId, String(chatId)), eq(favoritesTable.episodeId, epId)))
      .limit(1),
    db.select().from(queueTable)
      .where(and(eq(queueTable.chatId, String(chatId)), eq(queueTable.episodeId, epId)))
      .limit(1),
  ]);

  const isFav   = favRows.length > 0;
  const inQueue = queueRows.length > 0;
  const audioUrl = ep[0].audioUrl ?? "";

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

  // Row 1: Favourite + Queue
  keyboard.push([
    { text: isFav ? "💔 Unfavourite" : "❤️ Favourite", callback_data: `fav:${epId}` },
    { text: inQueue ? "✅ In Queue"   : "⏭ Add to Queue", callback_data: `queue_add:${epId}` },
  ]);

  // Row 2: Mark played + Transcript
  keyboard.push([
    { text: ep[0].listened ? "🔄 Mark Unplayed" : "✅ Mark Played", callback_data: `listened:${epId}` },
    { text: "📄 Transcript PDF", callback_data: `transcript:${epId}` },
  ]);

  // Row 3: Play + Download (URL buttons — work for any file size)
  if (audioUrl) {
    keyboard.push([
      { text: "🎧 Play Online",  url: audioUrl },
      { text: "📥 Download",     url: audioUrl },
    ]);
  }

  // Row 4: Back
  keyboard.push([{ text: "◀️ Back", callback_data: `feed:${ep[0].feedId}` }]);

  await bot.editMessageText(card + desc, {
    chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// TRANSCRIPT PDF
// ═══════════════════════════════════════════════════════════════════════════

async function doTranscript(bot: TelegramBot, chatId: number, epId: number) {
  const ep = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;

  const feed = await db.select().from(feedsTable)
    .where(eq(feedsTable.id, ep[0].feedId)).limit(1);

  if (!process.env.OPENAI_API_KEY) {
    await bot.sendMessage(chatId, fmt([
      "🔑 *OpenAI API Key Required*",
      divider(),
      "Transcription uses OpenAI Whisper.",
      "Please add your key as `OPENAI_API_KEY` in Secrets,",
      "then try again.",
    ]), { parse_mode: "Markdown" });
    return;
  }

  if (!ep[0].audioUrl) {
    await bot.sendMessage(chatId, "❌ This episode has no audio URL — cannot transcribe.", { parse_mode: "Markdown" });
    return;
  }

  const statusMsg = await bot.sendMessage(chatId, fmt([
    "📄 *Generating Transcript…*",
    divider(),
    `🎙 ${truncate(ep[0].title, 50)}`,
    "",
    "⏳ Downloading audio (up to 25 MB)…",
  ]), { parse_mode: "Markdown" });

  try {
    // Download up to 25 MB (Whisper limit)
    const audioRes = await fetch(ep[0].audioUrl, {
      headers: { "User-Agent": "Mozilla/5.0", "Range": "bytes=0-26214400" },
    });

    if (!audioRes.ok) throw new Error(`Audio download failed: ${audioRes.status}`);
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

    await bot.editMessageText(fmt([
      "📄 *Generating Transcript…*",
      divider(),
      `🎙 ${truncate(ep[0].title, 50)}`,
      "",
      `📦 ${(audioBuffer.length / 1048576).toFixed(1)} MB downloaded`,
      "⏳ Transcribing with Whisper…",
    ]), { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" });

    // Call OpenAI Whisper
    const { default: OpenAI } = await import("openai");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const ext = ep[0].audioUrl.match(/\.(mp3|mp4|m4a|ogg|wav|webm|flac)(\?.*)?$/i)?.[1] ?? "mp3";
    const file = new File([audioBuffer], `episode.${ext}`, { type: `audio/${ext}` });

    const transcription = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file,
      response_format: "text",
    });

    const transcript = String(transcription).trim();
    if (!transcript) throw new Error("Whisper returned an empty transcript.");

    await bot.editMessageText(fmt([
      "📄 *Generating PDF…*",
      divider(),
      `🎙 ${truncate(ep[0].title, 50)}`,
      "",
      "⏳ Building your document…",
    ]), { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" });

    const pdfBuffer = await generateTranscriptPdf({
      podcastTitle: feed[0]?.title ?? "Podcast",
      episodeTitle: ep[0].title,
      pubDate:      ep[0].pubDate,
      duration:     ep[0].duration,
      transcript,
    });

    await bot.deleteMessage(chatId, statusMsg.message_id);

    await bot.sendDocument(chatId, pdfBuffer as any, {
      caption: fmt([
        `📄 *Transcript*`,
        divider(),
        `🎙 ${truncate(ep[0].title, 50)}`,
        `📻 ${truncate(feed[0]?.title ?? "", 40)}`,
      ]),
      parse_mode: "Markdown",
    }, {
      filename: `transcript_${ep[0].id}.pdf`,
      contentType: "application/pdf",
    });

  } catch (err: any) {
    await bot.editMessageText(fmt([
      "❌ *Transcript Failed*",
      divider(),
      `_${truncate(String(err?.message ?? err), 100)}_`,
    ]), { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LATEST
// ═══════════════════════════════════════════════════════════════════════════

async function showLatest(bot: TelegramBot, chatId: number) {
  const feeds = await db.select().from(feedsTable).where(eq(feedsTable.chatId, String(chatId)));
  if (feeds.length === 0) {
    await bot.sendMessage(chatId, fmt([
      "📭 *No Subscriptions Yet*",
      "/browse — Search iTunes · /trending — By country",
    ]), { parse_mode: "Markdown" });
    return;
  }

  const feedIds = feeds.map((f) => f.id);
  const episodes = await db.select().from(episodesTable)
    .where(sql`${episodesTable.feedId} = ANY(${sql`ARRAY[${sql.join(feedIds.map(id => sql`${id}`), sql`, `)}]::int[]`})`)
    .orderBy(desc(episodesTable.pubDate))
    .limit(10);

  if (!episodes.length) {
    await bot.sendMessage(chatId, "📭 No episodes found. Try /refresh.", { parse_mode: "Markdown" });
    return;
  }

  const feedMap = new Map(feeds.map((f) => [f.id, f.title]));
  const keyboard: TelegramBot.InlineKeyboardButton[][] = episodes.map((ep, i) => [{
    text: `${i + 1}. ${ep.listened ? "✅" : "🔵"} ${truncate(ep.title, 30)}`,
    callback_data: `ep:${ep.id}`,
  }]);

  await bot.sendMessage(chatId, fmt([
    `🆕 *Latest Episodes · ${episodes.length}*`,
    divider(),
    ...episodes.map((ep, i) =>
      `${i + 1}. ${ep.listened ? "✅" : "🔵"} *${truncate(ep.title, 38)}*\n    📻 ${truncate(feedMap.get(ep.feedId) ?? "—", 28)}`
    ),
    divider(),
    "_Tap an episode for details & download._",
  ]), { parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } });
}

// ═══════════════════════════════════════════════════════════════════════════
// QUEUE / FAVOURITES / SEARCH / STATS
// ═══════════════════════════════════════════════════════════════════════════

async function showQueue(bot: TelegramBot, chatId: number) {
  const queue = await db.select({
    episodeId: queueTable.episodeId,
    position:  queueTable.position,
    title:     episodesTable.title,
    listened:  episodesTable.listened,
  })
    .from(queueTable)
    .innerJoin(episodesTable, eq(queueTable.episodeId, episodesTable.id))
    .where(eq(queueTable.chatId, String(chatId)))
    .orderBy(queueTable.position);

  if (!queue.length) {
    await bot.sendMessage(chatId, fmt([
      "📭 *Queue is Empty*",
      divider(),
      "Add episodes from /latest or /feeds.",
    ]), { parse_mode: "Markdown" });
    return;
  }

  const keyboard: TelegramBot.InlineKeyboardButton[][] = queue.map((q, i) => [
    { text: `${i + 1}. ${q.listened ? "✅" : "🔵"} ${truncate(q.title, 25)}`, callback_data: `ep:${q.episodeId}` },
    { text: "🗑", callback_data: `queue_rm:${q.episodeId}` },
  ]);

  await bot.sendMessage(chatId, fmt([
    `⏭ *Playback Queue · ${queue.length}*`,
    divider(),
    ...queue.map((q, i) => `${i + 1}. ${q.listened ? "✅" : "🔵"} ${truncate(q.title, 42)}`),
  ]), { parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } });
}

async function showFavourites(bot: TelegramBot, chatId: number) {
  const favs = await db.select({
    episodeId: episodesTable.id,
    title:     episodesTable.title,
    listened:  episodesTable.listened,
  })
    .from(favoritesTable)
    .innerJoin(episodesTable, eq(favoritesTable.episodeId, episodesTable.id))
    .where(eq(favoritesTable.chatId, String(chatId)))
    .orderBy(desc(favoritesTable.createdAt))
    .limit(20);

  if (!favs.length) {
    await bot.sendMessage(chatId, fmt([
      "📭 *No Favourites Yet*",
      divider(),
      "Tap ❤️ on any episode to save it here.",
    ]), { parse_mode: "Markdown" });
    return;
  }

  const keyboard: TelegramBot.InlineKeyboardButton[][] = favs.map((f, i) => [{
    text: `${i + 1}. ${f.listened ? "✅" : "🔵"} ${truncate(f.title, 30)}`,
    callback_data: `ep:${f.episodeId}`,
  }]);

  await bot.sendMessage(chatId, fmt([
    `❤️ *Favourites · ${favs.length}*`,
    divider(),
    ...favs.map((f, i) => `${i + 1}. ${f.listened ? "✅" : "🔵"} ${truncate(f.title, 42)}`),
  ]), { parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } });
}

async function handleEpisodeSearch(bot: TelegramBot, chatId: number, query: string) {
  const feeds = await db.select({ id: feedsTable.id }).from(feedsTable)
    .where(eq(feedsTable.chatId, String(chatId)));

  if (!feeds.length) {
    await bot.sendMessage(chatId, "📭 No subscriptions found. Please add a podcast first.", { parse_mode: "Markdown" });
    return;
  }

  const feedIds = feeds.map((f) => f.id);
  const results = await db.select().from(episodesTable)
    .where(and(
      sql`${episodesTable.feedId} = ANY(${sql`ARRAY[${sql.join(feedIds.map(id => sql`${id}`), sql`, `)}]::int[]`})`,
      like(episodesTable.title, `%${query}%`)
    ))
    .orderBy(desc(episodesTable.pubDate))
    .limit(15);

  if (!results.length) {
    await bot.sendMessage(chatId, fmt([
      `🔍 *No Results for "${truncate(query, 30)}"*`,
      divider(),
      "Try a different search term.",
    ]), { parse_mode: "Markdown" });
    return;
  }

  const keyboard: TelegramBot.InlineKeyboardButton[][] = results.map((ep, i) => [{
    text: `${i + 1}. ${truncate(ep.title, 32)}`,
    callback_data: `ep:${ep.id}`,
  }]);

  await bot.sendMessage(chatId, fmt([
    `🔍 *"${truncate(query, 25)}" · ${results.length} results*`,
    divider(),
    ...results.map((ep, i) =>
      `${i + 1}. ${ep.listened ? "✅" : "🔵"} ${truncate(ep.title, 42)}`
    ),
  ]), { parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } });
}

async function showStats(bot: TelegramBot, chatId: number) {
  const feeds = await db.select({ id: feedsTable.id }).from(feedsTable)
    .where(eq(feedsTable.chatId, String(chatId)));

  if (!feeds.length) {
    await bot.sendMessage(chatId, "📭 No statistics yet. Please subscribe to a podcast first.", { parse_mode: "Markdown" });
    return;
  }

  const feedIds = feeds.map((f) => f.id);
  const arr = sql`ARRAY[${sql.join(feedIds.map(id => sql`${id}`), sql`, `)}]::int[]`;

  const [[{ c: total }], [{ c: listened }], [{ c: favCount }], [{ c: queueCount }]] =
    await Promise.all([
      db.select({ c: count() }).from(episodesTable).where(sql`${episodesTable.feedId} = ANY(${arr})`),
      db.select({ c: count() }).from(episodesTable).where(and(sql`${episodesTable.feedId} = ANY(${arr})`, eq(episodesTable.listened, true))),
      db.select({ c: count() }).from(favoritesTable).where(eq(favoritesTable.chatId, String(chatId))),
      db.select({ c: count() }).from(queueTable).where(eq(queueTable.chatId, String(chatId))),
    ]);

  const pct = total > 0 ? Math.round((listened / total) * 100) : 0;

  await bot.sendMessage(chatId, fmt([
    "📊 *Listening Statistics*",
    divider(),
    `📻 Subscriptions  · ${feeds.length}`,
    `🎙 Total Episodes · ${total}`,
    `✅ Played         · ${listened}`,
    `🔵 Unplayed       · ${total - listened}`,
    "",
    `${progressBar(pct)} ${pct}%`,
    divider(),
    `❤️ Favourites · ${favCount}`,
    `⏭ Queue       · ${queueCount}`,
  ]), { parse_mode: "Markdown" });
}

// ═══════════════════════════════════════════════════════════════════════════
// REFRESH
// ═══════════════════════════════════════════════════════════════════════════

async function refreshFeed(bot: TelegramBot, chatId: number, msgId: number, feedId: number) {
  const feed = await db.select().from(feedsTable).where(eq(feedsTable.id, feedId)).limit(1);
  if (!feed[0]) return;

  await bot.editMessageText(fmt([
    `🔄 *Refreshing Feed…*`,
    divider(),
    `📻 ${truncate(feed[0].title, 40)}`,
  ]), { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" });

  try {
    const feedData = await fetchFeed(feed[0].url);
    let newCount = 0;
    for (const ep of feedData.episodes) {
      const exists = await db.select({ id: episodesTable.id }).from(episodesTable)
        .where(and(eq(episodesTable.feedId, feedId), eq(episodesTable.guid, ep.guid)))
        .limit(1);
      if (!exists.length) {
        await db.insert(episodesTable).values({
          feedId, guid: ep.guid, title: ep.title, description: ep.description,
          audioUrl: ep.audioUrl, pubDate: ep.pubDate, duration: ep.duration,
        });
        newCount++;
      }
    }
    await db.update(feedsTable).set({ lastChecked: new Date() }).where(eq(feedsTable.id, feedId));

    await bot.editMessageText(fmt([
      `✅ *Feed Refreshed*`,
      divider(),
      `📻 ${truncate(feed[0].title, 40)}`,
      `🆕 ${newCount} new episode${newCount === 1 ? "" : "s"}`,
    ]), { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" });

    setTimeout(() => showFeedEpisodes(bot, chatId, msgId, feedId, 0), 1500);
  } catch (err: any) {
    await bot.editMessageText(fmt([
      "❌ *Refresh Failed*",
      divider(),
      `_${truncate(String(err?.message ?? err), 80)}_`,
    ]), { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" });
  }
}

async function refreshAllFeeds(bot: TelegramBot, chatId: number) {
  const feeds = await db.select().from(feedsTable).where(eq(feedsTable.chatId, String(chatId)));
  if (!feeds.length) {
    await bot.sendMessage(chatId, "📭 No subscriptions to refresh.", { parse_mode: "Markdown" });
    return;
  }

  const msg = await bot.sendMessage(chatId, fmt([
    `🔄 *Refreshing ${feeds.length} Feed${feeds.length === 1 ? "" : "s"}…*`,
    divider(), "⏳ Please wait…",
  ]), { parse_mode: "Markdown" });

  let totalNew = 0;
  for (const feed of feeds) {
    try {
      const feedData = await fetchFeed(feed.url);
      for (const ep of feedData.episodes) {
        const exists = await db.select({ id: episodesTable.id }).from(episodesTable)
          .where(and(eq(episodesTable.feedId, feed.id), eq(episodesTable.guid, ep.guid)))
          .limit(1);
        if (!exists.length) {
          await db.insert(episodesTable).values({
            feedId: feed.id, guid: ep.guid, title: ep.title,
            description: ep.description, audioUrl: ep.audioUrl,
            pubDate: ep.pubDate, duration: ep.duration,
          });
          totalNew++;
        }
      }
      await db.update(feedsTable).set({ lastChecked: new Date() }).where(eq(feedsTable.id, feed.id));
    } catch { /* skip failed feeds silently */ }
  }

  await bot.editMessageText(fmt([
    `✅ *All Feeds Refreshed*`,
    divider(),
    `📻 ${feeds.length} subscription${feeds.length === 1 ? "" : "s"}`,
    `🆕 ${totalNew} new episode${totalNew === 1 ? "" : "s"} found`,
    "",
    "Use /latest to see the newest episodes.",
  ]), { chat_id: chatId, message_id: msg.message_id, parse_mode: "Markdown" });
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

async function toggleFavourite(bot: TelegramBot, chatId: number, msgId: number, epId: number) {
  const existing = await db.select().from(favoritesTable)
    .where(and(eq(favoritesTable.chatId, String(chatId)), eq(favoritesTable.episodeId, epId))).limit(1);
  if (existing.length > 0) {
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
    await db.insert(queueTable).values({ chatId: String(chatId), episodeId: epId, position: (m || 0) + 1 });
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
  await bot.editMessageText(fmt([
    `🗑 *Subscription Removed*`,
    divider(),
    `📻 ${truncate(feed[0].title, 45)}`,
    "",
    "Use /feeds to view your remaining subscriptions.",
  ]), { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" });
}
