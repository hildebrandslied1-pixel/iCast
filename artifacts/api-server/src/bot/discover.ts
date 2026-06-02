/**
 * iTunes Store discovery — top charts + search + RSS resolution.
 * Every country fetch uses a two-tier fallback and 12-second timeout.
 */

// Full list of countries with confirmed Apple Podcasts presence
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
  ["mx", "🇲🇽 Mexico"],
  ["pe", "🇵🇪 Peru"],
  ["ve", "🇻🇪 Venezuela"],
];

export const COUNTRIES_PAGE_SIZE = 20;

export function getCountriesPage(page: number): [string, string][] {
  // Deduplicate (mx appears twice in the source above)
  const seen = new Set<string>();
  const unique = ALL_COUNTRIES.filter(([code]) => {
    if (seen.has(code)) return false;
    seen.add(code);
    return true;
  });
  return unique.slice(page * COUNTRIES_PAGE_SIZE, (page + 1) * COUNTRIES_PAGE_SIZE);
}

export function totalCountryPages(): number {
  const unique = new Set(ALL_COUNTRIES.map(([c]) => c));
  return Math.ceil(unique.size / COUNTRIES_PAGE_SIZE);
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

// ─── Helpers ───────────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, timeoutMs = 12_000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url: string, retries = 2): Promise<any> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) {
        if (res.status === 403 || res.status === 404) {
          throw new Error(`HTTP_${res.status}`);  // no point retrying
        }
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.json();
    } catch (err: any) {
      const noRetry = err?.message?.startsWith("HTTP_");
      if (attempt >= retries || noRetry) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

// ─── Top Charts ────────────────────────────────────────────────────────────

export async function fetchTopCharts(country: string, limit = 100): Promise<DiscoveredPodcast[]> {
  const code = country.toLowerCase();

  // Primary endpoint
  const primaryUrl = `https://itunes.apple.com/${code}/rss/toppodcasts/limit=${limit}/json`;
  // Fallback endpoint (explicit content)
  const fallbackUrl = `https://itunes.apple.com/${code}/rss/topaudiopodcasts/limit=${Math.min(limit, 100)}/json`;

  let json: any;
  try {
    json = await fetchWithRetry(primaryUrl);
  } catch (primaryErr: any) {
    // Try fallback before giving up
    try {
      json = await fetchWithRetry(fallbackUrl);
    } catch {
      throw new Error(
        primaryErr?.message?.includes("HTTP_404") || primaryErr?.message?.includes("HTTP_403")
          ? `Apple Podcasts charts are not available for "${findCountry(code) ?? code.toUpperCase()}". Try a neighbouring country.`
          : `Failed to load charts: ${primaryErr?.message ?? primaryErr}`
      );
    }
  }

  const entries: any[] = json?.feed?.entry ?? [];
  if (!entries.length) {
    throw new Error(`No chart data returned for "${findCountry(code) ?? code.toUpperCase()}". This country may not have an Apple Podcasts presence.`);
  }

  return entries.map((e: any) => ({
    id:     e["id"]?.attributes?.["im:id"] ?? "",
    name:   e["im:name"]?.label ?? "Unknown",
    artist: e["im:artist"]?.label ?? "Unknown",
    genre:  e["category"]?.attributes?.label ?? "",
  }));
}

// ─── Search ────────────────────────────────────────────────────────────────

export async function searchPodcasts(
  term: string,
  country = "us",
  limit = 20
): Promise<DiscoveredPodcast[]> {
  const q   = encodeURIComponent(term);
  const url = `https://itunes.apple.com/search?term=${q}&media=podcast&entity=podcast&country=${country}&limit=${limit}&lang=en_us`;

  const json = await fetchWithRetry(url);
  const results: any[] = json?.results ?? [];

  return results.map((r: any) => ({
    id:      String(r.collectionId ?? r.trackId ?? ""),
    name:    r.collectionName ?? r.trackName ?? "Unknown",
    artist:  r.artistName ?? "Unknown",
    genre:   r.primaryGenreName ?? "",
    feedUrl: r.feedUrl ?? undefined,
  }));
}

// ─── Resolve RSS feed from iTunes ID ──────────────────────────────────────

export async function resolveRssFeed(itunesId: string): Promise<string | null> {
  const url = `https://itunes.apple.com/lookup?id=${itunesId}&entity=podcast`;
  try {
    const json = await fetchWithRetry(url);
    return json?.results?.[0]?.feedUrl ?? null;
  } catch {
    return null;
  }
}
