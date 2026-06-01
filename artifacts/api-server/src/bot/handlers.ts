import TelegramBot from "node-telegram-bot-api";
import { db, feedsTable, episodesTable, favoritesTable, queueTable } from "@workspace/db";
import { eq, and, desc, like, count, sql } from "drizzle-orm";
import { fetchFeed } from "./rss.js";
import { fetchTrending, resolveRssFeed, COUNTRIES, PERIODS } from "./trending.js";
import {
  fmt, divider, shortDivider, truncate, episodeCard, feedCard,
  welcomeMsg, formatDate, parseDuration, formatDuration, progressBar,
} from "./formatter.js";

const PAGE_SIZE = 5;

type SessionState = {
  action?: "awaiting_rss" | "awaiting_search";
  trendingCountry?: string;
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
  bot.onText(/\/help/, async (msg) => { await send(msg.chat.id, welcomeMsg()); });

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
  bot.onText(/\/feeds/, async (msg) => { await showFeeds(bot, msg.chat.id); });

  // ─── /latest ──────────────────────────────────────────────────────────────
  bot.onText(/\/latest/, async (msg) => { await showLatest(bot, msg.chat.id); });

  // ─── /queue ───────────────────────────────────────────────────────────────
  bot.onText(/\/queue/, async (msg) => { await showQueue(bot, msg.chat.id); });

  // ─── /favourites ──────────────────────────────────────────────────────────
  bot.onText(/\/favourites/, async (msg) => { await showFavourites(bot, msg.chat.id); });
  bot.onText(/\/favorites/, async (msg) => { await showFavourites(bot, msg.chat.id); });

  // ─── /search ──────────────────────────────────────────────────────────────
  bot.onText(/\/search/, async (msg) => {
    const chatId = msg.chat.id;
    getSession(chatId).action = "awaiting_search";
    await send(chatId, fmt([
      "🔍 *Search Episodes*",
      divider(),
      "Please enter your search query:",
    ]));
  });

  // ─── /stats ───────────────────────────────────────────────────────────────
  bot.onText(/\/stats/, async (msg) => { await showStats(bot, msg.chat.id); });

  // ─── /refresh ─────────────────────────────────────────────────────────────
  bot.onText(/\/refresh/, async (msg) => { await refreshAllFeeds(bot, msg.chat.id); });

  // ─── /trending ────────────────────────────────────────────────────────────
  bot.onText(/\/trending/, async (msg) => { await showTrendingCountries(bot, msg.chat.id); });

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
      await handleSearch(bot, chatId, text);
    } else if (text.startsWith("http")) {
      await handleAddRss(bot, chatId, text);
    } else {
      await send(chatId, fmt([
        "🤔 I beg your pardon, I didn't quite follow that.",
        "Type /help to view available commands.",
      ]));
    }
  });

  // ─── Callbacks ────────────────────────────────────────────────────────────
  bot.on("callback_query", async (query) => {
    if (!query.message || !query.data) return;
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;
    const data = query.data;

    await bot.answerCallbackQuery(query.id);

    if (data.startsWith("feed:")) {
      const feedId = parseInt(data.split(":")[1]);
      await showFeedEpisodes(bot, chatId, msgId, feedId, 0);

    } else if (data.startsWith("eplist:")) {
      const [, feedId, page] = data.split(":").map(Number);
      await showFeedEpisodes(bot, chatId, msgId, feedId, page);

    } else if (data.startsWith("ep:")) {
      const epId = parseInt(data.split(":")[1]);
      await showEpisodeDetail(bot, chatId, msgId, epId);

    } else if (data.startsWith("fav:")) {
      const epId = parseInt(data.split(":")[1]);
      await toggleFavourite(bot, chatId, msgId, epId);

    } else if (data.startsWith("queue_add:")) {
      const epId = parseInt(data.split(":")[1]);
      await addToQueue(bot, chatId, msgId, epId);

    } else if (data.startsWith("queue_rm:")) {
      const epId = parseInt(data.split(":")[1]);
      await removeFromQueue(bot, chatId, epId);
      await showQueue(bot, chatId);

    } else if (data.startsWith("listened:")) {
      const epId = parseInt(data.split(":")[1]);
      await markListened(bot, chatId, msgId, epId);

    } else if (data.startsWith("del_feed:")) {
      const feedId = parseInt(data.split(":")[1]);
      await deleteFeed(bot, chatId, msgId, feedId);

    } else if (data.startsWith("refresh_feed:")) {
      const feedId = parseInt(data.split(":")[1]);
      await refreshFeed(bot, chatId, msgId, feedId);

    } else if (data.startsWith("download:")) {
      const epId = parseInt(data.split(":")[1]);
      await downloadEpisode(bot, chatId, msgId, epId);

    } else if (data === "back_feeds") {
      await showFeedsInline(bot, chatId, msgId);

    } else if (data === "trending_countries") {
      await showTrendingCountriesInline(bot, chatId, msgId);

    } else if (data.startsWith("trend_c:")) {
      const country = data.split(":")[1];
      getSession(chatId).trendingCountry = country;
      await showTrendingPeriods(bot, chatId, msgId, country);

    } else if (data.startsWith("trend_p:")) {
      const [, country, period] = data.split(":");
      await showTrendingList(bot, chatId, msgId, country, period);

    } else if (data.startsWith("trend_sub:")) {
      const [, itunesId, encodedName] = data.split(":");
      const name = decodeURIComponent(encodedName);
      await subscribeToTrending(bot, chatId, msgId, itunesId, name);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// RSS / SUBSCRIPTION
// ═══════════════════════════════════════════════════════════════════════════

async function handleAddRss(bot: TelegramBot, chatId: number, url: string) {
  const send = (text: string, opts?: TelegramBot.SendMessageOptions) =>
    bot.sendMessage(chatId, text, { parse_mode: "Markdown", ...opts });

  if (!url.startsWith("http")) {
    await send("❌ That URL does not appear to be valid. It must begin with http or https.");
    return;
  }

  const loadMsg = await send(fmt([
    "⏳ *Fetching podcast feed…*",
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
      chatId: String(chatId),
      url,
      title: feedData.title,
      lastChecked: new Date(),
    }).returning();

    const episodes = feedData.episodes.slice(0, 50);
    if (episodes.length > 0) {
      await db.insert(episodesTable).values(
        episodes.map((ep) => ({
          feedId: feed.id,
          guid: ep.guid,
          title: ep.title,
          description: ep.description,
          audioUrl: ep.audioUrl,
          pubDate: ep.pubDate,
          duration: ep.duration,
        }))
      ).onConflictDoNothing();
    }

    await bot.editMessageText(fmt([
      "✅ *Subscription Added*",
      divider(),
      `📻 *${truncate(feedData.title, 45)}*`,
      `🎙 ${episodes.length} episode${episodes.length === 1 ? "" : "s"} loaded`,
      "",
      "Use /feeds to browse your subscriptions.",
      "Use /latest to see the newest episodes.",
    ]), { chat_id: chatId, message_id: loadMsg.message_id, parse_mode: "Markdown" });

  } catch (err: any) {
    await bot.editMessageText(fmt([
      "❌ *Feed Could Not Be Loaded*",
      divider(),
      "Please verify the URL is a valid RSS or Atom feed.",
      "",
      `_Error: ${truncate(String(err?.message || err), 80)}_`,
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
      "/trending — Discover trending podcasts",
      "",
      "_You may also send an RSS URL directly._ 🚀",
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
    text: `${i + 1}. ${truncate(f.title, 28)}`,
    callback_data: `feed:${f.id}`,
  }]);

  await bot.sendMessage(chatId, fmt([
    `📻 *Your Subscriptions · ${feeds.length}*`,
    divider(),
    ...lines,
    divider(),
    "_Tap a podcast to browse its episodes._",
  ]), {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard },
  });
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
    text: `${i + 1}. ${truncate(f.title, 28)}`,
    callback_data: `feed:${f.id}`,
  }]);

  await bot.editMessageText(fmt([
    `📻 *Your Subscriptions · ${feeds.length}*`,
    divider(),
    ...feeds.map((f, i) => `${i + 1}. ${truncate(f.title, 40)}`),
    divider(),
    "_Tap a podcast to browse its episodes._",
  ]), {
    chat_id: chatId,
    message_id: msgId,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function showFeedEpisodes(
  bot: TelegramBot, chatId: number, msgId: number, feedId: number, page: number
) {
  const feed = await db.select().from(feedsTable).where(eq(feedsTable.id, feedId)).limit(1);
  if (!feed[0]) return;

  const total = await db.select({ c: count() }).from(episodesTable).where(eq(episodesTable.feedId, feedId));
  const totalCount = total[0].c;

  const episodes = await db.select().from(episodesTable)
    .where(eq(episodesTable.feedId, feedId))
    .orderBy(desc(episodesTable.pubDate))
    .limit(PAGE_SIZE)
    .offset(page * PAGE_SIZE);

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const startIdx = page * PAGE_SIZE + 1;

  const keyboard: TelegramBot.InlineKeyboardButton[][] = episodes.map((ep, i) => [{
    text: `${startIdx + i}. ${ep.listened ? "✅" : "🔵"} ${truncate(ep.title, 30)}`,
    callback_data: `ep:${ep.id}`,
  }]);

  const navRow: TelegramBot.InlineKeyboardButton[] = [];
  if (page > 0) navRow.push({ text: "◀️ Previous", callback_data: `eplist:${feedId}:${page - 1}` });
  if (page < totalPages - 1) navRow.push({ text: "Next ▶️", callback_data: `eplist:${feedId}:${page + 1}` });
  if (navRow.length) keyboard.push(navRow);

  keyboard.push([
    { text: "🔄 Refresh", callback_data: `refresh_feed:${feedId}` },
    { text: "🗑 Remove", callback_data: `del_feed:${feedId}` },
    { text: "◀️ Back", callback_data: "back_feeds" },
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
    chat_id: chatId,
    message_id: msgId,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function showEpisodeDetail(bot: TelegramBot, chatId: number, msgId: number, epId: number) {
  const ep = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;

  const feed = await db.select().from(feedsTable).where(eq(feedsTable.id, ep[0].feedId)).limit(1);
  const isFav = await db.select().from(favoritesTable)
    .where(and(eq(favoritesTable.chatId, String(chatId)), eq(favoritesTable.episodeId, epId)))
    .limit(1);
  const inQueue = await db.select().from(queueTable)
    .where(and(eq(queueTable.chatId, String(chatId)), eq(queueTable.episodeId, epId)))
    .limit(1);

  const card = episodeCard({
    title: ep[0].title,
    feedTitle: feed[0]?.title,
    pubDate: ep[0].pubDate,
    duration: ep[0].duration,
    listened: ep[0].listened ?? false,
    progress: ep[0].progress ?? 0,
    isFav: isFav.length > 0,
    inQueue: inQueue.length > 0,
  });

  const desc = ep[0].description
    ? "\n" + divider() + "\n" + truncate(ep[0].description.replace(/<[^>]+>/g, ""), 200)
    : "";

  const keyboard: TelegramBot.InlineKeyboardButton[][] = [
    [
      { text: isFav.length > 0 ? "💔 Unfavourite" : "❤️ Favourite", callback_data: `fav:${epId}` },
      { text: inQueue.length > 0 ? "✅ In Queue" : "⏭ Add to Queue", callback_data: `queue_add:${epId}` },
    ],
    [
      { text: ep[0].listened ? "🔄 Mark Unplayed" : "✅ Mark Played", callback_data: `listened:${epId}` },
      { text: "📥 Download", callback_data: `download:${epId}` },
    ],
    [
      { text: "◀️ Back", callback_data: `feed:${ep[0].feedId}` },
    ],
  ];

  await bot.editMessageText(card + desc, {
    chat_id: chatId,
    message_id: msgId,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// DOWNLOAD
// ═══════════════════════════════════════════════════════════════════════════

async function downloadEpisode(bot: TelegramBot, chatId: number, msgId: number, epId: number) {
  const ep = await db.select().from(episodesTable).where(eq(episodesTable.id, epId)).limit(1);
  if (!ep[0]) return;

  if (!ep[0].audioUrl) {
    await bot.sendMessage(chatId, fmt([
      "❌ *No Audio File Available*",
      divider(),
      "This episode does not have a downloadable audio link.",
    ]), { parse_mode: "Markdown" });
    return;
  }

  const url = ep[0].audioUrl;
  const title = truncate(ep[0].title, 60);

  const statusMsg = await bot.sendMessage(chatId, fmt([
    "📥 *Preparing Download…*",
    divider(),
    `🎙 ${title}`,
    "",
    "⏳ Checking file size…",
  ]), { parse_mode: "Markdown" });

  try {
    const head = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(8000) });
    const contentLength = parseInt(head.headers.get("content-length") || "0", 10);
    const contentType = head.headers.get("content-type") || "";
    const isAudio = contentType.includes("audio") || url.match(/\.(mp3|m4a|ogg|aac|opus|wav)(\?.*)?$/i);
    const MB50 = 50 * 1024 * 1024;

    if (contentLength > 0 && contentLength <= MB50 && isAudio) {
      // Telegram can handle up to 50 MB directly
      await bot.editMessageText(fmt([
        "📥 *Sending Audio…*",
        divider(),
        `🎙 ${title}`,
        `📦 Size · ${(contentLength / 1048576).toFixed(1)} MB`,
        "",
        "⏳ Please wait whilst it uploads…",
      ]), { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" });

      const feed = await db.select().from(feedsTable).where(eq(feedsTable.id, ep[0].feedId)).limit(1);

      await bot.sendAudio(chatId, url, {
        title: ep[0].title,
        performer: feed[0]?.title ?? "Podcast",
        caption: truncate(ep[0].title, 200),
        parse_mode: "Markdown",
      });

      await bot.deleteMessage(chatId, statusMsg.message_id);

    } else {
      // File too large or unknown — provide direct link
      const sizeStr = contentLength > 0 ? `${(contentLength / 1048576).toFixed(1)} MB` : "Unknown size";

      await bot.editMessageText(fmt([
        "📎 *Direct Download Link*",
        divider(),
        `🎙 ${title}`,
        `📦 ${sizeStr}`,
        "",
        "Telegram's 50 MB limit prevents sending this file directly.",
        "Tap the link below to download it to your device:",
        "",
        url,
      ]), {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });
    }

  } catch (err: any) {
    // Fallback: just provide the link
    await bot.editMessageText(fmt([
      "📎 *Download Link*",
      divider(),
      `🎙 ${title}`,
      "",
      "_Tap below to open or save the audio file:_",
      "",
      url,
    ]), {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TRENDING
// ═══════════════════════════════════════════════════════════════════════════

async function showTrendingCountries(bot: TelegramBot, chatId: number) {
  const keyboard = buildCountryKeyboard();
  await bot.sendMessage(chatId, fmt([
    "🌍 *Trending Podcasts*",
    divider(),
    "Select a country to discover what",
    "is trending right now:",
  ]), {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function showTrendingCountriesInline(bot: TelegramBot, chatId: number, msgId: number) {
  const keyboard = buildCountryKeyboard();
  await bot.editMessageText(fmt([
    "🌍 *Trending Podcasts*",
    divider(),
    "Select a country to discover what",
    "is trending right now:",
  ]), {
    chat_id: chatId,
    message_id: msgId,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard },
  });
}

function buildCountryKeyboard(): TelegramBot.InlineKeyboardButton[][] {
  const entries = Object.entries(COUNTRIES);
  const keyboard: TelegramBot.InlineKeyboardButton[][] = [];
  for (let i = 0; i < entries.length; i += 2) {
    const row: TelegramBot.InlineKeyboardButton[] = [
      { text: entries[i][1], callback_data: `trend_c:${entries[i][0]}` },
    ];
    if (entries[i + 1]) {
      row.push({ text: entries[i + 1][1], callback_data: `trend_c:${entries[i + 1][0]}` });
    }
    keyboard.push(row);
  }
  return keyboard;
}

async function showTrendingPeriods(bot: TelegramBot, chatId: number, msgId: number, country: string) {
  const countryName = COUNTRIES[country] ?? country.toUpperCase();
  const keyboard: TelegramBot.InlineKeyboardButton[][] = [
    [
      { text: "📅 Today", callback_data: `trend_p:${country}:daily` },
      { text: "📆 This Week", callback_data: `trend_p:${country}:weekly` },
    ],
    [
      { text: "🗓 This Month", callback_data: `trend_p:${country}:monthly` },
      { text: "📊 This Year", callback_data: `trend_p:${country}:yearly` },
    ],
    [
      { text: "◀️ Change Country", callback_data: "trending_countries" },
    ],
  ];

  await bot.editMessageText(fmt([
    `🌍 *Trending in ${countryName}*`,
    divider(),
    "Select a time period:",
  ]), {
    chat_id: chatId,
    message_id: msgId,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function showTrendingList(
  bot: TelegramBot, chatId: number, msgId: number, country: string, period: string
) {
  const countryName = COUNTRIES[country] ?? country.toUpperCase();

  await bot.editMessageText(fmt([
    `⏳ *Loading Charts…*`,
    divider(),
    `🌍 ${countryName}`,
  ]), { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" });

  try {
    const result = await fetchTrending(country, period);
    const { podcasts } = result;

    const lines = [
      `🏆 *Trending Podcasts · ${result.period}*`,
      divider(),
      `🌍 ${result.country}`,
      shortDivider(),
      ...podcasts.map((p, i) =>
        `${i + 1}. *${truncate(p.name, 38)}*\n    _${truncate(p.artist, 30)}_`
      ),
      divider(),
      "_Tap a podcast to subscribe._",
    ];

    const keyboard: TelegramBot.InlineKeyboardButton[][] = podcasts.map((p, i) => [{
      text: `${i + 1}. ${truncate(p.name, 32)}`,
      callback_data: `trend_sub:${p.id}:${encodeURIComponent(p.name.slice(0, 40))}`,
    }]);

    keyboard.push([
      { text: "◀️ Change Period", callback_data: `trend_c:${country}` },
      { text: "🌍 Change Country", callback_data: "trending_countries" },
    ]);

    await bot.editMessageText(lines.join("\n"), {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard },
    });

  } catch (err: any) {
    await bot.editMessageText(fmt([
      "❌ *Charts Unavailable*",
      divider(),
      "Unable to retrieve trending data at this time.",
      "_Please try again shortly._",
    ]), { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" });
  }
}

async function subscribeToTrending(
  bot: TelegramBot, chatId: number, msgId: number, itunesId: string, name: string
) {
  await bot.editMessageText(fmt([
    "⏳ *Resolving Feed…*",
    divider(),
    `📻 ${name}`,
    "",
    "Fetching the RSS feed from Apple Podcasts…",
  ]), { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" });

  try {
    const rssUrl = await resolveRssFeed(itunesId);

    if (!rssUrl) {
      await bot.editMessageText(fmt([
        "❌ *Feed Not Found*",
        divider(),
        `📻 ${name}`,
        "",
        "Apple Podcasts did not return an RSS URL for this podcast.",
        "Try subscribing manually via /add.",
      ]), { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" });
      return;
    }

    // Check if already subscribed
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

    // Fetch episodes
    const feedData = await fetchFeed(rssUrl);

    const [feed] = await db.insert(feedsTable).values({
      chatId: String(chatId),
      url: rssUrl,
      title: feedData.title || name,
      lastChecked: new Date(),
    }).returning();

    const episodes = feedData.episodes.slice(0, 50);
    if (episodes.length > 0) {
      await db.insert(episodesTable).values(
        episodes.map((ep) => ({
          feedId: feed.id,
          guid: ep.guid,
          title: ep.title,
          description: ep.description,
          audioUrl: ep.audioUrl,
          pubDate: ep.pubDate,
          duration: ep.duration,
        }))
      ).onConflictDoNothing();
    }

    await bot.editMessageText(fmt([
      "✅ *Subscription Added*",
      divider(),
      `📻 *${truncate(feedData.title || name, 45)}*`,
      `🎙 ${episodes.length} episode${episodes.length === 1 ? "" : "s"} loaded`,
      "",
      "Use /feeds to browse your subscriptions.",
      "Use /latest to see the newest episodes.",
    ]), { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" });

  } catch (err: any) {
    await bot.editMessageText(fmt([
      "❌ *Subscription Failed*",
      divider(),
      `_${truncate(String(err?.message || err), 80)}_`,
      "",
      "Please try subscribing manually via /add.",
    ]), { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" });
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
      "/add — Subscribe via RSS URL",
      "/trending — Discover trending podcasts",
    ]), { parse_mode: "Markdown" });
    return;
  }

  const feedIds = feeds.map((f) => f.id);
  const episodes = await db.select().from(episodesTable)
    .where(sql`${episodesTable.feedId} = ANY(${sql`ARRAY[${sql.join(feedIds.map(id => sql`${id}`), sql`, `)}]::int[]`})`)
    .orderBy(desc(episodesTable.pubDate))
    .limit(8);

  if (episodes.length === 0) {
    await bot.sendMessage(chatId, "📭 No episodes found. Try /refresh to update your feeds.", { parse_mode: "Markdown" });
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
  ]), {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// QUEUE
// ═══════════════════════════════════════════════════════════════════════════

async function showQueue(bot: TelegramBot, chatId: number) {
  const queue = await db.select({
    queueId: queueTable.id,
    position: queueTable.position,
    episodeId: queueTable.episodeId,
    title: episodesTable.title,
    listened: episodesTable.listened,
  })
    .from(queueTable)
    .innerJoin(episodesTable, eq(queueTable.episodeId, episodesTable.id))
    .where(eq(queueTable.chatId, String(chatId)))
    .orderBy(queueTable.position);

  if (queue.length === 0) {
    await bot.sendMessage(chatId, fmt([
      "📭 *Queue is Empty*",
      divider(),
      "Add episodes to your queue from /latest or /feeds.",
    ]), { parse_mode: "Markdown" });
    return;
  }

  const keyboard: TelegramBot.InlineKeyboardButton[][] = queue.map((q, i) => [
    { text: `${i + 1}. ${q.listened ? "✅" : "🔵"} ${truncate(q.title, 25)}`, callback_data: `ep:${q.episodeId}` },
    { text: "🗑", callback_data: `queue_rm:${q.episodeId}` },
  ]);

  await bot.sendMessage(chatId, fmt([
    `⏭ *Playback Queue · ${queue.length} episode${queue.length === 1 ? "" : "s"}*`,
    divider(),
    ...queue.map((q, i) =>
      `${i + 1}. ${q.listened ? "✅" : "🔵"} ${truncate(q.title, 42)}`
    ),
  ]), {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// FAVOURITES
// ═══════════════════════════════════════════════════════════════════════════

async function showFavourites(bot: TelegramBot, chatId: number) {
  const favs = await db.select({
    favId: favoritesTable.id,
    episodeId: episodesTable.id,
    title: episodesTable.title,
    listened: episodesTable.listened,
  })
    .from(favoritesTable)
    .innerJoin(episodesTable, eq(favoritesTable.episodeId, episodesTable.id))
    .where(eq(favoritesTable.chatId, String(chatId)))
    .orderBy(desc(favoritesTable.createdAt))
    .limit(10);

  if (favs.length === 0) {
    await bot.sendMessage(chatId, fmt([
      "📭 *No Favourites Yet*",
      divider(),
      "Tap ❤️ on any episode to add it to your favourites.",
    ]), { parse_mode: "Markdown" });
    return;
  }

  const keyboard: TelegramBot.InlineKeyboardButton[][] = favs.map((f, i) => [{
    text: `${i + 1}. ${f.listened ? "✅" : "🔵"} ${truncate(f.title, 30)}`,
    callback_data: `ep:${f.episodeId}`,
  }]);

  await bot.sendMessage(chatId, fmt([
    `❤️ *Favourites · ${favs.length} episode${favs.length === 1 ? "" : "s"}*`,
    divider(),
    ...favs.map((f, i) =>
      `${i + 1}. ${f.listened ? "✅" : "🔵"} ${truncate(f.title, 42)}`
    ),
  ]), {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SEARCH
// ═══════════════════════════════════════════════════════════════════════════

async function handleSearch(bot: TelegramBot, chatId: number, query: string) {
  const feeds = await db.select({ id: feedsTable.id }).from(feedsTable)
    .where(eq(feedsTable.chatId, String(chatId)));

  if (feeds.length === 0) {
    await bot.sendMessage(chatId, "📭 No subscriptions found. Please add a podcast first.", { parse_mode: "Markdown" });
    return;
  }

  const feedIds = feeds.map((f) => f.id);
  const results = await db.select().from(episodesTable)
    .where(
      and(
        sql`${episodesTable.feedId} = ANY(${sql`ARRAY[${sql.join(feedIds.map(id => sql`${id}`), sql`, `)}]::int[]`})`,
        like(episodesTable.title, `%${query}%`)
      )
    )
    .orderBy(desc(episodesTable.pubDate))
    .limit(8);

  if (results.length === 0) {
    await bot.sendMessage(chatId, fmt([
      `🔍 *No Results for "${truncate(query, 30)}"*`,
      divider(),
      "Please try a different search term.",
    ]), { parse_mode: "Markdown" });
    return;
  }

  const keyboard: TelegramBot.InlineKeyboardButton[][] = results.map((ep, i) => [{
    text: `${i + 1}. ${truncate(ep.title, 32)}`,
    callback_data: `ep:${ep.id}`,
  }]);

  await bot.sendMessage(chatId, fmt([
    `🔍 *Results for "${truncate(query, 25)}" · ${results.length}*`,
    divider(),
    ...results.map((ep, i) =>
      `${i + 1}. ${ep.listened ? "✅" : "🔵"} ${truncate(ep.title, 42)}`
    ),
  ]), {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════════

async function showStats(bot: TelegramBot, chatId: number) {
  const feeds = await db.select({ id: feedsTable.id }).from(feedsTable)
    .where(eq(feedsTable.chatId, String(chatId)));

  if (feeds.length === 0) {
    await bot.sendMessage(chatId, "📭 No statistics yet. Please add a podcast first.", { parse_mode: "Markdown" });
    return;
  }

  const feedIds = feeds.map((f) => f.id);
  const feedIdArr = sql`ARRAY[${sql.join(feedIds.map(id => sql`${id}`), sql`, `)}]::int[]`;

  const [totalEps, listenedEps, favCount, queueCount] = await Promise.all([
    db.select({ c: count() }).from(episodesTable).where(sql`${episodesTable.feedId} = ANY(${feedIdArr})`),
    db.select({ c: count() }).from(episodesTable).where(and(
      sql`${episodesTable.feedId} = ANY(${feedIdArr})`,
      eq(episodesTable.listened, true)
    )),
    db.select({ c: count() }).from(favoritesTable).where(eq(favoritesTable.chatId, String(chatId))),
    db.select({ c: count() }).from(queueTable).where(eq(queueTable.chatId, String(chatId))),
  ]);

  const total = totalEps[0].c;
  const listened = listenedEps[0].c;
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
    `❤️ Favourites       · ${favCount[0].c}`,
    `⏭ Queue             · ${queueCount[0].c}`,
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

    for (const ep of feedData.episodes.slice(0, 50)) {
      const exists = await db.select({ id: episodesTable.id }).from(episodesTable)
        .where(and(eq(episodesTable.feedId, feedId), eq(episodesTable.guid, ep.guid)))
        .limit(1);

      if (exists.length === 0) {
        await db.insert(episodesTable).values({
          feedId,
          guid: ep.guid,
          title: ep.title,
          description: ep.description,
          audioUrl: ep.audioUrl,
          pubDate: ep.pubDate,
          duration: ep.duration,
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
      `_${truncate(String(err?.message || err), 80)}_`,
    ]), { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" });
  }
}

async function refreshAllFeeds(bot: TelegramBot, chatId: number) {
  const feeds = await db.select().from(feedsTable).where(eq(feedsTable.chatId, String(chatId)));

  if (feeds.length === 0) {
    await bot.sendMessage(chatId, "📭 No subscriptions to refresh.", { parse_mode: "Markdown" });
    return;
  }

  const msg = await bot.sendMessage(chatId, fmt([
    `🔄 *Refreshing ${feeds.length} Feed${feeds.length === 1 ? "" : "s"}…*`,
    divider(),
    "⏳ Please wait…",
  ]), { parse_mode: "Markdown" });

  let totalNew = 0;

  for (const feed of feeds) {
    try {
      const feedData = await fetchFeed(feed.url);
      for (const ep of feedData.episodes.slice(0, 50)) {
        const exists = await db.select({ id: episodesTable.id }).from(episodesTable)
          .where(and(eq(episodesTable.feedId, feed.id), eq(episodesTable.guid, ep.guid)))
          .limit(1);
        if (exists.length === 0) {
          await db.insert(episodesTable).values({
            feedId: feed.id,
            guid: ep.guid,
            title: ep.title,
            description: ep.description,
            audioUrl: ep.audioUrl,
            pubDate: ep.pubDate,
            duration: ep.duration,
          });
          totalNew++;
        }
      }
      await db.update(feedsTable).set({ lastChecked: new Date() }).where(eq(feedsTable.id, feed.id));
    } catch {
      // Skip any feeds that fail silently
    }
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
    .where(and(eq(favoritesTable.chatId, String(chatId)), eq(favoritesTable.episodeId, epId)))
    .limit(1);

  if (existing.length > 0) {
    await db.delete(favoritesTable).where(eq(favoritesTable.id, existing[0].id));
  } else {
    await db.insert(favoritesTable).values({ chatId: String(chatId), episodeId: epId });
  }

  await showEpisodeDetail(bot, chatId, msgId, epId);
}

async function addToQueue(bot: TelegramBot, chatId: number, msgId: number, epId: number) {
  const existing = await db.select().from(queueTable)
    .where(and(eq(queueTable.chatId, String(chatId)), eq(queueTable.episodeId, epId)))
    .limit(1);

  if (existing.length === 0) {
    const maxPos = await db.select({ m: sql<number>`COALESCE(MAX(${queueTable.position}), 0)` })
      .from(queueTable).where(eq(queueTable.chatId, String(chatId)));
    await db.insert(queueTable).values({
      chatId: String(chatId),
      episodeId: epId,
      position: (maxPos[0].m || 0) + 1,
    });
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
