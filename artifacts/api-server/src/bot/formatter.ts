export function fmt(lines: string[]): string {
  return lines.join("\n");
}

export function divider(): string {
  return "──────────────────────";
}

export function shortDivider(): string {
  return "────────────────";
}

export function progressBar(percent: number, width = 12): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return "▓".repeat(filled) + "▱".repeat(empty);
}

export function truncate(str: string, max: number): string {
  if (!str) return "";
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + "…";
}

export function formatDuration(secs: number): string {
  if (!secs || isNaN(secs)) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

export function parseDuration(dur: string | null | undefined): number {
  if (!dur) return 0;
  const parts = dur.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(dur) || 0;
}

export function formatDate(date: Date | null | undefined): string {
  if (!date) return "—";
  return date.toLocaleDateString("ar-SA", { day: "numeric", month: "short", year: "numeric" });
}

export function episodeCard(opts: {
  index?: number;
  total?: number;
  title: string;
  feedTitle?: string;
  pubDate?: Date | null;
  duration?: string | null;
  listened?: boolean;
  progress?: number;
  isFav?: boolean;
  inQueue?: boolean;
}): string {
  const { index, total, title, feedTitle, pubDate, duration, listened, progress = 0, isFav, inQueue } = opts;
  const headerBadge = listened ? "✅" : inQueue ? "⏭" : "🎙";
  const indexStr = index !== undefined && total !== undefined ? `_حلقة ${index} من ${total}_` : "";
  const dur = parseDuration(duration);
  const durStr = dur > 0 ? formatDuration(dur) : "—";
  const progressStr = listened
    ? "مكتمل"
    : progress > 0
    ? `${progressBar(progress * 100)} ${Math.round(progress * 100)}%`
    : "جديدة";

  return fmt([
    `${headerBadge} *${truncate(title, 55)}*`,
    divider(),
    feedTitle ? `📻 ${truncate(feedTitle, 30)}` : "",
    indexStr,
    `⏱ المدة · ${durStr}`,
    `📅 ${formatDate(pubDate)}`,
    `${isFav ? "❤️ مفضلة · " : ""}${progressStr}`,
  ].filter(Boolean));
}

export function feedCard(opts: {
  index: number;
  title: string;
  url: string;
  episodeCount?: number;
  lastChecked?: Date | null;
}): string {
  const { index, title, episodeCount, lastChecked } = opts;
  return fmt([
    `${index}. 📻 *${truncate(title, 45)}*`,
    `     حلقات: ${episodeCount ?? "—"} · آخر تحديث: ${formatDate(lastChecked)}`,
  ]);
}

export function welcomeMsg(): string {
  return fmt([
    "🎙 *بودكاست بوت*",
    divider(),
    "مرحباً بك في مدير البودكاست الخاص بك!",
    "",
    "📋 *الأوامر الرئيسية:*",
    "/feeds — قائمة البودكاستات",
    "/add — إضافة بودكاست جديد",
    "/latest — آخر الحلقات",
    "/queue — قائمة التشغيل",
    "/favorites — المفضلة",
    "/search — بحث في الحلقات",
    "/stats — إحصائياتي",
    divider(),
    "_أرسل رابط RSS لإضافة بودكاست مباشرة_ 🚀",
  ]);
}
