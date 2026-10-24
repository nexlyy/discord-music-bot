import type { Player, SearchResult, Track } from "lavalink-client";
import { createLogger } from "../logger.js";
import { AUTOPLAY_REQUESTER } from "./types.js";

const log = createLogger("autoplay");
const BATCH = 5;

/** Нормализованный ключ, чтобы не повторять один и тот же трек в разных версиях. */
function trackKey(t: Track): string {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/\(.*?\)|\[.*?\]/g, "")
      .replace(/official|video|audio|lyrics?|remaster(ed)?|hd|4k|mv|клип|текст/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  return `${clean(t.info.author ?? "")}|${clean(t.info.title ?? "")}`;
}

async function load(player: Player, query: string): Promise<Track[]> {
  try {
    const res = (await player.search({ query }, AUTOPLAY_REQUESTER)) as SearchResult;
    return res.loadType === "error" || res.loadType === "empty" ? [] : res.tracks;
  } catch (e) {
    log.debug(`Запрос "${query}" не сработал:`, e);
    return [];
  }
}

function youtubeMix(videoId: string) {
  return `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
}

/** Ищем похожие треки: сначала рекомендациями той же площадки, иначе миксом YouTube. */
export async function similarTracks(player: Player, last: Track): Promise<Track[]> {
  const { sourceName, identifier, author, title } = last.info;

  switch (sourceName) {
    case "youtube": {
      const mix = await load(player, youtubeMix(identifier));
      if (mix.length > 1) return mix;
      break;
    }
    case "spotify": {
      const rec = await load(player, `sprec:mix:track:${identifier}`);
      if (rec.length) return rec;
      break;
    }
    case "yandexmusic": {
      const rec = await load(player, `ymrec:${identifier}`);
      if (rec.length) return rec;
      break;
    }
    case "vkmusic": {
      const rec = await load(player, `vkrec:${identifier}`);
      if (rec.length) return rec;
      break;
    }
  }

  // SoundCloud, Apple Music и запасной путь: находим трек на YouTube Music и берём его микс.
  const found = await load(player, `ytmsearch:${author} ${title}`);
  const seed = found[0];
  if (seed?.info.sourceName === "youtube") {
    const mix = await load(player, youtubeMix(seed.info.identifier));
    if (mix.length > 1) return mix;
  }
  return found.slice(1);
}

export function createAutoplay() {
  return async (player: Player, lastTrack: Track) => {
    const seen = new Set<string>([lastTrack, ...player.queue.previous].map(trackKey));
    const seenIds = new Set<string>([lastTrack, ...player.queue.previous].map((t) => t.info.identifier));
    const picked: Track[] = [];

    for (const t of await similarTracks(player, lastTrack)) {
      if (t.info.isStream) continue;
      if ((t.info.duration ?? 0) > 15 * 60_000) continue; // длинные миксы и стримы в автоплей не берём
      const key = trackKey(t);
      if (seen.has(key) || seenIds.has(t.info.identifier)) continue;
      seen.add(key);
      picked.push(t);
      if (picked.length >= BATCH) break;
    }

    if (picked.length === 0) {
      log.info(`Не нашёл похожих треков для "${lastTrack.info.title}"`);
      return;
    }
    await player.queue.add(picked);
    log.info(`Добавил ${picked.length} похожих после "${lastTrack.info.title}"`);
  };
}
