import TelegramBot from "node-telegram-bot-api";
import { registerHandlers } from "./handlers.js";
import { startPoller } from "./poller.js";
import { registerBotForDownloader } from "./downloader.js";
import { logger } from "../lib/logger.js";

let bot: TelegramBot | null = null;

const COMMANDS: TelegramBot.BotCommand[] = [
  { command: "start",      description: "Start here" },
  { command: "feeds",      description: "My subscriptions" },
  { command: "latest",     description: "Latest episodes" },
  { command: "add",        description: "Add a podcast via RSS" },
  { command: "search",     description: "Search episodes" },
  { command: "queue",      description: "Playback queue" },
  { command: "favourites", description: "Favourited episodes" },
  { command: "stats",      description: "My statistics" },
  { command: "discover",   description: "Discover new podcasts" },
  { command: "resume",     description: "Continue listening" },
  { command: "refresh",    description: "Refresh all feeds" },
  { command: "settings",   description: "Preferences" },
  { command: "notes",      description: "My notes & bookmarks" },
  { command: "tsearch",    description: "Search transcripts" },
  { command: "ask",        description: "Ask AI about episode" },
  { command: "playlist",   description: "Build a playlist" },
  { command: "import",     description: "Import OPML file" },
  { command: "help",       description: "Help & commands" },
  { command: "about",      description: "About iCast" },
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

  bot.setMyCommands(COMMANDS).catch((err) => {
    logger.warn({ err }, "Could not register bot commands");
  });

  startPoller(bot);

  logger.info("iCast Telegram bot started (polling mode)");

  process.on("SIGTERM", async () => {
    logger.info("SIGTERM received — shutting down gracefully…");
    await bot?.stopPolling();
    process.exit(0);
  });

  process.on("SIGINT", () => {
    process.exit(0);
  });

  return bot;
}

export function getBot(): TelegramBot | null {
  return bot;
}
