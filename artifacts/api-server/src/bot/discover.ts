/**
 * iTunes Store discovery — top charts + search + RSS resolution.
 * Every country fetch uses a two-tier fallback and 12-second timeout.
 *
 * IMPORTANT: podcastCache is used to keep callback_data under 64 bytes.
 * All discovery results are stored here by iTunes ID. Handlers use only
 * the ID in callback_data and look up the name from this cache.
 */

export interface DiscoveredPodcast {
  id: string;
  name: string;
  artist: string;
  genre?: string;
  feedUrl?: string;
}

// Module-level cache — persists for the process lifetime
export const podcastCache = new Map<string, DiscoveredPodcast>();

export function cachePodcast(p: DiscoveredPodcast): void {
  podcastCache.set(p.id, p);
}

export function getCachedPodcast(id: string): DiscoveredPodcast | undefined {
  return podcastCache.get(id);
}

// ─── Country list ──────────────────────────────────────────────────────────

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
  ["pe", "🇵🇪 Peru"],
  ["jp", "🇯🇵 Japan"],
  ["kr", "🇰🇷 South Korea"],
  ["hk", "🇭🇰 Hong Kong"],
  ["tw", "🇹🇼 Taiwan"],
  ["sg", "🇸🇬 Singapore"],
  ["my", "🇲🇾 Malaysia"],
  ["ph", "🇵🇭 Philippines"],
  ["id", "🇮🇩 Indonesia"],
  ["th", "🇹🇭 Thailand"],
  ["vn", "🇻🇳 Vietnam"],
  ["eg", "🇪🇬 Egypt"],
  ["sa", "🇸🇦 Saudi Arabia"],
  ["ae", "🇦🇪 UAE"],
  ["kw", "🇰🇼 Kuwait"],
  ["qa", "🇶🇦 Qatar"],
  ["bh", "🇧🇭 Bahrain"],
  ["om", "🇴🇲 Oman"],
  ["il", "🇮🇱 Israel"],
  ["ng", "🇳🇬 Nigeria"],
  ["ke", "🇰🇪 Kenya"],
  ["gh", "🇬🇭 Ghana"],
  ["ma", "🇲🇦 Morocco"],
  ["pk", "🇵🇰 Pakistan"],
  ["lk", "🇱🇰 Sri Lanka"],
  ["bd", "🇧🇩 Bangladesh"],
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

// ─── Network helpers ───────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, ms = 12_000): Promise<Response> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url: string, retries = 2): Promise<any> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url);
      if (res.status === 403 || res.status === 404) {
        throw new Error(`HTTP_${res.status}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err: any) {
      if (attempt >= retries || String(err?.message).startsWith("HTTP_")) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

// ─── Top Charts ────────────────────────────────────────────────────────────

export async function fetchTopCharts(country: string, limit = 100): Promise<DiscoveredPodcast[]> {
  const code = country.toLowerCase();
  let json: any;

  try {
    json = await fetchJson(`https://itunes.apple.com/${code}/rss/toppodcasts/limit=${limit}/json`);
  } catch (primaryErr: any) {
    try {
      json = await fetchJson(`https://itunes.apple.com/${code}/rss/topaudiopodcasts/limit=${Math.min(limit, 100)}/json`);
    } catch {
      const label = findCountry(code) ?? code.toUpperCase();
      const msg   = String(primaryErr?.message ?? "");
      if (msg.includes("HTTP_404") || msg.includes("HTTP_403")) {
        throw new Error(`Apple Podcasts charts are not available for ${label}. Try a nearby country.`);
      }
      throw new Error(`Could not load charts for ${label}: ${msg}`);
    }
  }

  const entries: any[] = json?.feed?.entry ?? [];
  if (!entries.length) {
    const label = findCountry(code) ?? code.toUpperCase();
    throw new Error(`No chart data for ${label}. This country may not have an Apple Podcasts presence.`);
  }

  const results = entries.map((e: any): DiscoveredPodcast => ({
    id:     e["id"]?.attributes?.["im:id"] ?? "",
    name:   e["im:name"]?.label ?? "Unknown",
    artist: e["im:artist"]?.label ?? "Unknown",
    genre:  e["category"]?.attributes?.label ?? "",
  }));

  // Cache all results
  results.forEach(cachePodcast);
  return results;
}

// ─── Search ────────────────────────────────────────────────────────────────

export async function searchPodcasts(term: string, country = "us", limit = 20): Promise<DiscoveredPodcast[]> {
  const url  = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=podcast&entity=podcast&country=${country}&limit=${limit}&lang=en_us`;
  const json = await fetchJson(url);

  const results = (json?.results ?? []).map((r: any): DiscoveredPodcast => ({
    id:      String(r.collectionId ?? r.trackId ?? ""),
    name:    r.collectionName ?? r.trackName ?? "Unknown",
    artist:  r.artistName ?? "Unknown",
    genre:   r.primaryGenreName ?? "",
    feedUrl: r.feedUrl ?? undefined,
  }));

  results.forEach(cachePodcast);
  return results;
}

// ─── Resolve RSS feed from iTunes ID ──────────────────────────────────────

export async function resolveRssFeed(itunesId: string): Promise<string | null> {
  try {
    const json = await fetchJson(`https://itunes.apple.com/lookup?id=${itunesId}&entity=podcast`);
    return json?.results?.[0]?.feedUrl ?? null;
  } catch {
    return null;
  }
}
