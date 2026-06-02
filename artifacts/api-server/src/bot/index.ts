import TelegramBot from "node-telegram-bot-api";
import { registerHandlers } from "./handlers.js";
import { startPoller } from "./poller.js";
import { registerBotForDownloader } from "./downloader.js";
import { logger } from "../lib/logger.js";

let bot: TelegramBot | null = null;

const COMMANDS: TelegramBot.BotCommand[] = [
  { command: "start",      description: "🏠 Open control panel" },
  { command: "feeds",      description: "📻 My subscriptions" },
  { command: "latest",     description: "🆕 Latest episodes" },
  { command: "trending",   description: "🌍 Trending by country" },
  { command: "browse",     description: "🌐 Browse iTunes catalogue" },
  { command: "add",        description: "➕ Add podcast via RSS URL" },
  { command: "search",     description: "🔎 Search my episodes" },
  { command: "favourites", description: "❤️ Favourited episodes" },
  { command: "queue",      description: "⏭ Playback queue" },
  { command: "tags",       description: "🏷 Tags & folders" },
  { command: "stats",      description: "📊 Listening statistics" },
  { command: "refresh",    description: "🔄 Refresh all feeds" },
];

export function startBot(): TelegramBot | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.warn("TELEGRAM_BOT_TOKEN not set — bot disabled");
    return null;
  }

  bot = new TelegramBot(token, { polling: true });

  bot.on("polling_error", (err) => {
    logger.error({ err: err.message }, "Telegram polling error");
  });

  bot.on("error", (err) => {
    logger.error({ err: err.message }, "Telegram bot error");
  });

  registerBotForDownloader(bot);
  registerHandlers(bot);

  // Register commands with Telegram (shows in the command menu)
  bot.setMyCommands(COMMANDS).catch((err) => {
    logger.warn({ err }, "Could not register bot commands");
  });

  // Start background poller (new-episode notifications every 15 min)
  startPoller(bot);

  logger.info("Telegram podcast bot started");
  return bot;
}

export function getBot(): TelegramBot | null {
  return bot;
}
