/** Площадки для поиска по тексту. `manager` — имя source manager в Lavalink (/v4/info). */
export const SEARCH_SOURCES = {
  ytm: { label: "YouTube Music", prefix: "ytmsearch", emoji: "🎵", manager: "youtube" },
  yt: { label: "YouTube", prefix: "ytsearch", emoji: "▶️", manager: "youtube" },
  sc: { label: "SoundCloud", prefix: "scsearch", emoji: "☁️", manager: "soundcloud" },
  sp: { label: "Spotify", prefix: "spsearch", emoji: "🟢", manager: "spotify" },
  am: { label: "Apple Music", prefix: "amsearch", emoji: "🍎", manager: "applemusic" },
  ym: { label: "Яндекс Музыка", prefix: "ymsearch", emoji: "🟡", manager: "yandexmusic" },
  vk: { label: "VK Музыка", prefix: "vksearch", emoji: "🔵", manager: "vkmusic" },
} as const;

export type SearchSourceKey = keyof typeof SEARCH_SOURCES;
export const SEARCH_SOURCE_KEYS = Object.keys(SEARCH_SOURCES) as SearchSourceKey[];

export function isSearchSourceKey(value: unknown): value is SearchSourceKey {
  return typeof value === "string" && value in SEARCH_SOURCES;
}

/** Как показывать sourceName трека. */
const SOURCE_NAMES: Record<string, { label: string; emoji: string }> = {
  youtube: { label: "YouTube", emoji: "▶️" },
  youtubemusic: { label: "YouTube Music", emoji: "🎵" },
  soundcloud: { label: "SoundCloud", emoji: "☁️" },
  spotify: { label: "Spotify", emoji: "🟢" },
  applemusic: { label: "Apple Music", emoji: "🍎" },
  yandexmusic: { label: "Яндекс Музыка", emoji: "🟡" },
  vkmusic: { label: "VK Музыка", emoji: "🔵" },
  deezer: { label: "Deezer", emoji: "🟣" },
  bandcamp: { label: "Bandcamp", emoji: "🎸" },
  twitch: { label: "Twitch", emoji: "🟪" },
  vimeo: { label: "Vimeo", emoji: "🎞️" },
  http: { label: "Ссылка", emoji: "🔗" },
};

export function sourceInfo(sourceName: string | undefined) {
  return SOURCE_NAMES[sourceName ?? ""] ?? { label: sourceName ?? "?", emoji: "🎶" };
}

export function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/** Какой площадке принадлежит ссылка — для понятной ошибки, если источник не подключён. */
export function managerForUrl(url: string): string | null {
  const u = url.toLowerCase();
  if (/music\.yandex\.|yandex\.ru\/music/.test(u)) return "yandexmusic";
  if (/(^|\/\/|\.)vk\.(com|ru)\//.test(u)) return "vkmusic";
  if (/open\.spotify\.com|spotify\.link/.test(u)) return "spotify";
  if (/music\.apple\.com/.test(u)) return "applemusic";
  if (/soundcloud\.com|on\.soundcloud/.test(u)) return "soundcloud";
  if (/youtube\.com|youtu\.be/.test(u)) return "youtube";
  return null;
}

export const MANAGER_LABELS: Record<string, string> = {
  youtube: "YouTube",
  soundcloud: "SoundCloud",
  spotify: "Spotify",
  applemusic: "Apple Music",
  yandexmusic: "Яндекс Музыка",
  vkmusic: "VK Музыка",
};
