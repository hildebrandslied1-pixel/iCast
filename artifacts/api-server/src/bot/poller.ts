/**
 * poller.ts — Background feed poller
 * Checks for new episodes every 15 minutes and notifies subscribers.
 * Uses node-schedule for reliable scheduling.
 */

import TelegramBot from "node-telegram-bot-api";
import schedule from "node-schedule";
import { db, feedsTable, episodesTable, userPrefsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { fetchFeed } from "./rss.js";
import { DIV, esc, trunc, fmtDate, episodeCard } from "./formatter.js";
import { logger } from "../lib/logger.js";

export function startPoller(bot: TelegramBot): void {
  // First check 2 minutes after startup
  setTimeout(() => void pollAll(bot), 2 * 60 * 1000);

  // Then every 15 minutes
  schedule.scheduleJob("*/15 * * * *", () => void pollAll(bot));

  logger.info("Feed poller scheduled — runs every 15 minutes");
}

async function pollAll(bot: TelegramBot): Promise<void> {
  logger.info("Poller: checking all feeds for new episodes…");

  let feeds: { id: number; chatId: string; url: string; title: string; lastEpisodeGuid: string | null }[] = [];
  try {
    feeds = await db.select({
      id: feedsTable.id,
      chatId: feedsTable.chatId,
      url: feedsTable.url,
      title: feedsTable.title,
      lastEpisodeGuid: feedsTable.lastEpisodeGuid,
    }).from(feedsTable);
  } catch (err) {
    logger.error({ err }, "Poller: DB query failed");
    return;
  }

  for (let i = 0; i < feeds.length; i++) {
    const feed = feeds[i];
    // Stagger requests by 500ms to avoid hammering RSS servers
    await new Promise((r) => setTimeout(r, i * 500));
    checkFeed(bot, feed).catch((err) => {
      logger.warn({ feedId: feed.id, err }, "Poller: error checking feed");
    });
  }
}

async function checkFeed(
  bot: TelegramBot,
  feed: { id: number; chatId: string; url: string; title: string; lastEpisodeGuid: string | null }
): Promise<void> {
  let feedData;
  try {
    feedData = await fetchFeed(feed.url, true);
  } catch (err) {
    logger.warn({ feedId: feed.id, url: feed.url, err }, "Poller: fetchFeed failed");
    return;
  }

  if (!feedData.episodes.length) return;

  const newest = feedData.episodes[0];
  if (!newest?.guid) return;

  // First run — just record the latest guid, don't notify
  if (!feed.lastEpisodeGuid) {
    await db.update(feedsTable)
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
    await db.insert(episodesTable).values(
      newEpisodes.slice(i, i + CHUNK).map((ep) => ({
        feedId: feed.id,
        guid: ep.guid,
        title: ep.title,
        description: ep.description,
        audioUrl: ep.audioUrl,
        imageUrl: ep.imageUrl,
        pubDate: ep.pubDate,
        duration: ep.duration,
        episodeNumber: ep.episodeNumber,
        chapters: ep.chapters ? JSON.stringify(ep.chapters) : null,
      }))
    ).onConflictDoNothing();
  }

  await db.update(feedsTable)
    .set({ lastEpisodeGuid: newest.guid, lastChecked: new Date() })
    .where(eq(feedsTable.id, feed.id));

  // Check user notification preference
  const prefs = await db.select({ notifications: userPrefsTable.notifications })
    .from(userPrefsTable)
    .where(eq(userPrefsTable.chatId, feed.chatId))
    .limit(1);

  const notifPref = prefs[0]?.notifications ?? "all";
  if (notifPref === "none") return;

  // Retrieve inserted episode IDs for notification buttons
  const insertedRows = await db.select({ id: episodesTable.id, title: episodesTable.title })
    .from(episodesTable)
    .where(and(eq(episodesTable.feedId, feed.id), eq(episodesTable.guid, newEpisodes[0].guid)))
    .limit(1);

  const chatId = Number(feed.chatId);

  // Build notification message
  const lines = [
    `🆕 *New Episode*`,
    DIV,
    `📻 *${esc(trunc(feed.title, 28))}*`,
    ``,
  ];

  if (newEpisodes.length === 1) {
    lines.push(`🎙 *${esc(trunc(newEpisodes[0].title, 30))}*`);
    if (newEpisodes[0].pubDate) lines.push(`📅 ${fmtDate(newEpisodes[0].pubDate)}`);
  } else {
    lines.push(`🎙 ${newEpisodes.length} new episodes:`);
    newEpisodes.slice(0, 4).forEach((ep, i) => {
      lines.push(`  ${i + 1}\\. ${esc(trunc(ep.title, 28))}`);
    });
    if (newEpisodes.length > 4) lines.push(`  \\+${newEpisodes.length - 4} more`);
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
    await bot.sendMessage(chatId, lines.join("\n"), {
      parse_mode: "MarkdownV2",
      reply_markup: { inline_keyboard: keyboard },
      disable_web_page_preview: true,
    });
    logger.info({ chatId, feedId: feed.id, newCount: newEpisodes.length }, "Poller: notification sent");
  } catch (err) {
    logger.warn({ chatId, err }, "Poller: failed to send notification");
  }
}
