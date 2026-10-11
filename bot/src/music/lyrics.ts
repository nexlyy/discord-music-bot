import type { Player, Track } from "lavalink-client";
import { createLogger } from "../logger.js";

const log = createLogger("lyrics");

export interface Lyrics {
  source: string;
  synced: boolean;
  lines: { time: number; text: string }[];
  text: string;
}

const cache = new Map<string, Lyrics | null>();
const CACHE_LIMIT = 200;

function remember(key: string, value: Lyrics | null) {
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

/** "Artist - Title (Official Video) [4K]" → { artist, title } */
export function cleanTrackName(track: Track): { artist: string; title: string } {
  let title = track.info.title ?? "";
  let artist = (track.info.author ?? "").replace(/\s*-\s*Topic$/i, "").replace(/VEVO$/i, "");
  const dash = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash && track.info.sourceName === "youtube") {
    artist = dash[1]!;
    title = dash[2]!;
  }
  title = title
    .replace(/\((?:[^)]*?(official|video|audio|lyric|remaster|clip|клип|live|hd|4k|mv|visuali[sz]er)[^)]*)\)/gi, "")
    .replace(/\[(?:[^\]]*)\]/g, "")
    .replace(/\s+(ft\.?|feat\.?)\s.+$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { artist: artist.trim(), title };
}

function parseLrc(lrc: string): { time: number; text: string }[] {
  const lines: { time: number; text: string }[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (stamps.length === 0) continue;
    const text = raw.replace(/\[[^\]]*\]/g, "").trim();
    for (const s of stamps) {
      const frac = s[3] ? Number(s[3].padEnd(3, "0")) : 0;
      lines.push({ time: Number(s[1]) * 60_000 + Number(s[2]) * 1000 + frac, text });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

interface LrcLibItem {
  trackName: string;
  artistName: string;
  duration: number;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

async function lrclib(track: Track): Promise<Lyrics | null> {
  const { artist, title } = cleanTrackName(track);
  const durationSec = Math.round((track.info.duration ?? 0) / 1000);
  const headers = { "User-Agent": "discord-music-bot/1.0 (self-hosted)" };
  const pick = (items: LrcLibItem[]) =>
    items
      .filter((i) => !i.instrumental && (i.syncedLyrics || i.plainLyrics))
      .sort((a, b) => Number(Boolean(b.syncedLyrics)) - Number(Boolean(a.syncedLyrics)) || Math.abs(a.duration - durationSec) - Math.abs(b.duration - durationSec))
      .find((i) => !durationSec || Math.abs(i.duration - durationSec) <= 8);

  try {
    const q = new URLSearchParams({ track_name: title, artist_name: artist });
    let res = await fetch(`https://lrclib.net/api/search?${q}`, { headers, signal: AbortSignal.timeout(8000) });
    let item = res.ok ? pick((await res.json()) as LrcLibItem[]) : undefined;
    if (!item) {
      res = await fetch(`https://lrclib.net/api/search?${new URLSearchParams({ q: `${artist} ${title}` })}`, {
        headers,
        signal: AbortSignal.timeout(8000),
      });
      item = res.ok ? pick((await res.json()) as LrcLibItem[]) : undefined;
    }
    if (!item) return null;
    const lines = item.syncedLyrics ? parseLrc(item.syncedLyrics) : [];
    return {
      source: "LRCLIB",
      synced: lines.length > 0,
      lines,
      text: item.plainLyrics ?? lines.map((l) => l.text).join("\n"),
    };
  } catch (e) {
    log.debug("LRCLIB:", e);
    return null;
  }
}

/** Текст песни: сначала через LavaLyrics (LRCLIB, YouTube Music, Яндекс, VK), затем напрямую из LRCLIB. */
export async function getLyrics(player: Player, track: Track): Promise<Lyrics | null> {
  const key = `${track.info.sourceName}:${track.info.identifier}`;
  if (cache.has(key)) return cache.get(key)!;

  let result: Lyrics | null = null;
  try {
    const isCurrent = player.queue.current?.info.identifier === track.info.identifier;
    const res = isCurrent ? await player.getCurrentLyrics(false) : await player.getLyrics(track, false);
    if (res && (res.lines?.length || res.text)) {
      const lines = (res.lines ?? [])
        .filter((l) => typeof l.timestamp === "number")
        .map((l) => ({ time: l.timestamp, text: l.line ?? "" }));
      result = {
        source: res.provider || res.sourceName || "Lavalink",
        synced: lines.length > 0,
        lines,
        text: res.text ?? lines.map((l) => l.text).join("\n"),
      };
    }
  } catch (e) {
    log.debug("LavaLyrics:", e);
  }

  // YouTube-источник часто отдаёт текст без таймингов — пробуем найти синхронный в LRCLIB.
  if (!result || !result.synced) {
    const alt = await lrclib(track);
    if (alt && (alt.synced || !result)) result = alt;
  }

  remember(key, result);
  return result;
}

/** Индекс текущей строки для позиции воспроизведения. */
export function currentLineIndex(lyrics: Lyrics, positionMs: number): number {
  let idx = -1;
  for (let i = 0; i < lyrics.lines.length; i++) {
    if (lyrics.lines[i]!.time <= positionMs + 300) idx = i;
    else break;
  }
  return idx;
}
