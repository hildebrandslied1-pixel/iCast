/**
 * Background feed poller — checks every 15 minutes for new episodes
 * and sends Telegram notifications to subscribers.
 */

import TelegramBot from "node-telegram-bot-api";
import { db, feedsTable, episodesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { fetchFeed } from "./rss.js";
import { fmt, divider, truncate, formatDate } from "./formatter.js";
import { logger } from "../lib/logger.js";

const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

export function startPoller(bot: TelegramBot): void {
  // First check 2 minutes after startup, then every 15 minutes
  setTimeout(() => {
    void pollAll(bot);
    setInterval(() => void pollAll(bot), POLL_INTERVAL_MS);
  }, 2 * 60 * 1000);

  logger.info("Feed poller scheduled — runs every 15 minutes");
}

async function pollAll(bot: TelegramBot): Promise<void> {
  logger.info("Poller: checking all feeds for new episodes…");

  let feeds: { id: number; chatId: string; url: string; title: string; lastEpisodeGuid: string | null }[] = [];
  try {
    feeds = await db
      .select({
        id: feedsTable.id,
        chatId: feedsTable.chatId,
        url: feedsTable.url,
        title: feedsTable.title,
        lastEpisodeGuid: feedsTable.lastEpisodeGuid,
      })
      .from(feedsTable);
  } catch (err) {
    logger.error({ err }, "Poller: DB query failed");
    return;
  }

  for (const feed of feeds) {
    try {
      await checkFeed(bot, feed);
      // Stagger requests to avoid hammering RSS servers
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      logger.warn({ feedId: feed.id, err }, "Poller: error checking feed");
    }
  }
}

async function checkFeed(
  bot: TelegramBot,
  feed: { id: number; chatId: string; url: string; title: string; lastEpisodeGuid: string | null }
): Promise<void> {
  const feedData = await fetchFeed(feed.url);
  if (!feedData.episodes.length) return;

  // Newest episode according to the RSS feed
  const newest = feedData.episodes[0];
  if (!newest?.guid) return;

  // First run — just record the latest guid, don't notify
  if (!feed.lastEpisodeGuid) {
    await db
      .update(feedsTable)
      .set({ lastEpisodeGuid: newest.guid, lastChecked: new Date() })
      .where(eq(feedsTable.id, feed.id));
    return;
  }

  // Find all episodes newer than the last known one
  const newEpisodes: typeof feedData.episodes = [];
  for (const ep of feedData.episodes) {
    if (ep.guid === feed.lastEpisodeGuid) break;
    newEpisodes.push(ep);
  }

  if (!newEpisodes.length) return;

  // Insert new episodes into DB
  const CHUNK = 100;
  for (let i = 0; i < newEpisodes.length; i += CHUNK) {
    await db
      .insert(episodesTable)
      .values(
        newEpisodes.slice(i, i + CHUNK).map((ep) => ({
          feedId: feed.id,
          guid: ep.guid,
          title: ep.title,
          description: ep.description,
          audioUrl: ep.audioUrl,
          pubDate: ep.pubDate,
          duration: ep.duration,
        }))
      )
      .onConflictDoNothing();
  }

  // Update last known guid
  await db
    .update(feedsTable)
    .set({ lastEpisodeGuid: newest.guid, lastChecked: new Date() })
    .where(eq(feedsTable.id, feed.id));

  // Retrieve inserted episode IDs for notification buttons
  const insertedRows = await db
    .select({ id: episodesTable.id, title: episodesTable.title, pubDate: episodesTable.pubDate })
    .from(episodesTable)
    .where(
      and(
        eq(episodesTable.feedId, feed.id),
        eq(episodesTable.guid, newEpisodes[0].guid)
      )
    )
    .limit(1);

  const chatId = Number(feed.chatId);

  // Build notification
  const lines: string[] = [
    "🆕 *New Episode Available*",
    divider(),
    `📻 *${truncate(feed.title, 42)}*`,
    "",
  ];

  if (newEpisodes.length === 1) {
    lines.push(`🎙 *${truncate(newEpisodes[0].title, 48)}*`);
    if (newEpisodes[0].pubDate) lines.push(`📅 ${formatDate(newEpisodes[0].pubDate)}`);
  } else {
    lines.push(`🎙 ${newEpisodes.length} new episodes:`);
    newEpisodes.slice(0, 5).forEach((ep, i) => {
      lines.push(`  ${i + 1}. ${truncate(ep.title, 42)}`);
    });
    if (newEpisodes.length > 5) lines.push(`  _…and ${newEpisodes.length - 5} more_`);
  }

  const keyboard: TelegramBot.InlineKeyboardButton[][] = [];

  if (insertedRows[0]) {
    keyboard.push([
      { text: "▶️ View Episode", callback_data: `ep:${insertedRows[0].id}` },
      { text: "📻 Browse Feed",  callback_data: `feed:${feed.id}` },
    ]);
  }

  keyboard.push([{ text: "🏠 Home", callback_data: "menu" }]);

  try {
    await bot.sendMessage(chatId, fmt(lines), {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard },
    });
  } catch (err) {
    logger.warn({ chatId, err }, "Poller: failed to send notification");
  }
}
