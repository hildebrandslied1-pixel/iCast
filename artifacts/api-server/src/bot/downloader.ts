/**
 * Audio downloader — sends podcast audio directly to Telegram.
 *
 * Strategy:
 *  ≤ 49 MB  → full file sent as document (forces save-to-device dialog)
 *  > 49 MB  → first 49 MB chunk sent as "Part 1", remaining parts follow
 *
 * MP3 is a streamable format; each 49 MB chunk plays as a valid audio clip.
 */

import TelegramBot from "node-telegram-bot-api";
import { fmt, divider, truncate } from "./formatter.js";

const MAX_TG_BYTES = 49 * 1024 * 1024; // 49 MB — Telegram bot upload limit

export interface DownloadOptions {
  chatId: number;
  episodeTitle: string;
  feedTitle: string;
  audioUrl: string;
  episodeId: number;
  onProgress?: (text: string, msgId?: number) => Promise<number | undefined>;
}

export async function sendEpisodeAudio(opts: DownloadOptions): Promise<void> {
  const { chatId, episodeTitle, feedTitle, audioUrl, onProgress } = opts;
  const bot = getBotInstance();

  // ── Step 1: probe file size ─────────────────────────────────────────────
  let contentLength = 0;
  try {
    const head = await fetch(audioUrl, {
      method: "HEAD",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    contentLength = parseInt(head.headers.get("content-length") ?? "0", 10);
  } catch {
    // ignore — fall back to single download
  }

  const filename = sanitiseFilename(episodeTitle) + ".mp3";
  const caption  = fmt([
    `📥 *${truncate(episodeTitle, 50)}*`,
    divider(),
    `📻 ${truncate(feedTitle, 40)}`,
  ]);

  if (contentLength > 0 && contentLength > MAX_TG_BYTES) {
    // ── Multi-part download ──────────────────────────────────────────────
    const totalParts = Math.ceil(contentLength / MAX_TG_BYTES);

    for (let part = 0; part < totalParts; part++) {
      const start = part * MAX_TG_BYTES;
      const end   = Math.min((part + 1) * MAX_TG_BYTES - 1, contentLength - 1);

      await onProgress?.(`⏳ Downloading part ${part + 1}/${totalParts}…`);

      const buf = await downloadRange(audioUrl, start, end);

      const partCaption = fmt([
        `📥 *${truncate(episodeTitle, 46)}*`,
        divider(),
        `📻 ${truncate(feedTitle, 36)}`,
        `📦 Part ${part + 1} of ${totalParts}`,
        `_(${(buf.length / 1048576).toFixed(1)} MB)_`,
      ]);

      await bot.sendDocument(
        chatId,
        buf as any,
        { caption: partCaption, parse_mode: "Markdown" },
        { filename: `${sanitiseFilename(episodeTitle)}_part${part + 1}.mp3`, contentType: "audio/mpeg" }
      );
    }
  } else {
    // ── Single download ──────────────────────────────────────────────────
    await onProgress?.("⏳ Downloading audio…");

    const res = await fetch(audioUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);

    const buf = Buffer.from(await res.arrayBuffer());

    if (buf.length > MAX_TG_BYTES) {
      // Larger than expected — split from buffer
      const totalParts = Math.ceil(buf.length / MAX_TG_BYTES);
      for (let part = 0; part < totalParts; part++) {
        const slice = buf.slice(part * MAX_TG_BYTES, (part + 1) * MAX_TG_BYTES);

        await onProgress?.(`📤 Uploading part ${part + 1}/${totalParts} to Telegram…`);

        await bot.sendDocument(
          chatId,
          slice as any,
          {
            caption: fmt([
              `📥 *${truncate(episodeTitle, 46)}*`,
              divider(),
              `📻 ${truncate(feedTitle, 36)}`,
              `📦 Part ${part + 1} of ${totalParts}`,
            ]),
            parse_mode: "Markdown",
          },
          { filename: `${sanitiseFilename(episodeTitle)}_part${part + 1}.mp3`, contentType: "audio/mpeg" }
        );
      }
    } else {
      await onProgress?.("📤 Uploading to Telegram…");

      await bot.sendDocument(
        chatId,
        buf as any,
        {
          caption: caption + `\n_(${(buf.length / 1048576).toFixed(1)} MB)_`,
          parse_mode: "Markdown",
        },
        { filename, contentType: "audio/mpeg" }
      );
    }
  }
}

async function downloadRange(url: string, start: number, end: number): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Range": `bytes=${start}-${end}` },
  });
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} for range ${start}-${end}`);
  return Buffer.from(await res.arrayBuffer());
}

function sanitiseFilename(title: string): string {
  return title.replace(/[^a-zA-Z0-9\u0600-\u06FF\s_-]/g, "").trim().slice(0, 60).replace(/\s+/g, "_") || "episode";
}

// ── Bot singleton ──────────────────────────────────────────────────────────
// Set by index.ts after bot is created
let _bot: TelegramBot | null = null;

export function registerBotForDownloader(bot: TelegramBot): void {
  _bot = bot;
}

function getBotInstance(): TelegramBot {
  if (!_bot) throw new Error("Bot not yet initialised for downloader.");
  return _bot;
}
