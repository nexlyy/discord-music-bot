import type { Player, Track } from "lavalink-client";
import { getLyrics } from "../music/lyrics.js";

export type QuizMode = "start" | "drop";


const normLine = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * С какого места играть фрагмент.
 * «Дроп» — первый припев: самая повторяющаяся строка синхронного текста. Нет текста (инструментал) —
 * примерно треть трека, где обычно начинается дроп.
 */
/** tailMs — сколько должно остаться после старта: раунд + показ ответа + запас (иначе трек кончится посреди раунда). */
export async function startPosition(player: Player, track: Track, mode: QuizMode, tailMs: number): Promise<number> {
  const duration = track.info.duration ?? 0;
  if (mode === "start" || duration < tailMs + 15_000) return 0;
  const latest = duration - tailMs;
  if (latest <= 0) return 0;
  const fallback = Math.min(Math.max(Math.round(duration * 0.33), 15_000), latest);

  const lyrics = await getLyrics(player, track).catch(() => null);
  if (!lyrics?.synced || lyrics.lines.length < 6) return fallback;

  const counts = new Map<string, { n: number; first: number }>();
  for (const line of lyrics.lines) {
    const key = normLine(line.text);
    if (key.length < 6) continue;
    const e = counts.get(key);
    if (e) e.n++;
    else counts.set(key, { n: 1, first: line.time });
  }
  const chorus = [...counts.values()].filter((e) => e.n >= 2).sort((a, b) => b.n - a.n || a.first - b.first)[0];
  if (!chorus) return fallback;
  const start = chorus.first - 1_000;
  return start >= 10_000 && start <= latest ? start : fallback;
}
