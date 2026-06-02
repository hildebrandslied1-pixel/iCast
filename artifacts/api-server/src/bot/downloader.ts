/**
 * downloader.ts — Sends podcast audio to Telegram as an audio message.
 * Checks file size before downloading; splits large files into ≤49 MB parts.
 */

import TelegramBot from "node-telegram-bot-api";
import { trunc, esc } from "./formatter.js";

const MAX_TG_BYTES = 49 * 1024 * 1024; // 49 MB
const MAX_FILE_MB  = 200;               // Refuse files larger than 200 MB

export interface DownloadOptions {
  chatId: number;
  episodeTitle: string;
  feedTitle: string;
  audioUrl: string;
  episodeId: number;
  onProgress?: (text: string) => Promise<void>;
}

export async function sendEpisodeAudio(opts: DownloadOptions): Promise<void> {
  const { chatId, episodeTitle, feedTitle, audioUrl, onProgress } = opts;
  const bot = getBotInstance();

  // ── Probe size ─────────────────────────────────────────────────────────────
  let contentLength = 0;
  try {
    const head = await fetch(audioUrl, {
      method: "HEAD",
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(15_000),
    });
    contentLength = parseInt(head.headers.get("content-length") ?? "0", 10);
  } catch { /* ignore */ }

  if (contentLength > MAX_FILE_MB * 1024 * 1024) {
    throw new Error(`File too large (${mb(contentLength)} MB). Maximum is ${MAX_FILE_MB} MB.`);
  }

  const ext      = (audioUrl.split("?")[0].match(/\.(mp3|m4a|ogg|wav|aac|flac)$/i)?.[1] ?? "mp3").toLowerCase();
  const filename = sanitise(episodeTitle) + "." + ext;
  const mimeType = ext === "m4a" ? "audio/mp4"
                 : ext === "ogg" ? "audio/ogg"
                 : ext === "wav" ? "audio/wav"
                 : ext === "aac" ? "audio/aac"
                 : "audio/mpeg";

  // ── Download ────────────────────────────────────────────────────────────────
  const allChunks: Buffer[] = [];

  if (contentLength > 0) {
    const numParts = Math.ceil(contentLength / MAX_TG_BYTES);
    for (let i = 0; i < numParts; i++) {
      const start = i * MAX_TG_BYTES;
      const end   = Math.min((i + 1) * MAX_TG_BYTES - 1, contentLength - 1);
      await onProgress?.(`⏳ Downloading${numParts > 1 ? ` part ${i + 1}/${numParts}` : ""}… (${mb(end + 1)} MB)`);
      allChunks.push(await downloadRange(audioUrl, start, end));
    }
  } else {
    await onProgress?.("⏳ Downloading audio…");
    const res = await fetch(audioUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    allChunks.push(Buffer.from(await res.arrayBuffer()));
  }

  const combined = Buffer.concat(allChunks);

  // ── Send ────────────────────────────────────────────────────────────────────
  const caption = `🎧 *${esc(trunc(episodeTitle, 48))}*\n📻 ${esc(trunc(feedTitle, 36))}`;

  if (combined.length <= MAX_TG_BYTES) {
    await onProgress?.(`📤 Sending… (${mb(combined.length)} MB)`);
    await sendAudio(bot, chatId, combined, filename, mimeType, caption);
  } else {
    const parts = splitBuffer(combined, MAX_TG_BYTES);
    for (let i = 0; i < parts.length; i++) {
      await onProgress?.(`📤 Uploading part ${i + 1}/${parts.length}…`);
      await sendAudio(
        bot, chatId, parts[i],
        `${sanitise(episodeTitle)}_part${i + 1}_of_${parts.length}.${ext}`,
        mimeType,
        `${caption}\n📦 Part ${i + 1} of ${parts.length}`
      );
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function sendAudio(
  bot: TelegramBot, chatId: number, buf: Buffer,
  filename: string, contentType: string, caption: string
): Promise<void> {
  await bot.sendAudio(chatId, buf as any,
    { caption, parse_mode: "MarkdownV2" },
    { filename, contentType }
  );
}

async function downloadRange(url: string, start: number, end: number): Promise<Buffer> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", Range: `bytes=${start}-${end}` },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw new Error("Download failed after 3 attempts");
}

function splitBuffer(buf: Buffer, size: number): Buffer[] {
  const parts: Buffer[] = [];
  for (let i = 0; i < buf.length; i += size) parts.push(buf.slice(i, i + size));
  return parts;
}

function sanitise(title: string): string {
  return title.replace(/[^\w\s\u0600-\u06FF-]/g, "").trim().slice(0, 60).replace(/\s+/g, "_") || "episode";
}

function mb(bytes: number): string {
  return (bytes / 1048576).toFixed(1);
}

// ── Bot singleton ─────────────────────────────────────────────────────────────

let _bot: TelegramBot | null = null;
export function registerBotForDownloader(bot: TelegramBot): void { _bot = bot; }
function getBotInstance(): TelegramBot {
  if (!_bot) throw new Error("Bot not initialised for downloader.");
  return _bot;
}
