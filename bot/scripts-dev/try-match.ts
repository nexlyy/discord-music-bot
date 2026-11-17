// Проверка сопоставления оригинала и кандидата на замену: tsx scripts-dev/try-match.ts
import { matchScore } from "../src/music/fallback.js";

type C = Parameters<typeof matchScore>[1];
const cases: [string, C, C, boolean][] = [
  ["точная копия на SC", { title: "так похуй", author: "madk1d", duration: 150_000 }, { title: "так похуй", author: "madk1d", duration: 150_400 }, true],
  ["реаплоад с исполнителем в названии", { title: "так похуй", author: "madk1d", duration: 150_000 }, { title: "madk1d - так похуй", author: "user77812", duration: 151_000 }, true],
  ["slowed-версия", { title: "так похуй", author: "madk1d", duration: 150_000 }, { title: "так похуй (slowed + reverb)", author: "madk1d", duration: 190_000 }, false],
  ["тёзка другого артиста", { title: "LMFAO", author: "Kai Angel", duration: 140_000 }, { title: "LMFAO", author: "Vicky", duration: 141_000 }, false],
  ["YouTube official audio", { title: "chrome hearts", author: "Kai Angel", duration: 133_000 }, { title: "Kai Angel - chrome hearts (Official Audio)", author: "Kai Angel", duration: 135_000 }, true],
  ["сильно длиннее (клип)", { title: "chrome hearts", author: "Kai Angel", duration: 133_000 }, { title: "Kai Angel - chrome hearts", author: "Kai Angel", duration: 190_000 }, false],
  ["фит в авторах", { title: "ты че обиделась", author: "madk1d, тёмный принц", duration: 120_000 }, { title: "ты че обиделась (feat. тёмный принц)", author: "madk1d", duration: 121_000 }, true],
  ["Topic-канал", { title: "Sleepwalker", author: "akiaura, LONOWN, STM", duration: 160_000 }, { title: "Sleepwalker", author: "akiaura - Topic", duration: 160_000 }, true],
  ["латиница → кириллица", { title: "Ебашь, Альбина", author: "Valentin Strykalo", duration: 200_000 }, { title: "Ебашь, Альбина", author: "Валентин Стрыкало", duration: 201_000 }, true],
  ["латиница → кириллица 2", { title: "Тмстс", author: "Poshlaya Molly", duration: 170_000 }, { title: "Пошлая Молли - Тмстс", author: "music4u", duration: 171_000 }, true],
  ["кириллица → латиница", { title: "Alfa-Pve", author: "Кишлак", duration: 150_000 }, { title: "Alfa-Pve", author: "Kishlak", duration: 150_000 }, true],
  ["другой трек того же артиста", { title: "Ебашь, Альбина", author: "Valentin Strykalo", duration: 200_000 }, { title: "Наше лето", author: "Валентин Стрыкало", duration: 201_000 }, false],
];
let bad = 0;
for (const [name, orig, cand, expect] of cases) {
  const s = matchScore(orig, cand);
  const ok = (s !== null) === expect;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${s === null ? "отказ" : s.toFixed(2)}`);
}
process.exit(bad ? 1 : 0);
