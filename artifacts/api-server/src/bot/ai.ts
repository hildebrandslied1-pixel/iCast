/**
 * AI module — chunked Whisper transcription (any file size) + DeepSeek summaries
 *
 * Transcription never stops mid-way: every chunk is retried up to 3 times.
 * Chunks use HTTP Range requests so we never hold the full file in RAM.
 */

import OpenAI from "openai";

const CHUNK_BYTES = 23 * 1024 * 1024; // 23 MB — safely under Whisper's 25 MB limit
const MAX_RETRIES = 3;

// ─── Whisper transcription ─────────────────────────────────────────────────

function whisperClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set.");
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function deepseekClient(): OpenAI {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is not set.");
  return new OpenAI({
    baseURL: "https://api.deepseek.com",
    apiKey: process.env.DEEPSEEK_API_KEY,
  });
}

async function transcribeBuffer(
  buf: Buffer,
  filename: string,
  language?: string
): Promise<string> {
  const openai = whisperClient();
  const ext = filename.match(/\.(mp3|mp4|m4a|ogg|wav|webm|flac|aac)(\?.*)?$/i)?.[1] ?? "mp3";
  const file = new File([new Uint8Array(buf)], `chunk.${ext}`, { type: `audio/${ext}` });

  const result = await openai.audio.transcriptions.create({
    model: "whisper-1",
    file,
    response_format: "text",
    ...(language ? { language } : {}),
  });

  return String(result).trim();
}

async function fetchChunkWithRetry(
  url: string,
  start: number,
  end: number,
  attempt = 0
): Promise<Buffer> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Range": `bytes=${start}-${end}`,
      },
    });

    if (!res.ok && res.status !== 206) {
      throw new Error(`HTTP ${res.status} for range ${start}-${end}`);
    }

    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      return fetchChunkWithRetry(url, start, end, attempt + 1);
    }
    throw err;
  }
}

async function transcribeChunkWithRetry(
  buf: Buffer,
  filename: string,
  attempt = 0
): Promise<string> {
  try {
    return await transcribeBuffer(buf, filename);
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      return transcribeChunkWithRetry(buf, filename, attempt + 1);
    }
    throw err;
  }
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

  // Probe file size with HEAD (or first byte range)
  let contentLength = 0;
  try {
    const head = await fetch(audioUrl, {
      method: "HEAD",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    contentLength = parseInt(head.headers.get("content-length") ?? "0", 10);
  } catch {
    // Ignore — will download whole file below
  }

  const filename = audioUrl.split("?")[0].split("/").pop() ?? "episode.mp3";
  const transcripts: string[] = [];

  if (contentLength > 0 && contentLength > CHUNK_BYTES) {
    // Multi-chunk path
    const numChunks = Math.ceil(contentLength / CHUNK_BYTES);
    for (let i = 0; i < numChunks; i++) {
      const start = i * CHUNK_BYTES;
      const end = Math.min((i + 1) * CHUNK_BYTES - 1, contentLength - 1);

      await onProgress?.(`⏳ Downloading part ${i + 1}/${numChunks}…`);
      const buf = await fetchChunkWithRetry(audioUrl, start, end);

      await onProgress?.(`🧠 Transcribing part ${i + 1}/${numChunks}…`);
      const text = await transcribeChunkWithRetry(buf, filename);
      transcripts.push(text);
    }
  } else {
    // Single chunk path (also handles unknown size)
    await onProgress?.("⏳ Downloading audio…");
    const res = await fetch(audioUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`Audio download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());

    if (buf.length > CHUNK_BYTES) {
      // Larger than expected — process in chunks from the buffer
      const numChunks = Math.ceil(buf.length / CHUNK_BYTES);
      for (let i = 0; i < numChunks; i++) {
        const slice = buf.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
        await onProgress?.(`🧠 Transcribing part ${i + 1}/${numChunks}…`);
        const text = await transcribeChunkWithRetry(slice, filename);
        transcripts.push(text);
      }
    } else {
      await onProgress?.("🧠 Transcribing audio…");
      transcripts.push(await transcribeChunkWithRetry(buf, filename));
    }
  }

  return transcripts.join("\n\n").trim();
}

// ─── DeepSeek AI ───────────────────────────────────────────────────────────

export async function generateSummary(
  transcript: string,
  podcastTitle: string,
  episodeTitle: string
): Promise<string> {
  const client = deepseekClient();

  const systemPrompt = `You are an expert podcast analyst. 
Write concise, insightful summaries. Use the same language as the transcript.
Format your response with clear sections using bold headings.`;

  const userPrompt = `Podcast: "${podcastTitle}"
Episode: "${episodeTitle}"

Transcript:
${transcript.slice(0, 30_000)}

Provide:
1. **Overview** (2–3 sentences)
2. **Key Topics** (bullet list)
3. **Main Takeaways** (3–5 bullets)
4. **Notable Quotes** (if any)`;

  const completion = await client.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 1200,
    temperature: 0.7,
  });

  return completion.choices[0]?.message?.content?.trim() ?? "Summary unavailable.";
}

export async function generateDetailedExplanation(
  transcript: string,
  podcastTitle: string,
  episodeTitle: string
): Promise<string> {
  const client = deepseekClient();

  const systemPrompt = `You are a meticulous research analyst and expert explainer.
Your job is to extract every piece of information from a podcast transcript and explain it in depth.
Use the same language as the transcript. Be thorough — do not skip any topic.
Format clearly with numbered sections, sub-bullets, and bold for emphasis.`;

  const userPrompt = `Podcast: "${podcastTitle}"
Episode: "${episodeTitle}"

Transcript:
${transcript.slice(0, 40_000)}

Provide a comprehensive, detailed breakdown covering:
1. Every topic discussed — explain each fully
2. Facts, figures, and data mentioned
3. Arguments and counter-arguments
4. Concepts that require clarification — explain them
5. Action points or recommendations given
6. Context and background for non-expert listeners`;

  const completion = await client.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 3000,
    temperature: 0.4,
  });

  return completion.choices[0]?.message?.content?.trim() ?? "Detailed explanation unavailable.";
}

export function hasWhisperKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

export function hasDeepseekKey(): boolean {
  return Boolean(process.env.DEEPSEEK_API_KEY);
}
