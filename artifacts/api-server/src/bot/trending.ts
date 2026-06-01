export interface TrendingPodcast {
  id: string;
  name: string;
  artist: string;
  artworkUrl: string;
  itunesUrl: string;
}

export interface TrendingResult {
  country: string;
  period: string;
  podcasts: TrendingPodcast[];
}

export const COUNTRIES: Record<string, string> = {
  us: "🇺🇸 United States",
  gb: "🇬🇧 United Kingdom",
  au: "🇦🇺 Australia",
  ca: "🇨🇦 Canada",
  ie: "🇮🇪 Ireland",
  in: "🇮🇳 India",
  de: "🇩🇪 Germany",
  fr: "🇫🇷 France",
  se: "🇸🇪 Sweden",
  no: "🇳🇴 Norway",
  nz: "🇳🇿 New Zealand",
  za: "🇿🇦 South Africa",
};

export const PERIODS: Record<string, string> = {
  daily:   "📅 Today",
  weekly:  "📆 This Week",
  monthly: "🗓 This Month",
  yearly:  "📊 This Year",
};

export const LIMITS: Record<string, number> = {
  daily:   10,
  weekly:  15,
  monthly: 20,
  yearly:  25,
};

export async function fetchTrending(country: string, period: string): Promise<TrendingResult> {
  const limit = LIMITS[period] ?? 10;
  const url = `https://rss.applemarketingtools.com/api/v2/${country}/podcasts/top/${limit}/podcasts.json`;

  const res = await fetch(url, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`Apple Charts API returned ${res.status}`);
  }

  const json = await res.json() as any;
  const results = json?.feed?.results ?? [];

  const podcasts: TrendingPodcast[] = results.map((r: any) => ({
    id: r.id,
    name: r.name,
    artist: r.artistName || "Unknown",
    artworkUrl: r.artworkUrl100 || "",
    itunesUrl: r.url || "",
  }));

  return {
    country: COUNTRIES[country] ?? country.toUpperCase(),
    period: PERIODS[period] ?? period,
    podcasts,
  };
}

export async function resolveRssFeed(itunesId: string): Promise<string | null> {
  const url = `https://itunes.apple.com/lookup?id=${itunesId}&entity=podcast`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const json = await res.json() as any;
  const result = json?.results?.[0];
  return result?.feedUrl ?? null;
}
