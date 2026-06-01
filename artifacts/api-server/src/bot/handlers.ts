import TelegramBot from "node-telegram-bot-api";
import { db, feedsTable, episodesTable, favoritesTable, queueTable } from "@workspace/db";
import { eq, and, desc, like, count, sql } from "drizzle-orm";
import { fetchFeed } from "./rss.js";
import {
  fmt, divider, shortDivider, truncate, episodeCard, feedCard,
  welcomeMsg, formatDate, formatDuration, parseDuration, progressBar,
} from "./formatter.js";

const PAGE_SIZE = 5;

type SessionState = {
  action?: "awaiting_rss" | "awaiting_search" | "awaiting_episode_action";
  feedId?: number;
  episodePage?: number;
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

  const edit = (chatId: number, msgId: number, text: string, opts?: TelegramBot.EditMessageTextOptions) =>
    bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", ...opts });

  // ─── /start ──────────────────────────────────────────────────────────────
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await send(chatId, welcomeMsg());
  });

  // ─── /help ───────────────────────────────────────────────────────────────
  bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    await send(chatId, welcomeMsg());
  });

  // ─── /add ────────────────────────────────────────────────────────────────
  bot.onText(/\/add/, async (msg) => {
    const chatId = msg.chat.id;
    getSession(chatId).action = "awaiting_rss";
    await send(chatId, fmt([
      "📡 *إضافة بودكاست*",
      divider(),
      "أرسل رابط RSS/Atom للبودكاست:",
      "",
      "_مثال: https://feeds.example.com/podcast.xml_",
    ]));
  });

  // ─── /feeds ───────────────────────────────────────────────────────────────
  bot.onText(/\/feeds/, async (msg) => {
    const chatId = msg.chat.id;
    await showFeeds(bot, chatId);
  });

  // ─── /latest ──────────────────────────────────────────────────────────────
  bot.onText(/\/latest/, async (msg) => {
    const chatId = msg.chat.id;
    await showLatest(bot, chatId);
  });

  // ─── /queue ───────────────────────────────────────────────────────────────
  bot.onText(/\/queue/, async (msg) => {
    const chatId = msg.chat.id;
    await showQueue(bot, chatId);
  });

  // ─── /favorites ───────────────────────────────────────────────────────────
  bot.onText(/\/favorites/, async (msg) => {
    const chatId = msg.chat.id;
    await showFavorites(bot, chatId);
  });

  // ─── /search ──────────────────────────────────────────────────────────────
  bot.onText(/\/search/, async (msg) => {
    const chatId = msg.chat.id;
    getSession(chatId).action = "awaiting_search";
    await send(chatId, fmt([
      "🔍 *بحث في الحلقات*",
      divider(),
      "أرسل كلمة البحث:",
    ]));
  });

  // ─── /stats ───────────────────────────────────────────────────────────────
  bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    await showStats(bot, chatId);
  });

  // ─── /refresh ─────────────────────────────────────────────────────────────
  bot.onText(/\/refresh/, async (msg) => {
    const chatId = msg.chat.id;
    await refreshAllFeeds(bot, chatId);
  });

  // ─── Text messages ─────────────────────────────────────────────────────────
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
        "🤔 لم أفهم ما تقصد.",
        "اكتب /help لعرض الأوامر المتاحة.",
      ]));
    }
  });

  // ─── Callbacks ─────────────────────────────────────────────────────────────
  bot.on("callback_query", async (query) => {
    if (!query.message || !query.data) return;
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;
    const data = query.data;

    await bot.answerCallbackQuery(query.id);

    // feed:<feedId>
    if (data.startsWith("feed:")) {
      const feedId = parseInt(data.split(":")[1]);
      await showFeedEpisodes(bot, chatId, msgId, feedId, 0);
    }
    // eplist:<feedId>:<page>
    else if (data.startsWith("eplist:")) {
      const [, feedId, page] = data.split(":").map(Number);
      await showFeedEpisodes(bot, chatId, msgId, feedId, page);
    }
    // ep:<episodeId>
    else if (data.startsWith("ep:")) {
      const epId = parseInt(data.split(":")[1]);
      await showEpisodeDetail(bot, chatId, msgId, epId);
    }
    // fav:<episodeId>
    else if (data.startsWith("fav:")) {
      const epId = parseInt(data.split(":")[1]);
      await toggleFavorite(bot, chatId, msgId, epId);
    }
    // queue_add:<episodeId>
    else if (data.startsWith("queue_add:")) {
      const epId = parseInt(data.split(":")[1]);
      await addToQueue(bot, chatId, msgId, epId);
    }
    // queue_rm:<episodeId>
    else if (data.startsWith("queue_rm:")) {
      const epId = parseInt(data.split(":")[1]);
      await removeFromQueue(bot, chatId, epId);
      await showQueue(bot, chatId);
    }
    // listened:<episodeId>
    else if (data.startsWith("listened:")) {
      const epId = parseInt(data.split(":")[1]);
      await markListened(bot, chatId, msgId, epId);
    }
    // del_feed:<feedId>
    else if (data.startsWith("del_feed:")) {
      const feedId = parseInt(data.split(":")[1]);
      await deleteFeed(bot, chatId, msgId, feedId);
    }
    // refresh_feed:<feedId>
    else if (data.startsWith("refresh_feed:")) {
      const feedId = parseInt(data.split(":")[1]);
      await refreshFeed(bot, chatId, msgId, feedId);
    }
    // back_feeds
    else if (data === "back_feeds") {
      await showFeedsInline(bot, chatId, msgId);
    }
    // back_latest
    else if (data === "back_latest") {
      await showLatest(bot, chatId);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// FEED FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

async function handleAddRss(bot: TelegramBot, chatId: number, url: string) {
  const send = (text: string, opts?: TelegramBot.SendMessageOptions) =>
    bot.sendMessage(chatId, text, { parse_mode: "Markdown", ...opts });

  if (!url.startsWith("http")) {
    await send("❌ الرابط غير صحيح. يجب أن يبدأ بـ http أو https");
    return;
  }

  const loadMsg = await send(fmt([
    "⏳ *جاري تحميل البودكاست...*",
    divider(),
    `📡 ${truncate(url, 40)}`,
  ]));

  try {
    const feedData = await fetchFeed(url);

    // Check duplicate
    const existing = await db.select().from(feedsTable)
      .where(and(eq(feedsTable.chatId, String(chatId)), eq(feedsTable.url, url)))
      .limit(1);

    if (existing.length > 0) {
      await bot.editMessageText(fmt([
        "⚠️ *بودكاست موجود مسبقاً*",
        divider(),
        `📻 ${truncate(feedData.title, 45)}`,
        "",
        "هذا البودكاست مضاف بالفعل.",
      ]), { chat_id: chatId, message_id: loadMsg.message_id, parse_mode: "Markdown" });
      return;
    }

    // Insert feed
    const [feed] = await db.insert(feedsTable).values({
      chatId: String(chatId),
      url,
      title: feedData.title,
      lastChecked: new Date(),
    }).returning();

    // Insert episodes
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
      "✅ *تمت الإضافة بنجاح!*",
      divider(),
      `📻 *${truncate(feedData.title, 45)}*`,
      `🎙 ${episodes.length} حلقة محملة`,
      "",
      "اكتب /feeds لعرض بودكاستاتك",
      "اكتب /latest لأحدث الحلقات",
    ]), { chat_id: chatId, message_id: loadMsg.message_id, parse_mode: "Markdown" });

  } catch (err: any) {
    await bot.editMessageText(fmt([
      "❌ *فشل تحميل البودكاست*",
      divider(),
      "تأكد أن الرابط صحيح ويحتوي على RSS/Atom.",
      "",
      `_خطأ: ${truncate(String(err?.message || err), 80)}_`,
    ]), { chat_id: chatId, message_id: loadMsg.message_id, parse_mode: "Markdown" });
  }
}

async function showFeeds(bot: TelegramBot, chatId: number) {
  const feeds = await db.select().from(feedsTable)
    .where(eq(feedsTable.chatId, String(chatId)))
    .orderBy(feedsTable.createdAt);

  if (feeds.length === 0) {
    await bot.sendMessage(chatId, fmt([
      "📭 *لا يوجد بودكاستات*",
      divider(),
      "أضف بودكاستك الأول:",
      "/add — إضافة رابط RSS",
      "",
      "_أو أرسل رابط RSS مباشرة_ 🚀",
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
    `📻 *بودكاستاتك · ${feeds.length}*`,
    divider(),
    ...lines,
    divider(),
    "_اضغط على بودكاست لعرض حلقاته_",
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
      "📭 *لا يوجد بودكاستات*",
      "/add — إضافة بودكاست جديد",
    ]), { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" });
    return;
  }

  const keyboard = feeds.map((f, i) => [{
    text: `${i + 1}. ${truncate(f.title, 28)}`,
    callback_data: `feed:${f.id}`,
  }]);

  await bot.editMessageText(fmt([
    `📻 *بودكاستاتك · ${feeds.length}*`,
    divider(),
    ...feeds.map((f, i) => `${i + 1}. ${truncate(f.title, 40)}`),
    divider(),
    "_اضغط لعرض الحلقات_",
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

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const startIdx = page * PAGE_SIZE + 1;

  const lines = [
    `📻 *${truncate(feed[0].title, 40)}*`,
    divider(),
    `🎙 ${totalCount} حلقة · صفحة ${page + 1}/${totalPages}`,
    shortDivider(),
    ...episodes.map((ep, i) =>
      `${startIdx + i}. ${ep.listened ? "✅" : "🔘"} ${truncate(ep.title, 42)}`
    ),
    divider(),
    "_اضغط على حلقة للتفاصيل_",
  ];

  const keyboard: TelegramBot.InlineKeyboardButton[][] = episodes.map((ep, i) => [{
    text: `${startIdx + i}. ${truncate(ep.title, 30)}`,
    callback_data: `ep:${ep.id}`,
  }]);

  const navRow: TelegramBot.InlineKeyboardButton[] = [];
  if (page > 0) navRow.push({ text: "◀️ السابق", callback_data: `eplist:${feedId}:${page - 1}` });
  if (page < totalPages - 1) navRow.push({ text: "التالي ▶️", callback_data: `eplist:${feedId}:${page + 1}` });

  const actionRow: TelegramBot.InlineKeyboardButton[] = [
    { text: "🔄 تحديث", callback_data: `refresh_feed:${feedId}` },
    { text: "🗑 حذف", callback_data: `del_feed:${feedId}` },
    { text: "◀️ رجوع", callback_data: "back_feeds" },
  ];

  if (navRow.length) keyboard.push(navRow);
  keyboard.push(actionRow);

  await bot.editMessageText(lines.join("\n"), {
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
      { text: isFav.length > 0 ? "💔 إزالة من المفضلة" : "❤️ مفضلة", callback_data: `fav:${epId}` },
      { text: inQueue.length > 0 ? "✅ في القائمة" : "⏭ أضف للقائمة", callback_data: `queue_add:${epId}` },
    ],
    [
      { text: ep[0].listened ? "🔄 تحديد كجديدة" : "✅ تحديد كمسموعة", callback_data: `listened:${epId}` },
    ],
    [
      { text: "◀️ رجوع", callback_data: `feed:${ep[0].feedId}` },
    ],
  ];

  await bot.editMessageText(card + desc, {
    chat_id: chatId,
    message_id: msgId,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function showLatest(bot: TelegramBot, chatId: number) {
  const feeds = await db.select().from(feedsTable).where(eq(feedsTable.chatId, String(chatId)));
  if (feeds.length === 0) {
    await bot.sendMessage(chatId, fmt([
      "📭 *لا يوجد بودكاستات*",
      "/add — أضف بودكاستك الأول",
    ]), { parse_mode: "Markdown" });
    return;
  }

  const feedIds = feeds.map((f) => f.id);
  const episodes = await db.select().from(episodesTable)
    .where(sql`${episodesTable.feedId} = ANY(${sql`ARRAY[${sql.join(feedIds.map(id => sql`${id}`), sql`, `)}]::int[]`})`)
    .orderBy(desc(episodesTable.pubDate))
    .limit(8);

  if (episodes.length === 0) {
    await bot.sendMessage(chatId, "📭 لا توجد حلقات بعد. جرب /refresh للتحديث.", { parse_mode: "Markdown" });
    return;
  }

  const feedMap = new Map(feeds.map((f) => [f.id, f.title]));

  const lines = [
    `🆕 *أحدث الحلقات · ${episodes.length}*`,
    divider(),
    ...episodes.map((ep, i) =>
      `${i + 1}. ${ep.listened ? "✅" : "🔵"} *${truncate(ep.title, 40)}*\n    📻 ${truncate(feedMap.get(ep.feedId) || "—", 30)}`
    ),
    divider(),
    "_اضغط على حلقة للتفاصيل_",
  ];

  const keyboard = episodes.map((ep, i) => [{
    text: `${i + 1}. ${truncate(ep.title, 32)}`,
    callback_data: `ep:${ep.id}`,
  }]);

  keyboard.push([{ text: "🔄 تحديث الكل", callback_data: "refresh_all_inline" }]);

  await bot.sendMessage(chatId, lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function showQueue(bot: TelegramBot, chatId: number) {
  const queue = await db.select({
    queueId: queueTable.id,
    position: queueTable.position,
    episodeId: queueTable.episodeId,
    title: episodesTable.title,
    duration: episodesTable.duration,
    feedId: episodesTable.feedId,
    listened: episodesTable.listened,
  })
    .from(queueTable)
    .innerJoin(episodesTable, eq(queueTable.episodeId, episodesTable.id))
    .where(eq(queueTable.chatId, String(chatId)))
    .orderBy(queueTable.position);

  if (queue.length === 0) {
    await bot.sendMessage(chatId, fmt([
      "📭 *قائمة التشغيل فارغة*",
      divider(),
      "أضف حلقات من /latest أو /feeds",
    ]), { parse_mode: "Markdown" });
    return;
  }

  const lines = [
    `⏭ *قائمة التشغيل · ${queue.length} حلقة*`,
    divider(),
    ...queue.map((q, i) =>
      `${i + 1}. ${q.listened ? "✅" : "🔵"} ${truncate(q.title, 42)}`
    ),
  ];

  const keyboard = queue.map((q, i) => [
    { text: `${i + 1}. ${truncate(q.title, 25)}`, callback_data: `ep:${q.episodeId}` },
    { text: "🗑", callback_data: `queue_rm:${q.episodeId}` },
  ]);

  await bot.sendMessage(chatId, lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function showFavorites(bot: TelegramBot, chatId: number) {
  const favs = await db.select({
    favId: favoritesTable.id,
    episodeId: episodesTable.id,
    title: episodesTable.title,
    duration: episodesTable.duration,
    pubDate: episodesTable.pubDate,
    listened: episodesTable.listened,
    feedId: episodesTable.feedId,
  })
    .from(favoritesTable)
    .innerJoin(episodesTable, eq(favoritesTable.episodeId, episodesTable.id))
    .where(eq(favoritesTable.chatId, String(chatId)))
    .orderBy(desc(favoritesTable.createdAt))
    .limit(10);

  if (favs.length === 0) {
    await bot.sendMessage(chatId, fmt([
      "📭 *المفضلة فارغة*",
      divider(),
      "أضف حلقات للمفضلة من تفاصيل الحلقة ❤️",
    ]), { parse_mode: "Markdown" });
    return;
  }

  const lines = [
    `❤️ *المفضلة · ${favs.length} حلقة*`,
    divider(),
    ...favs.map((f, i) =>
      `${i + 1}. ${f.listened ? "✅" : "🔵"} ${truncate(f.title, 42)}`
    ),
  ];

  const keyboard = favs.map((f, i) => [{
    text: `${i + 1}. ${truncate(f.title, 32)}`,
    callback_data: `ep:${f.episodeId}`,
  }]);

  await bot.sendMessage(chatId, lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function handleSearch(bot: TelegramBot, chatId: number, query: string) {
  const feeds = await db.select({ id: feedsTable.id }).from(feedsTable)
    .where(eq(feedsTable.chatId, String(chatId)));

  if (feeds.length === 0) {
    await bot.sendMessage(chatId, "📭 لا يوجد بودكاستات. أضف واحداً أولاً.", { parse_mode: "Markdown" });
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
      `🔍 *لا نتائج لـ "${truncate(query, 30)}"*`,
      divider(),
      "جرب كلمة بحث مختلفة.",
    ]), { parse_mode: "Markdown" });
    return;
  }

  const lines = [
    `🔍 *نتائج: "${truncate(query, 25)}" · ${results.length}*`,
    divider(),
    ...results.map((ep, i) =>
      `${i + 1}. ${ep.listened ? "✅" : "🔵"} ${truncate(ep.title, 42)}`
    ),
  ];

  const keyboard = results.map((ep, i) => [{
    text: `${i + 1}. ${truncate(ep.title, 32)}`,
    callback_data: `ep:${ep.id}`,
  }]);

  await bot.sendMessage(chatId, lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function showStats(bot: TelegramBot, chatId: number) {
  const feeds = await db.select({ id: feedsTable.id }).from(feedsTable)
    .where(eq(feedsTable.chatId, String(chatId)));

  if (feeds.length === 0) {
    await bot.sendMessage(chatId, "📭 لا يوجد إحصائيات بعد. أضف بودكاست أولاً.", { parse_mode: "Markdown" });
    return;
  }

  const feedIds = feeds.map((f) => f.id);
  const feedIdArr = sql`ARRAY[${sql.join(feedIds.map(id => sql`${id}`), sql`, `)}]::int[]`;

  const totalEps = await db.select({ c: count() }).from(episodesTable)
    .where(sql`${episodesTable.feedId} = ANY(${feedIdArr})`);

  const listenedEps = await db.select({ c: count() }).from(episodesTable)
    .where(and(
      sql`${episodesTable.feedId} = ANY(${feedIdArr})`,
      eq(episodesTable.listened, true)
    ));

  const favCount = await db.select({ c: count() }).from(favoritesTable)
    .where(eq(favoritesTable.chatId, String(chatId)));

  const queueCount = await db.select({ c: count() }).from(queueTable)
    .where(eq(queueTable.chatId, String(chatId)));

  const total = totalEps[0].c;
  const listened = listenedEps[0].c;
  const pct = total > 0 ? Math.round((listened / total) * 100) : 0;

  await bot.sendMessage(chatId, fmt([
    "📊 *إحصائياتي*",
    divider(),
    `📻 البودكاستات  · ${feeds.length}`,
    `🎙 إجمالي الحلقات · ${total}`,
    `✅ مسموعة       · ${listened}`,
    `🔵 جديدة         · ${total - listened}`,
    "",
    `${progressBar(pct)} ${pct}%`,
    divider(),
    `❤️ المفضلة · ${favCount[0].c}`,
    `⏭ قائمة التشغيل · ${queueCount[0].c}`,
  ]), { parse_mode: "Markdown" });
}

async function refreshFeed(bot: TelegramBot, chatId: number, msgId: number, feedId: number) {
  const feed = await db.select().from(feedsTable).where(eq(feedsTable.id, feedId)).limit(1);
  if (!feed[0]) return;

  await bot.editMessageText(fmt([
    `🔄 *جاري تحديث البودكاست...*`,
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
      `✅ *تم التحديث*`,
      divider(),
      `📻 ${truncate(feed[0].title, 40)}`,
      `🆕 ${newCount} حلقة جديدة`,
    ]), { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" });

    setTimeout(() => showFeedEpisodes(bot, chatId, msgId, feedId, 0), 1500);
  } catch (err: any) {
    await bot.editMessageText(fmt([
      "❌ *فشل التحديث*",
      divider(),
      `_${truncate(String(err?.message || err), 80)}_`,
    ]), { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" });
  }
}

async function refreshAllFeeds(bot: TelegramBot, chatId: number) {
  const feeds = await db.select().from(feedsTable).where(eq(feedsTable.chatId, String(chatId)));

  if (feeds.length === 0) {
    await bot.sendMessage(chatId, "📭 لا يوجد بودكاستات لتحديثها.", { parse_mode: "Markdown" });
    return;
  }

  const msg = await bot.sendMessage(chatId, fmt([
    `🔄 *تحديث ${feeds.length} بودكاست...*`,
    divider(),
    "⏳ جاري التحميل...",
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
      // skip failed feeds
    }
  }

  await bot.editMessageText(fmt([
    `✅ *تم التحديث*`,
    divider(),
    `📻 ${feeds.length} بودكاست`,
    `🆕 ${totalNew} حلقة جديدة`,
    "",
    "اكتب /latest لعرض أحدث الحلقات",
  ]), { chat_id: chatId, message_id: msg.message_id, parse_mode: "Markdown" });
}

async function toggleFavorite(bot: TelegramBot, chatId: number, msgId: number, epId: number) {
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

  // delete related data
  const eps = await db.select({ id: episodesTable.id }).from(episodesTable)
    .where(eq(episodesTable.feedId, feedId));
  const epIds = eps.map((e) => e.id);

  if (epIds.length > 0) {
    for (const epId of epIds) {
      await db.delete(favoritesTable).where(eq(favoritesTable.episodeId, epId));
      await db.delete(queueTable).where(eq(queueTable.episodeId, epId));
    }
    await db.delete(episodesTable).where(eq(episodesTable.feedId, feedId));
  }

  await db.delete(feedsTable).where(eq(feedsTable.id, feedId));

  await bot.editMessageText(fmt([
    `🗑 *تم الحذف*`,
    divider(),
    `📻 ${truncate(feed[0].title, 45)}`,
    "",
    "اكتب /feeds لعرض بودكاستاتك",
  ]), { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" });
}
