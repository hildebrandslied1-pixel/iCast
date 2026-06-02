/**
 * AI module — Groq Whisper transcription + Llama summaries & chat
 * Whisper limit is 25MB per request; chunks are kept at 20MB.
 * Exponential backoff with 5 retries on 429 rate limit errors.
 * Transcription queue: max 1 concurrent transcription.
 */

import Groq, { toFile } from "groq-sdk";
import fs from "fs";
import path from "path";
import os from "os";

const CHUNK_BYTES = 20 * 1024 * 1024; // 20 MB — safely under Whisper's 25 MB limit

const MODELS = {
  transcribe: "whisper-large-v3",
  summarize:  "llama-3.3-70b-versatile",
  chat:       "llama-3.1-8b-instant",
  recommend:  "llama-3.1-8b-instant",
  deep:       "llama-3.3-70b-versatile",
  questions:  "llama-3.3-70b-versatile",
} as const;

function getGroq(): Groq {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");
  return new Groq({ apiKey });
}

// ─── Transcription Queue ──────────────────────────────────────────────────────

let transcriptionRunning = false;
const transcriptionQueue: Array<{
  resolve: (v: string) => void;
  reject:  (e: unknown) => void;
  fn:      () => Promise<string>;
  position: number;
  onProgress?: (msg: string) => Promise<void>;
}> = [];
let nextPosition = 0;

async function processQueue(): Promise<void> {
  if (transcriptionRunning || !transcriptionQueue.length) return;
  transcriptionRunning = true;

  const item = transcriptionQueue.shift()!;
  try {
    const result = await item.fn();
    item.resolve(result);
  } catch (e) {
    item.reject(e);
  } finally {
    transcriptionRunning = false;
    void processQueue();
  }
}

// ─── Retry with 429 handling ──────────────────────────────────────────────────

async function withRetry<T>(fn: () => Promise<T>, retries = 5): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      const is429 = err?.status === 429 || err?.message?.includes("429") || err?.message?.includes("rate limit");
      const delay = is429
        ? Math.pow(2, i) * 2000        // exponential: 2s, 4s, 8s, 16s, 32s
        : 1500 * (i + 1);              // linear: 1.5s, 3s, 4.5s…
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

// ─── Transcribe buffer ────────────────────────────────────────────────────────

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

// ─── Public transcription API (with queue) ────────────────────────────────────

export interface TranscribeOptions {
  onProgress?: (msg: string) => Promise<void>;
  language?: string;
}

export async function transcribeEpisodeFull(
  audioUrl: string,
  opts: TranscribeOptions = {}
): Promise<string> {
  const pos = nextPosition++;
  const queueLen = transcriptionQueue.length;

  if (transcriptionRunning || queueLen > 0) {
    await opts.onProgress?.(`⏳ Transcription في الطابور... الموقع: ${queueLen + 1}`);
  }

  return new Promise<string>((resolve, reject) => {
    transcriptionQueue.push({
      resolve,
      reject,
      position: pos,
      onProgress: opts.onProgress,
      fn: () => _transcribeEpisodeFull(audioUrl, opts),
    });
    void processQueue();
  });
}

async function _transcribeEpisodeFull(
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
    if (attempt < 4) {
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      return fetchRangeWithRetry(url, start, end, attempt + 1);
    }
    throw err;
  }
}

// ─── Summarize ────────────────────────────────────────────────────────────────

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

// ─── Harvard Professor Deep Explanation ───────────────────────────────────────

export async function generateDeepExplanation(
  transcript: string,
  podcastTitle: string,
  episodeTitle: string
): Promise<string> {
  return withRetry(async () => {
    const groq = getGroq();
    const resp = await groq.chat.completions.create({
      model: MODELS.deep,
      max_tokens: 2000,
      messages: [
        {
          role: "system",
          content: `You are a Harvard Professor of the highest caliber.
Your teaching method is Socratic and scaffolded.
You assume the student has ZERO prior knowledge.
You build concepts from absolute zero to expert level.

For EVERY major piece of information in the transcript:
1. Extract it as a distinct "Knowledge Unit"
2. Verify its factual accuracy (mark as ✅ Verified or ⚠️ Unverified)
3. Explain it simply, then technically, then at expert level
4. Provide real-world examples and historical context
5. Connect it to other fields

Format each unit as:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📚 KNOWLEDGE UNIT #N
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔊 Original: "exact quote"

✅ Status: [Verified / Unverified / Needs Source]

🧒 Beginner: {simple analogy}
🎓 Intermediate: {technical explanation}
🏛️ Expert: {academic analysis}

🔗 Connections: {related concepts}
📖 Further Reading: {resources}

End with:
╔══════════════════════════════════╗
║  📊 KNOWLEDGE ANALYSIS           ║
╠══════════════════════════════════╣
║  Total Units: N                  ║
║  ✅ Verified: N                  ║
║  ⚠️ Unverified: N                ║
║  🔗 Links: N                     ║
╚══════════════════════════════════╝`,
        },
        {
          role: "user",
          content: `Podcast: "${podcastTitle}"\nEpisode: "${episodeTitle}"\n\nTranscript:\n${transcript.slice(0, 20000)}\n\nAnalyze EVERY claim, fact, and concept. Transform the listener into someone smarter than Harvard's best students. Use the same language as the transcript.`,
        },
      ],
    });
    return resp.choices[0]?.message?.content?.trim() ?? "Deep explanation unavailable.";
  });
}

// ─── 100 Critical Thinking Questions ─────────────────────────────────────────

export async function generateCriticalQuestions(
  transcript: string,
  podcastTitle: string,
  episodeTitle: string,
  seed?: number
): Promise<string> {
  return withRetry(async () => {
    const groq = getGroq();
    const seedLine = seed ? `Seed for randomness: ${seed}. Generate completely different questions than before.` : "";
    const resp = await groq.chat.completions.create({
      model: MODELS.questions,
      max_tokens: 3000,
      temperature: 0.9,
      messages: [
        {
          role: "system",
          content: `You are a Critical Thinking examiner from Harvard Business School.
Generate exactly 20 thought-provoking questions based on the transcript (we send in batches).
${seedLine}

Categories (distribute evenly):
1. 🧠 Logical Reasoning
2. 🔍 Evidence Evaluation
3. 🎯 Assumption Testing
4. ⚖️ Ethical Dilemmas
5. 🔮 Future Implications

Each question must:
- Reference a specific idea from the transcript
- Challenge the listener to think deeper
- Have no obvious "right" answer

Format:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❓ QUESTION #N · Category: {icon} {name}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📍 Context: "{relevant idea}"

{The question itself}

💭 Think about: {why this matters}`,
        },
        {
          role: "user",
          content: `Podcast: "${podcastTitle}"\nEpisode: "${episodeTitle}"\n\nTranscript:\n${transcript.slice(0, 20000)}\n\nGenerate 20 critical thinking questions. Use the same language as the transcript.`,
        },
      ],
    });
    return resp.choices[0]?.message?.content?.trim() ?? "Questions unavailable.";
  });
}

// ─── Chat with episode ────────────────────────────────────────────────────────

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

// ─── Recommendations ──────────────────────────────────────────────────────────

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
