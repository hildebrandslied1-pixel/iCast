---
name: Chunked Whisper transcription
description: How full-episode transcription works for any file size
---

- Whisper API limit: 25 MB per request. Chunk size set to 23 MB (safety margin).
- Strategy: HTTP Range requests (`bytes=start-end`) — never loads full file into RAM
- If HEAD fails (no Content-Length): download full file, then split Buffer in memory
- Each chunk retried up to 3 times with exponential backoff before throwing
- All chunk transcripts joined with `\n\n` and saved to `episodes.transcript` column
- `transcriptAt` timestamp also saved so UI can show "Transcript Ready" badge

**Why:** Podcast episodes can be 100MB+. Single download would exhaust memory and exceed API limits.

**How to apply:** `transcribeEpisodeFull(audioUrl, { onProgress })` in `ai.ts`. Progress callback receives human-readable strings like "Transcribing part 2/4…".
