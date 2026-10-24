// Проверка поиска «дропа» (первого припева) по синхронному тексту из LRCLIB.
import { startPosition } from "../src/quiz/drop.js";
import { formatDuration } from "../src/format.js";

const fakePlayer = { queue: { current: null }, getLyrics: async () => { throw new Error("no lavalink"); }, getCurrentLyrics: async () => null } as never;
const tracks: [string, string, number][] = [
  ["Кино", "Группа крови", 286000],
  ["The Weeknd", "Blinding Lights", 200040],
  ["Земфира", "Искала", 231000],
  ["Daft Punk", "Get Lucky", 369000],
  ["Imagine Dragons", "Believer", 204000],
];
for (const [author, title, duration] of tracks) {
  const track = { info: { title, author, duration, identifier: title, sourceName: "spotify", isStream: false } } as never;
  const pos = await startPosition(fakePlayer, track, "drop");
  console.log(`${author} — ${title}: дроп с ${formatDuration(pos)} (из ${formatDuration(duration)}, треть = ${formatDuration(duration * 0.33)})`);
}
