import RSSParser from "rss-parser";

const parser = new RSSParser({ timeout: 20000 });

export interface ParsedFeed {
  title: string;
  description?: string;
  episodes: ParsedEpisode[];
}

export interface ParsedEpisode {
  guid: string;
  title: string;
  description?: string;
  audioUrl?: string;
  pubDate?: Date;
  duration?: string;
}

export async function fetchFeed(url: string): Promise<ParsedFeed> {
  const feed = await parser.parseURL(url);

  const episodes: ParsedEpisode[] = (feed.items ?? []).map((item: any) => ({
    guid:        item.guid || item.link || item.title || String(Math.random()),
    title:       item.title || "Untitled",
    description: item.contentSnippet || item.summary || item.content || "",
    audioUrl:    item.enclosure?.url || item.link,
    pubDate:     item.pubDate ? new Date(item.pubDate) : undefined,
    duration:    item.duration || item["itunes:duration"] || "",
  }));

  return {
    title:       feed.title || "Podcast",
    description: feed.description || "",
    episodes,                       // No arbitrary cap — store everything the feed provides
  };
}
