import type { Player, SearchResult, Track } from "lavalink-client";
import { CHARTS } from "../library/charts.js";
import { splitArtists, type HistoryStore } from "../library/history.js";
import { fromStored, type StoredTrack } from "../library/stored-track.js";
import { createLogger } from "../logger.js";
import { similarTracks } from "../music/autoplay.js";
import { cleanTrackName } from "../music/lyrics.js";

const log = createLogger("quiz-pool");
export const QUIZ_REQUESTER = { id: "quiz", username: "Угадай трек", avatar: null };

export interface QuizItem {
  track: Track;
  artist: string;
  title: string;
  /** Нормализованные исполнитель и название — чтобы варианты не повторялись */
  artistKey: string;
  titleKey: string;
}

export const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

function displayTitle(title: string): string {
  return title
    .replace(/\s*[([](?:[^)\]]*?\b(?:feat|ft|prod|with)\b[^)\]]*)[)\]]/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function toItem(track: Track): QuizItem | null {
  const info = track.info;
  if (!info || info.isStream) return null;
  if ((info.duration ?? 0) < 40_000 || (info.duration ?? 0) > 12 * 60_000) return null;
  const clean = cleanTrackName(track);
  const artist = splitArtists(clean.artist)[0] ?? clean.artist;
  const title = displayTitle(clean.title);
  if (!artist || !title || norm(artist).length === 0 || norm(title).length === 0) return null;
  return { track, artist, title, artistKey: norm(artist), titleKey: norm(title) };
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

async function load(player: Player, query: string): Promise<Track[]> {
  try {
    const res = (await player.search({ query }, QUIZ_REQUESTER)) as SearchResult;
    return res.loadType === "error" || res.loadType === "empty" ? [] : res.tracks;
  } catch (e) {
    log.debug(`Запрос "${query}" не сработал:`, e);
    return [];
  }
}

/**
 * «Умный микс», как Smart Shuffle в Spotify: половина — из истории сервера с упором на тех, кто сейчас
 * в канале, половина — похожие на них треки. Если истории мало, добиваем чартами.
 */
export async function buildPool(player: Player, history: HistoryStore, participants: string[], rounds: number) {
  const fromHistory = (s: StoredTrack[]) => s.map((t) => fromStored(t, player.LavalinkManager, QUIZ_REQUESTER));

  // 1. По интересам: каждый участник даёт свою долю из личной истории, плюс общая история сервера.
  const perUser = Math.max(2, Math.ceil(rounds / Math.max(1, participants.length)));
  const historyTracks = [
    ...participants.flatMap((id) => fromHistory(history.radio(id, perUser))),
    ...fromHistory(history.radio(undefined, rounds)),
  ];

  // 2. Похожие треки по нескольким «семенам» из истории (или из чартов, если истории нет).
  let seeds = shuffle([...historyTracks]).slice(0, 6);
  const charts: Track[] = [];
  if (historyTracks.length < rounds) {
    const loaded = await Promise.all([load(player, CHARTS[0].url), load(player, CHARTS[2].url)]);
    charts.push(...loaded.flat());
    if (seeds.length < 3) seeds = [...seeds, ...shuffle([...charts]).slice(0, 6 - seeds.length)];
  }
  const similar = (await Promise.allSettled(seeds.map((s) => similarTracks(player, s))))
    .flatMap((r) => (r.status === "fulfilled" ? shuffle(r.value.slice(1, 20)).slice(0, 6) : []));

  // 3. Собираем ответы: чередуем историю и похожие, без повторов одного и того же трека.
  const seen = new Set<string>();
  const uniq = (tracks: Track[]) => {
    const out: QuizItem[] = [];
    for (const t of tracks) {
      const item = toItem(t);
      if (!item) continue;
      const key = `${item.artistKey}|${item.titleKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  };
  const histItems = uniq(shuffle(historyTracks));
  const simItems = uniq(shuffle(similar));
  const chartItems = uniq(shuffle(charts));

  const answers: QuizItem[] = [];
  const need = rounds + 4; // запасные — на случай, если трек не загрузится
  for (let i = 0; answers.length < need && (i < histItems.length || i < simItems.length); i++) {
    if (histItems[i]) answers.push(histItems[i]!);
    if (simItems[i] && answers.length < need) answers.push(simItems[i]!);
  }
  for (const c of chartItems) {
    if (answers.length >= need) break;
    answers.push(c);
  }

  const pool = [...histItems, ...simItems, ...chartItems];
  log.info(`Пул: история ${histItems.length}, похожие ${simItems.length}, чарты ${chartItems.length}, ответов ${answers.length}`);
  return { answers: shuffle(answers), pool };
}

/** Варианты ответа: правильный + до трёх неверных из пула, все разные. */
export function options(correct: QuizItem, pool: QuizItem[], field: "artist" | "title"): { labels: string[]; correctIndex: number } {
  const keyOf = (i: QuizItem) => (field === "artist" ? i.artistKey : i.titleKey);
  const used = new Set([keyOf(correct)]);
  const wrong: string[] = [];
  for (const item of shuffle([...pool])) {
    if (wrong.length >= 3) break;
    const k = keyOf(item);
    if (used.has(k)) continue;
    used.add(k);
    wrong.push(item[field]);
  }
  const labels = shuffle([correct[field], ...wrong]);
  return { labels, correctIndex: labels.indexOf(correct[field]) };
}
