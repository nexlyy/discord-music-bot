import type { Player, SearchResult, Track } from "lavalink-client";
import { looseKey, splitArtists, type HistoryStore } from "../library/history.js";
import { createLogger } from "../logger.js";
import { VARIANT, baseTitle, matchScore } from "./fallback.js";
import { artistKey, trackArtists, type AutoplayTaste } from "./taste.js";
import { AUTOPLAY_REQUESTER, requesterOf } from "./types.js";

const log = createLogger("autoplay");
const BATCH = 5;
const MIN_MS = 60_000;
const MAX_MS = 10 * 60_000;
/** Один исполнитель — не больше двух раз за последние десять треков (и раз за одну подборку). */
const ARTIST_WINDOW = 10;
const ARTIST_MAX_IN_WINDOW = 2;
/** Не повторяем то, что на сервере звучало за последние часы. */
const REPEAT_HOURS = 12;
/** Из YouTube-микса берём только начало: дальше он уходит от исходного трека. */
const YT_MIX_HEAD = 15;

type Info = Track["info"];

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

/** null — запрос не выполнился (сеть, ошибка площадки); [] — выполнился, но пусто. */
async function tryLoad(player: Player, query: string): Promise<Track[] | null> {
  try {
    const res = (await player.search({ query }, AUTOPLAY_REQUESTER)) as SearchResult;
    if (res.loadType === "error") return null;
    return res.loadType === "empty" ? [] : res.tracks;
  } catch (e) {
    log.debug(`Запрос "${query}" не сработал:`, e);
    return null;
  }
}

async function load(player: Player, query: string): Promise<Track[]> {
  return (await tryLoad(player, query)) ?? [];
}

function youtubeMix(videoId: string) {
  return `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
}

/** Похожие треки рекомендациями той же площадки, иначе миксом YouTube (для «Угадай трек»). */
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

/* --------------------------------- семена --------------------------------- */

const isHuman = (t: Track) => {
  const id = requesterOf(t)?.id;
  return !!id && (/^\d+$/.test(id) || id === "panel");
};

function pickWeighted<T>(items: T[], weight: (index: number) => number): T {
  const weights = items.map((_, i) => weight(i));
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < items.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return items[i]!;
  }
  return items[items.length - 1]!;
}

function shuffled<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Что в этой сессии включали люди, от свежего к старому. Треки самого автоплея семенами не бывают. */
function sessionSeeds(played: Track[]): Info[] {
  const out: Info[] = [];
  const seen = new Set<string>();
  for (const t of played) {
    if (!isHuman(t) || t.info.isStream) continue;
    const key = looseKey(t.info.author, t.info.title);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t.info);
    if (out.length >= 8) break;
  }
  return out;
}

/** Людских треков в сессии нет (24/7, после перезапуска): берём то, что крутят сидящие в войсе, или топ сервера. */
function historySeeds(history: HistoryStore, listeners: string[]): Info[] {
  let pool = listeners.flatMap((id) => history.onRepeat(id, 10).map((e) => e.track));
  if (pool.length < 3) pool = [...pool, ...listeners.flatMap((id) => history.radio(id, 5))];
  if (pool.length === 0) pool = history.radio(undefined, 8);
  const seen = new Set<string>();
  return shuffled(pool)
    .filter((t) => {
      const key = looseKey(t.info.author, t.info.title);
      if (seen.has(key) || t.info.isStream) return false;
      seen.add(key);
      return true;
    })
    .map((t) => t.info as Info);
}

/** Два семени: свежий заказ (чем свежее, тем вероятнее) и ещё один — из сессии или из истории слушателей. */
function chooseSeeds(session: Info[], fromHistory: () => Info[]): Info[] {
  const seeds: Info[] = [];
  if (session.length) {
    const first = pickWeighted(session, (i) => 1 / (i + 1) ** 1.5);
    seeds.push(first);
    const rest = session.filter((s) => s !== first);
    if (rest.length) seeds.push(pickWeighted(rest, (i) => 1 / (i + 1)));
  }
  if (seeds.length < 2) {
    const keys = new Set(seeds.map((s) => looseKey(s.author, s.title)));
    seeds.push(...fromHistory().filter((s) => !keys.has(looseKey(s.author, s.title))).slice(0, 2 - seeds.length));
  }
  return seeds;
}

/* ------------------------------- рекомендации ------------------------------ */

/** Исполнитель и название без мусора: у заливок YouTube/SoundCloud они часто в названии через дефис. */
function describe(info: Info): { artist: string; title: string; duration: number } {
  // У клипов на YouTube длительность не совпадает с альбомной (вступления, концовки) — её не сравниваем.
  const duration = info.sourceName === "youtube" ? 0 : info.duration;
  if (info.sourceName !== "spotify" && info.sourceName !== "applemusic") {
    const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(info.title);
    if (m) return { artist: m[1]!, title: m[2]!, duration };
  }
  return { artist: splitArtists(info.author)[0] ?? info.author, title: info.title, duration };
}

/** Тот же трек в Spotify (по ISRC или по названию), чтобы взять его радио. Ответ запоминается. */
async function spotifyIdOf(player: Player, info: Info, taste: AutoplayTaste): Promise<string | null> {
  if (info.sourceName === "spotify") return info.identifier;
  const key = looseKey(info.author, info.title);
  const known = taste.spotifyId(key);
  if (known !== undefined) return known;

  if (info.isrc) {
    const byIsrc = await tryLoad(player, `spsearch:isrc:${info.isrc}`);
    const hit = byIsrc?.find((t) => t.info.isrc === info.isrc) ?? byIsrc?.[0];
    if (hit) {
      taste.setSpotifyId(key, hit.info.identifier);
      return hit.info.identifier;
    }
  }
  const d = describe(info);
  const found = await tryLoad(player, `spsearch:${d.artist} ${baseTitle(d.title)}`);
  if (found === null) return null; // площадка не ответила — не запоминаем, попробуем в другой раз
  let best: Track | null = null;
  let bestScore = 0;
  for (const t of found.slice(0, 8)) {
    const s = matchScore({ author: d.artist, title: d.title, duration: d.duration }, t.info);
    if (s !== null && s > bestScore) {
      best = t;
      bestScore = s;
    }
  }
  taste.setSpotifyId(key, best?.info.identifier ?? null);
  return best?.info.identifier ?? null;
}

interface Recs {
  seed: Info;
  tracks: Track[];
  via: "spotify" | "yandex" | "vk" | "youtube" | "none";
}

/**
 * Похожие на один трек. Главный источник — радио Spotify: оно держится жанра. YouTube-микс за несколько
 * шагов уезжает в общий русский рэп, поэтому он только запасной и от него берётся лишь начало.
 */
async function recommend(player: Player, seed: Info, taste: AutoplayTaste): Promise<Recs> {
  const spId = await spotifyIdOf(player, seed, taste);
  if (spId) {
    const mix = (await load(player, `sprec:mix:track:${spId}`)).filter((t) => t.info.identifier !== spId);
    if (mix.length >= 5) return { seed, tracks: mix, via: "spotify" };
  }
  if (seed.sourceName === "yandexmusic") {
    const rec = await load(player, `ymrec:${seed.identifier}`);
    if (rec.length) return { seed, tracks: rec, via: "yandex" };
  }
  if (seed.sourceName === "vkmusic") {
    const rec = await load(player, `vkrec:${seed.identifier}`);
    if (rec.length) return { seed, tracks: rec, via: "vk" };
  }
  let ytId = seed.sourceName === "youtube" ? seed.identifier : null;
  if (!ytId) {
    const d = describe(seed);
    const found = await load(player, `ytmsearch:${d.artist} ${d.title}`);
    if (found[0]?.info.sourceName === "youtube") ytId = found[0].info.identifier;
  }
  if (ytId) {
    const mix = await load(player, youtubeMix(ytId));
    if (mix.length > 1) return { seed, tracks: mix.slice(1, YT_MIX_HEAD + 1), via: "youtube" };
  }
  return { seed, tracks: [], via: "none" };
}

/** Похожие на сохранённый трек — для «Микса войса». */
export async function recommendFor(player: Player, seed: Info, taste: AutoplayTaste): Promise<Track[]> {
  return (await recommend(player, seed, taste)).tracks;
}

/* --------------------------------- подбор --------------------------------- */

const uniqArtists = (info: Info) => [...new Set(trackArtists(info).map(artistKey).filter(Boolean))];

export interface AutoplayDeps {
  history: HistoryStore;
  taste: AutoplayTaste;
  /** Кто сейчас в войсе с ботом */
  listeners: () => string[];
}

export function createAutoplay(deps: AutoplayDeps) {
  const { history, taste } = deps;

  return async (player: Player, lastTrack: Track) => {
    const started = Date.now();
    const played = [lastTrack, ...player.queue.previous];
    const queued = player.queue.tracks as Track[];

    let seeds = chooseSeeds(sessionSeeds(played), () => historySeeds(history, deps.listeners()));
    if (seeds.length === 0) seeds = [lastTrack.info]; // пустой сервер без истории: хотя бы от последнего трека
    const results = await Promise.all(seeds.map((s) => recommend(player, s, taste)));

    const seenIds = new Set(played.map((t) => t.info.identifier));
    const seenKeys = history.recentKeys(REPEAT_HOURS);
    for (const t of [...played, ...queued]) seenKeys.add(looseKey(t.info.author, t.info.title));
    const seenTrackKeys = new Set([...played, ...queued].map(trackKey));

    const recentArtists = new Map<string, number>();
    for (const t of [...played.slice(0, ARTIST_WINDOW), ...queued]) {
      for (const a of uniqArtists(t.info)) recentArtists.set(a, (recentArtists.get(a) ?? 0) + 1);
    }
    const known = new Map<string, number>();
    for (const [name, n] of history.humanArtists(90)) known.set(artistKey(name), (known.get(artistKey(name)) ?? 0) + n);
    const seedVariant = seeds.some((s) => VARIANT.test(s.title));

    const fits = (t: Track) => {
      const i = t.info;
      if (i.isStream || i.duration < MIN_MS || i.duration > MAX_MS) return false;
      if (!seedVariant && VARIANT.test(i.title)) return false; // slowed, sped up, nightcore — только если сами такое включали
      if (seenIds.has(i.identifier) || seenKeys.has(looseKey(i.author, i.title)) || seenTrackKeys.has(trackKey(t))) return false;
      return taste.blocked(i) === null;
    };

    // Порядок внутри каждого списка: как предложила площадка, но артисты, которых здесь слушают, — выше,
    // а артисты, которых уже раз скипали, — ниже. Немного случайности, чтобы подборки не повторялись.
    const ranked = results.map((r) =>
      r.tracks
        .filter(fits)
        .map((t, idx, arr) => {
          const artists = uniqArtists(t.info);
          const plays = Math.max(0, ...artists.map((a) => known.get(a) ?? 0));
          const skips = Math.max(0, ...artists.map((a) => taste.skipCount(a)));
          const score = 1 - idx / arr.length + (plays >= 3 ? 0.35 : plays > 0 ? 0.15 : 0) - skips * 0.4 + Math.random() * 0.2;
          return { t, artists, score };
        })
        .sort((a, b) => b.score - a.score),
    );

    const pickFrom = (strict: boolean) => {
      const picked: Track[] = [];
      const batchArtists = new Set<string>();
      const used = new Set<Track>();
      // Первое семя (свежий заказ) даёт 3 трека, второе — 2: чередуем 0,1,0,1,0, потом добираем откуда есть.
      const order = [0, 1, 0, 1, 0];
      const take = (list: (typeof ranked)[number] | undefined) => {
        for (const c of list ?? []) {
          if (used.has(c.t)) continue;
          if (c.artists.some((a) => batchArtists.has(a))) continue;
          if (strict && c.artists.some((a) => (recentArtists.get(a) ?? 0) >= ARTIST_MAX_IN_WINDOW)) continue;
          used.add(c.t);
          for (const a of c.artists) batchArtists.add(a);
          picked.push(c.t);
          return true;
        }
        return false;
      };
      for (const idx of order) {
        if (picked.length >= BATCH) break;
        if (!take(ranked[idx])) take(ranked[idx === 0 ? 1 : 0]);
      }
      while (picked.length < BATCH && ranked.some((l) => take(l)));
      return picked;
    };
    let picked = pickFrom(true);
    if (picked.length === 0) picked = pickFrom(false);

    const seedText = results.map((r) => `«${r.seed.author} — ${r.seed.title}» (${r.via})`).join(", ");
    if (picked.length === 0) {
      log.info(`Не нашёл подходящих треков от ${seedText}`);
      return;
    }
    await player.queue.add(picked);
    log.info(
      `Добавил ${picked.length} от ${seedText} за ${Date.now() - started} мс: ${picked.map((t) => `${t.info.author} — ${t.info.title}`).join("; ")}`,
    );
  };
}
