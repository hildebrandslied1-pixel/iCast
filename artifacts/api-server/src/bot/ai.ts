/**
 * AI module — Groq Whisper transcription + Llama summaries & chat
 * Whisper limit is 25MB per request; chunks are kept at 23MB.
 * Every operation retries up to 3 times with back-off.
 */

import Groq, { toFile } from "groq-sdk";
import fs from "fs";
import path from "path";
import os from "os";

const CHUNK_BYTES = 23 * 1024 * 1024; // 23 MB — safely under Whisper's 25 MB limit

const MODELS = {
  transcribe: "whisper-large-v3",
  summarize: "llama-3.3-70b-versatile",
  chat: "llama-3.1-8b-instant",
  recommend: "llama-3.1-8b-instant",
} as const;

function getGroq(): Groq {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");
  return new Groq({ apiKey });
}

async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw new Error("unreachable");
}

async function transcribeBuffer(buf: Buffer, ext = "mp3"): Promise<string> {
  return withRetry(async () => {
    const groq = getGroq();
    const file = await toFile(buf, `chunk.${ext}`, { type: `audio/${ext}` });
    const resp: any = await groq.audio.transcriptions.create({
      file,
      model: MODELS.transcribe,
      response_format: "text",
    });
    return (typeof resp === "string" ? resp : (resp?.text ?? "")).trim();
  });
}

export interface TranscribeOptions {
  onProgress?: (msg: string) => Promise<void>;
  language?: string;
}

export async function transcribeEpisodeFull(
  audioUrl: string,
  opts: TranscribeOptions = {}
): Promise<string> {
  const { onProgress } = opts;
  const filename = audioUrl.split("?")[0].split("/").pop() ?? "episode.mp3";
  const ext = filename.match(/\.(mp3|mp4|m4a|ogg|wav|webm|flac|aac)(\?.*)?$/i)?.[1]?.toLowerCase() ?? "mp3";

  // Probe file size via HEAD
  let contentLength = 0;
  try {
    const head = await fetch(audioUrl, {
      method: "HEAD",
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(15_000),
    });
    contentLength = parseInt(head.headers.get("content-length") ?? "0", 10);
  } catch { /* ignore — will download whole file */ }

  const transcripts: string[] = [];

  if (contentLength > 0 && contentLength > CHUNK_BYTES) {
    const numChunks = Math.ceil(contentLength / CHUNK_BYTES);
    for (let i = 0; i < numChunks; i++) {
      const start = i * CHUNK_BYTES;
      const end   = Math.min((i + 1) * CHUNK_BYTES - 1, contentLength - 1);
      await onProgress?.(`⏳ Downloading part ${i + 1}/${numChunks}…`);
      const buf = await fetchRangeWithRetry(audioUrl, start, end);
      await onProgress?.(`🧠 Transcribing part ${i + 1}/${numChunks}…`);
      transcripts.push(await transcribeBuffer(buf, ext));
    }
  } else {
    await onProgress?.("⏳ Downloading audio…");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    let buf: Buffer;
    try {
      const res = await fetch(audioUrl, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(timeout);
    }

    if (buf.length > CHUNK_BYTES) {
      const numChunks = Math.ceil(buf.length / CHUNK_BYTES);
      for (let i = 0; i < numChunks; i++) {
        const slice = buf.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
        await onProgress?.(`🧠 Transcribing part ${i + 1}/${numChunks}…`);
        transcripts.push(await transcribeBuffer(slice, ext));
      }
    } else {
      await onProgress?.("🧠 Transcribing audio…");
      transcripts.push(await transcribeBuffer(buf, ext));
    }
  }

  return transcripts.join("\n\n").trim();
}

export async function transcribeUrl(audioUrl: string): Promise<string> {
  const tmpFile = path.join(os.tmpdir(), `icast-${Date.now()}.mp3`);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    let res: Response;
    try {
      res = await fetch(audioUrl, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tmpFile, buf);
    const ext = audioUrl.split("?")[0].match(/\.(mp3|mp4|m4a|ogg|wav|webm|flac|aac)$/i)?.[1]?.toLowerCase() ?? "mp3";
    return await transcribeBuffer(buf, ext);
  } finally {
    fs.unlink(tmpFile, () => {});
  }
}

async function fetchRangeWithRetry(url: string, start: number, end: number, attempt = 0): Promise<Buffer> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", Range: `bytes=${start}-${end}` },
        signal: controller.signal,
      });
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} for range ${start}-${end}`);
      return Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      return fetchRangeWithRetry(url, start, end, attempt + 1);
    }
    throw err;
  }
}

export async function summarizeText(
  text: string,
  title: string,
  lang = "auto"
): Promise<string> {
  const langLine =
    lang === "ar" ? "Reply in Arabic only. أجب بالعربية فقط."
    : lang === "en" ? "Reply in English only."
    : "Reply in the same language as the transcript.";

  return withRetry(async () => {
    const groq = getGroq();
    const resp = await groq.chat.completions.create({
      model: MODELS.summarize,
      max_tokens: 350,
      messages: [
        {
          role: "user",
          content: `${langLine}\nSummarise this podcast episode in ~100 words. Be concise and clear.\nTitle: ${title}\n\n${text.slice(0, 6000)}`,
        },
      ],
    });
    return resp.choices[0]?.message?.content?.trim() ?? "";
  });
}

export async function generateSummary(
  transcript: string,
  podcastTitle: string,
  episodeTitle: string
): Promise<string> {
  return withRetry(async () => {
    const groq = getGroq();
    const resp = await groq.chat.completions.create({
      model: MODELS.summarize,
      max_tokens: 800,
      messages: [
        {
          role: "system",
          content: "You are an expert podcast analyst. Write concise, insightful summaries. Use the same language as the transcript. Format with clear sections.",
        },
        {
          role: "user",
          content: `Podcast: "${podcastTitle}"\nEpisode: "${episodeTitle}"\n\nTranscript:\n${transcript.slice(0, 12000)}\n\nProvide:\n1. **Overview** (2-3 sentences)\n2. **Key Topics** (bullet list)\n3. **Main Takeaways** (3-5 bullets)`,
        },
      ],
    });
    return resp.choices[0]?.message?.content?.trim() ?? "Summary unavailable.";
  });
}

export async function generateDetailedExplanation(
  transcript: string,
  podcastTitle: string,
  episodeTitle: string
): Promise<string> {
  return withRetry(async () => {
    const groq = getGroq();
    const resp = await groq.chat.completions.create({
      model: MODELS.summarize,
      max_tokens: 1200,
      messages: [
        {
          role: "system",
          content: "You are a meticulous analyst. Extract every topic from the podcast transcript and explain it in depth. Use the same language as the transcript.",
        },
        {
          role: "user",
          content: `Podcast: "${podcastTitle}"\nEpisode: "${episodeTitle}"\n\nTranscript:\n${transcript.slice(0, 15000)}\n\nProvide a comprehensive breakdown covering every topic discussed, facts and figures, arguments, and action points.`,
        },
      ],
    });
    return resp.choices[0]?.message?.content?.trim() ?? "Detailed explanation unavailable.";
  });
}

export async function chatWithEpisode(
  question: string,
  title: string,
  transcript: string,
  history: Array<{ role: "user" | "assistant"; content: string }> = []
): Promise<string> {
  return withRetry(async () => {
    const groq = getGroq();
    const resp = await groq.chat.completions.create({
      model: MODELS.chat,
      max_tokens: 400,
      messages: [
        {
          role: "system",
          content: `You help answer questions about this podcast episode: "${title}"\nTranscript:\n${transcript.slice(0, 8000)}`,
        },
        ...history.slice(-6),
        { role: "user", content: question },
      ],
    });
    return resp.choices[0]?.message?.content?.trim() ?? "";
  });
}

export async function getRecommendations(feedTitles: string[], lang = "en"): Promise<string[]> {
  if (!feedTitles.length) return [];
  return withRetry(async () => {
    const groq = getGroq();
    const langLine = lang === "ar" ? "Respond in Arabic." : "Respond in English.";
    const resp = await groq.chat.completions.create({
      model: MODELS.recommend,
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: `${langLine}\nBased on these podcasts the user listens to: ${feedTitles.slice(0, 5).join(", ")}\nSuggest 3 other podcast shows they might enjoy. Reply with ONLY the show names, one per line, no numbering or explanation.`,
        },
      ],
    });
    const text = resp.choices[0]?.message?.content?.trim() ?? "";
    return text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3);
  });
}

export function hasGroqKey(): boolean {
  return Boolean(process.env.GROQ_API_KEY);
}

// Legacy compat aliases
export const hasWhisperKey  = hasGroqKey;
export const hasDeepseekKey = hasGroqKey;
