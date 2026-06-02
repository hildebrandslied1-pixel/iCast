import RSSParser from "rss-parser";
import { LRUCache } from "lru-cache";

const parser = new RSSParser({
  timeout: 20000,
  customFields: {
    feed: ["itunes:author", "itunes:image"],
    item: [
      "itunes:duration",
      "itunes:episode",
      "itunes:image",
      "podcast:chapters",
    ],
  },
});

export interface Chapter {
  time: number;
  title: string;
}

export interface ParsedFeed {
  title: string;
  description?: string;
  author?: string;
  imageUrl?: string;
  episodes: ParsedEpisode[];
}

export interface ParsedEpisode {
  guid: string;
  title: string;
  description?: string;
  audioUrl?: string;
  imageUrl?: string;
  pubDate?: Date;
  duration?: string;
  episodeNumber?: number;
  chapters?: Chapter[];
}

const feedCache = new LRUCache<string, ParsedFeed>({
  max: 100,
  ttl: 1000 * 60 * 10, // 10 minutes
});

export async function fetchFeed(url: string, skipCache = false): Promise<ParsedFeed> {
  if (!skipCache) {
    const cached = feedCache.get(url);
    if (cached) return cached;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  let feed: any;
  try {
    feed = await parser.parseURL(url);
  } finally {
    clearTimeout(timeout);
  }

  const author = feed["itunes:author"]?._
    ?? feed["itunes:author"]
    ?? feed.author
    ?? undefined;

  const imageUrl = feed["itunes:image"]?.["$"]?.href
    ?? feed["itunes:image"]?.href
    ?? feed.image?.url
    ?? undefined;

  const episodes: ParsedEpisode[] = (feed.items ?? []).map((item: any) => {
    const epNum = item["itunes:episode"]
      ? parseInt(item["itunes:episode"], 10) || undefined
      : undefined;

    const epImage = item["itunes:image"]?.["$"]?.href
      ?? item["itunes:image"]?.href
      ?? undefined;

    const chapters = parseChapters(item);

    return {
      guid:          item.guid || item.link || item.title || String(Math.random()),
      title:         item.title || "Untitled",
      description:   item.contentSnippet || item.summary || item.content || "",
      audioUrl:      item.enclosure?.url || item.link,
      imageUrl:      epImage,
      pubDate:       item.pubDate ? new Date(item.pubDate) : undefined,
      duration:      item["itunes:duration"] || item.duration || "",
      episodeNumber: isNaN(epNum as number) ? undefined : epNum,
      chapters:      chapters.length ? chapters : undefined,
    };
  });

  const result: ParsedFeed = {
    title:       feed.title || "Podcast",
    description: feed.description || "",
    author,
    imageUrl,
    episodes,
  };

  feedCache.set(url, result);
  return result;
}

function parseChapters(item: any): Chapter[] {
  try {
    const raw = item["podcast:chapters"] ?? item["psc:chapters"] ?? [];
    const arr = Array.isArray(raw) ? raw : [raw];
    return arr
      .map((c: any) => ({
        time:  parseTimeCode(c["$"]?.start ?? c.start ?? "0"),
        title: c["$"]?.title ?? c.title ?? "",
      }))
      .filter((c: Chapter) => c.title);
  } catch {
    return [];
  }
}

function parseTimeCode(tc: string): number {
  if (!tc) return 0;
  const parts = String(tc).split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(tc) || 0;
}

export function isValidFeedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
