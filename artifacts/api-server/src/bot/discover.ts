// iTunes Store country codes → display names
// Full list of countries that support Apple Podcasts charts
export const ALL_COUNTRIES: [string, string][] = [
  ["us", "🇺🇸 United States"],
  ["gb", "🇬🇧 United Kingdom"],
  ["au", "🇦🇺 Australia"],
  ["ca", "🇨🇦 Canada"],
  ["ie", "🇮🇪 Ireland"],
  ["nz", "🇳🇿 New Zealand"],
  ["za", "🇿🇦 South Africa"],
  ["in", "🇮🇳 India"],
  ["de", "🇩🇪 Germany"],
  ["fr", "🇫🇷 France"],
  ["es", "🇪🇸 Spain"],
  ["it", "🇮🇹 Italy"],
  ["nl", "🇳🇱 Netherlands"],
  ["se", "🇸🇪 Sweden"],
  ["no", "🇳🇴 Norway"],
  ["dk", "🇩🇰 Denmark"],
  ["fi", "🇫🇮 Finland"],
  ["ch", "🇨🇭 Switzerland"],
  ["at", "🇦🇹 Austria"],
  ["be", "🇧🇪 Belgium"],
  ["pt", "🇵🇹 Portugal"],
  ["pl", "🇵🇱 Poland"],
  ["cz", "🇨🇿 Czech Republic"],
  ["hu", "🇭🇺 Hungary"],
  ["ro", "🇷🇴 Romania"],
  ["tr", "🇹🇷 Turkey"],
  ["ru", "🇷🇺 Russia"],
  ["br", "🇧🇷 Brazil"],
  ["mx", "🇲🇽 Mexico"],
  ["ar", "🇦🇷 Argentina"],
  ["cl", "🇨🇱 Chile"],
  ["co", "🇨🇴 Colombia"],
  ["jp", "🇯🇵 Japan"],
  ["kr", "🇰🇷 South Korea"],
  ["cn", "🇨🇳 China"],
  ["hk", "🇭🇰 Hong Kong"],
  ["tw", "🇹🇼 Taiwan"],
  ["sg", "🇸🇬 Singapore"],
  ["my", "🇲🇾 Malaysia"],
  ["ph", "🇵🇭 Philippines"],
  ["id", "🇮🇩 Indonesia"],
  ["th", "🇹🇭 Thailand"],
  ["vn", "🇻🇳 Vietnam"],
  ["eg", "🇪🇬 Egypt"],
  ["ng", "🇳🇬 Nigeria"],
  ["ke", "🇰🇪 Kenya"],
  ["gh", "🇬🇭 Ghana"],
  ["sa", "🇸🇦 Saudi Arabia"],
  ["ae", "🇦🇪 UAE"],
  ["il", "🇮🇱 Israel"],
  ["pk", "🇵🇰 Pakistan"],
  ["bd", "🇧🇩 Bangladesh"],
  ["lk", "🇱🇰 Sri Lanka"],
  ["gr", "🇬🇷 Greece"],
  ["ua", "🇺🇦 Ukraine"],
  ["hr", "🇭🇷 Croatia"],
  ["sk", "🇸🇰 Slovakia"],
  ["bg", "🇧🇬 Bulgaria"],
  ["rs", "🇷🇸 Serbia"],
  ["lt", "🇱🇹 Lithuania"],
  ["lv", "🇱🇻 Latvia"],
  ["ee", "🇪🇪 Estonia"],
];

export const COUNTRIES_PAGE_SIZE = 20;

export function getCountriesPage(page: number): [string, string][] {
  return ALL_COUNTRIES.slice(page * COUNTRIES_PAGE_SIZE, (page + 1) * COUNTRIES_PAGE_SIZE);
}

export function totalCountryPages(): number {
  return Math.ceil(ALL_COUNTRIES.length / COUNTRIES_PAGE_SIZE);
}

export function findCountry(code: string): string | undefined {
  return ALL_COUNTRIES.find(([c]) => c === code.toLowerCase())?.[1];
}

export interface DiscoveredPodcast {
  id: string;
  name: string;
  artist: string;
  genre?: string;
  feedUrl?: string;
}

// ─── Top Charts (iTunes RSS — working endpoint) ───────────────────────────

export async function fetchTopCharts(country: string, limit = 25): Promise<DiscoveredPodcast[]> {
  const url = `https://itunes.apple.com/${country}/rss/toppodcasts/limit=${limit}/json`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
  });
  if (!res.ok) throw new Error(`iTunes Charts returned ${res.status} for country "${country}"`);

  const json = await res.json() as any;
  const entries: any[] = json?.feed?.entry ?? [];

  return entries.map((e: any) => ({
    id: e["id"]?.attributes?.["im:id"] ?? "",
    name: e["im:name"]?.label ?? "Unknown",
    artist: e["im:artist"]?.label ?? "Unknown",
    genre: e["category"]?.attributes?.label ?? "",
  }));
}

// ─── Search (iTunes Search API — working endpoint) ────────────────────────

export async function searchPodcasts(
  term: string,
  country = "us",
  limit = 20
): Promise<DiscoveredPodcast[]> {
  const q = encodeURIComponent(term);
  const url = `https://itunes.apple.com/search?term=${q}&media=podcast&entity=podcast&country=${country}&limit=${limit}&lang=en_us`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
  });
  if (!res.ok) throw new Error(`iTunes Search returned ${res.status}`);

  const json = await res.json() as any;
  const results: any[] = json?.results ?? [];

  return results.map((r: any) => ({
    id: String(r.collectionId ?? r.trackId ?? ""),
    name: r.collectionName ?? r.trackName ?? "Unknown",
    artist: r.artistName ?? "Unknown",
    genre: r.primaryGenreName ?? "",
    feedUrl: r.feedUrl ?? undefined,
  }));
}

// ─── Resolve RSS feed from iTunes ID ─────────────────────────────────────

export async function resolveRssFeed(itunesId: string): Promise<string | null> {
  const url = `https://itunes.apple.com/lookup?id=${itunesId}&entity=podcast`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) return null;
  const json = await res.json() as any;
  return json?.results?.[0]?.feedUrl ?? null;
}
