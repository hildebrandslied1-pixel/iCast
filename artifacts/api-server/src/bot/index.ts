import TelegramBot from "node-telegram-bot-api";
import { registerHandlers } from "./handlers.js";
import { logger } from "../lib/logger.js";

let bot: TelegramBot | null = null;

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

  registerHandlers(bot);

  logger.info("Telegram podcast bot started");
  return bot;
}

export function getBot(): TelegramBot | null {
  return bot;
}
