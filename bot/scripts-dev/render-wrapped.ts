// Пример карточки итогов с тестовыми данными: npx tsx scripts-dev/render-wrapped.ts out.png
import { writeFileSync } from "node:fs";
import { renderWrapped } from "../src/wrapped/render.js";

const png = await renderWrapped({
  title: "Октябрь 2026",
  subtitle: "Итоги месяца",
  guildName: "nсuхо\nатi",
  guildIcon: null,
  accent: "#D4783A",
  totals: { hours: 128.4, plays: 1240, tracks: 812, artists: 312 },
  topTracks: [
    { title: "Give Me Everything (feat. Nayer)", author: "Pitbull, AFROJACK, Ne-Yo, Nayer", artworkUrl: "https://i.scdn.co/image/ab67616d0000b2738863bc11d2aa12b54f5aeb36", plays: 42 },
    { title: "Группа крови", author: "Кино", artworkUrl: "https://i.ytimg.com/vi/X9B2TkZ_Qe0/hqdefault.jpg", plays: 31 },
    { title: "Blinding Lights", author: "The Weeknd", artworkUrl: null, plays: 27 },
    { title: "Очень длинное название трека, которое точно не поместится в одну строку карточки", author: "Исполнитель с длинным именем feat. Ещё один", artworkUrl: null, plays: 19 },
    { title: "Искала", author: "Земфира", artworkUrl: null, plays: 12 },
  ],
  topArtists: [
    { name: "The Weeknd", plays: 88 }, { name: "Кино", plays: 61 }, { name: "Pitbull", plays: 44 },
    { name: "Земфира", plays: 39 }, { name: "Скриптонит", plays: 25 }, { name: "Daft Punk", plays: 18 },
  ],
  topListener: { name: "syncae", avatar: null, hours: 41.6 },
  topDj: { name: "артур", avatar: null, plays: 180 },
  quizChampion: { name: "syncae", avatar: null, points: 54300 },
});
writeFileSync(process.argv[2] ?? "wrapped.png", png);
console.log("ok", png.length);
