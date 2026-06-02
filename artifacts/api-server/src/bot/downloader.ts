/**
 * Audio downloader — sends podcast audio directly to Telegram as an audio
 * message (plays inline with Telegram's built-in player).
 *
 * Strategy:
 *  1. Probe file size with HEAD request
 *  2. Download the full file (all Range chunks) into memory
 *  3. Concatenate all chunks into one Buffer (valid for MP3 streams)
 *  4. If total ≤ 49 MB → send as ONE sendAudio (inline player, best UX)
 *  5. If total > 49 MB → send each 49 MB chunk as separate sendAudio part
 *
 * This guarantees Telegram shows a native audio player, not a download link.
 */

import TelegramBot from "node-telegram-bot-api";
import { fmt, divider, truncate } from "./formatter.js";

const MAX_TG_BYTES = 49 * 1024 * 1024; // 49 MB

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
    });
    contentLength = parseInt(head.headers.get("content-length") ?? "0", 10);
  } catch { /* ignore */ }

  const ext      = (audioUrl.split("?")[0].match(/\.(mp3|m4a|ogg|wav|aac|flac)$/i)?.[1] ?? "mp3").toLowerCase();
  const filename = sanitise(episodeTitle) + "." + ext;
  const mimeType = ext === "m4a" ? "audio/mp4"
                 : ext === "ogg" ? "audio/ogg"
                 : ext === "wav" ? "audio/wav"
                 : ext === "aac" ? "audio/aac"
                 : "audio/mpeg";

  // ── Download all data ──────────────────────────────────────────────────────
  const allChunks: Buffer[] = [];
  let downloaded = 0;

  if (contentLength > 0) {
    // Range-based download so we can report progress
    const numParts = Math.ceil(contentLength / MAX_TG_BYTES);
    for (let i = 0; i < numParts; i++) {
      const start = i * MAX_TG_BYTES;
      const end   = Math.min((i + 1) * MAX_TG_BYTES - 1, contentLength - 1);
      await onProgress?.(`⏳ Downloading${numParts > 1 ? ` part ${i + 1}/${numParts}` : ""}… (${mb(end + 1)} MB)`);
      const buf = await downloadRange(audioUrl, start, end);
      allChunks.push(buf);
      downloaded += buf.length;
    }
  } else {
    // Unknown size — download in one shot
    await onProgress?.("⏳ Downloading audio…");
    const res = await fetch(audioUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    allChunks.push(buf);
    downloaded = buf.length;
  }

  // ── Concatenate ─────────────────────────────────────────────────────────────
  const combined = Buffer.concat(allChunks);

  if (combined.length <= MAX_TG_BYTES) {
    // ── Single audio message (best experience) ───────────────────────────────
    await onProgress?.(`📤 Sending to Telegram… (${mb(combined.length)} MB)`);
    await sendAudio(bot, chatId, combined, filename, mimeType, fmt([
      `🎧 *${truncate(episodeTitle, 50)}*`,
      `📻 ${truncate(feedTitle, 40)}`,
      `_(${mb(combined.length)} MB)_`,
    ]));
  } else {
    // ── Multi-part audio — each part plays inline ────────────────────────────
    const parts    = splitBuffer(combined, MAX_TG_BYTES);
    const total    = parts.length;
    for (let i = 0; i < total; i++) {
      await onProgress?.(`📤 Uploading part ${i + 1}/${total} to Telegram…`);
      await sendAudio(bot, chatId, parts[i],
        `${sanitise(episodeTitle)}_part${i + 1}_of_${total}.${ext}`,
        mimeType,
        fmt([
          `🎧 *${truncate(episodeTitle, 46)}*`,
          `📻 ${truncate(feedTitle, 36)}`,
          `📦 Part ${i + 1} of ${total} · _(${mb(parts[i].length)} MB)_`,
        ])
      );
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function sendAudio(
  bot: TelegramBot,
  chatId: number,
  buf: Buffer,
  filename: string,
  contentType: string,
  caption: string
): Promise<void> {
  await bot.sendAudio(
    chatId,
    buf as any,
    { caption, parse_mode: "Markdown" },
    { filename, contentType }
  );
}

async function downloadRange(url: string, start: number, end: number): Promise<Buffer> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", "Range": `bytes=${start}-${end}` },
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
  for (let i = 0; i < buf.length; i += size) {
    parts.push(buf.slice(i, i + size));
  }
  return parts;
}

function sanitise(title: string): string {
  return title.replace(/[^\w\s\u0600-\u06FF-]/g, "").trim().slice(0, 60).replace(/\s+/g, "_") || "episode";
}

function mb(bytes: number): string {
  return (bytes / 1048576).toFixed(1);
}

// ── Bot singleton (set by index.ts) ──────────────────────────────────────────
let _bot: TelegramBot | null = null;
export function registerBotForDownloader(bot: TelegramBot): void { _bot = bot; }
function getBotInstance(): TelegramBot {
  if (!_bot) throw new Error("Bot not initialised for downloader.");
  return _bot;
}
