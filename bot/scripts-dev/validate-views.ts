// Сборка всех экранов с тестовыми данными: discord.js проверяет ограничения Discord при toJSON().
import { buildPlayerMessage, buildSettingsCard } from "../src/ui/player-view.js";
import { buildQueueMessage } from "../src/ui/queue-view.js";
import { buildPlaylistsHome, buildPlaylistView, buildDeleteConfirm, buildAddToPlaylist } from "../src/ui/library-view.js";
import { buildBrowseHome, buildTopView, buildRecentView, buildEffectsCard, buildRepeatView } from "../src/ui/browse-view.js";
import { buildStatsView } from "../src/ui/stats-view.js";
import { unbanButton, unbanMenu } from "../src/ui/autoplay-view.js";
import { settingsSchema } from "../src/settings.js";
import { lobbyView, roundView, revealView, finalView, topView, noticeView } from "../src/quiz/view.js";

const settings = settingsSchema.parse({});
const tv = (n: number) => ({ title: `Очень длинное название трека номер ${n} `.repeat(4), author: `Исполнитель ${n}`, uri: `https://youtu.be/${n}`, duration: 200000, isStream: false, artworkUrl: "https://i.scdn.co/image/x", sourceName: "spotify", requester: { id: "123456789012345678", username: "u", avatar: null }, playlistName: "xDD", playlistUrl: "https://open.spotify.com/playlist/1" });
const snap = (q: number, cur = true) => ({ active: true, connected: true, voiceChannelId: "1", textChannelId: "2", playing: true, paused: false, position: 1000, volume: 60, repeatMode: "off" as const, autoplay: true, stay247: false, canStay247: true, current: cur ? tv(0) : null, queue: Array.from({ length: q }, (_, i) => tv(i + 1)), queueDuration: q * 200000, previousCount: 2, trackNumber: 3, shuffle: true, effects: ["bass"], updatedAt: Date.now() });
const st = (n: number) => ({ encoded: "QAAA", info: { identifier: `id${n}`, title: `Трек ${n} `.repeat(15), author: "Автор", duration: 180000, artworkUrl: null, uri: "https://x.y/z", sourceName: "youtube", isSeekable: true, isStream: false, isrc: null } });
const pl = (n: number, liked = false) => ({ id: `p${n}`, ownerId: "1", name: `Плейлист ${n}`, liked, sourceUrl: null, createdAt: 0, updatedAt: 0, tracks: Array.from({ length: n }, (_, i) => st(i)) });

const cases: Record<string, () => { components: { toJSON(): unknown }[] }> = {
  player: () => buildPlayerMessage(snap(40), settings),
  playerIdle: () => buildPlayerMessage(snap(0, false), settings),
  settingsCard: () => buildSettingsCard(snap(3), settings),
  queue: () => buildQueueMessage(snap(37), settings, 2),
  queueEmpty: () => buildQueueMessage(snap(0), settings, 1),
  plHome: () => buildPlaylistsHome(Array.from({ length: 30 }, (_, i) => pl(i, i === 0)), settings, "note"),
  plHomeEmpty: () => buildPlaylistsHome([], settings),
  plView: () => buildPlaylistView(pl(35), settings, 2, "note"),
  plViewEmpty: () => buildPlaylistView(pl(0, true), settings, 1),
  plDelete: () => buildDeleteConfirm(pl(3), settings),
  addTo: () => buildAddToPlaylist(Array.from({ length: 30 }, (_, i) => pl(i)), st(1), settings),
  browse: () => buildBrowseHome(settings, 0),
  top: () => buildTopView("server", Array.from({ length: 15 }, (_, i) => ({ track: st(i), plays: i + 1, lastPlayed: 0 })), settings),
  topEmpty: () => buildTopView("me", [], settings),
  browseFull: () => buildBrowseHome(settings, 100, "note"),
  repeat: () => buildRepeatView(Array.from({ length: 30 }, (_, i) => ({ track: st(i), plays: 30 - i, lastPlayed: 0 })), settings),
  repeatEmpty: () => buildRepeatView([], settings),
  stats: () =>
    buildStatsView(
      {
        name: "Очень длинное имя ".repeat(6),
        avatar: "https://cdn.discordapp.com/embed/avatars/0.png",
        period: "Ноябрь 2026",
        stats: {
          listened: 148230,
          listenRank: 2,
          listenersTotal: 5,
          requested: 1234,
          djRank: 1,
          djsTotal: 4,
          topTracks: Array.from({ length: 5 }, (_, i) => ({ title: "Трек ".repeat(30), author: "Kai Angel", uri: i % 2 ? null : "https://open.spotify.com/track/x", plays: 178 - i })),
          topArtists: Array.from({ length: 5 }, (_, i) => ({ name: `Артист ${i}`, plays: 100 - i })),
          hours: Array.from({ length: 24 }, (_, h) => (h < 5 ? 40 : 5)),
        },
        quiz: { points: 4362, games: 2, wins: 2, artist: 5, title: 6, rounds: 22 },
        self: true,
      },
      settings,
    ),
  statsMinimal: () =>
    buildStatsView(
      { name: "u", avatar: "https://cdn.discordapp.com/embed/avatars/0.png", period: "Всё время", stats: { listened: 0, listenRank: 0, listenersTotal: 0, requested: 1, djRank: 1, djsTotal: 1, topTracks: [], topArtists: [], hours: null }, quiz: null, self: false },
      settings,
    ),
  recent: () => buildRecentView(Array.from({ length: 30 }, (_, i) => st(i)), settings),
  effects: () => buildEffectsCard({ bass: true, nightcore: false, vaporwave: false, rotation: true, karaoke: false, tremolo: false, lowPass: false }, settings),
  quizLobby: () => lobbyView({ game: "abc123", accent: "#D4783A", mode: "drop", rounds: 10, seconds: 25, voiceChannelId: "1", startsAt: Date.now() + 8000, hostId: "1" }),
  quizRound: () => roundView({ game: "abc123", accent: "#D4783A", mode: "drop", round: 3, rounds: 10, endsAt: Date.now() + 10000, artists: ["Исполнитель с очень длинным именем ".repeat(4), "Кино", "Земфира", "The Weeknd"], titles: ["Группа крови", "Искала", "Blinding Lights", "Трек ".repeat(30)], answered: 2, listeners: 4, leaders: [{ userId: "1", points: 3400, artist: 3, title: 2 }] }),
  quizRound2opts: () => roundView({ game: "abc123", accent: "#D4783A", mode: "start", round: 1, rounds: 5, endsAt: Date.now() + 10000, artists: ["A", "B"], titles: ["C", "D"], answered: 0, listeners: 1, leaders: [] }),
  quizReveal: () => revealView({ game: "abc123", accent: "#D4783A", mode: "drop", round: 3, rounds: 10, artists: ["A", "B", "C", "D"], titles: ["E", "F", "G", "H"], leaders: [], artist: "Кино", title: "Группа крови", uri: "https://youtu.be/x", artworkUrl: "https://i.scdn.co/image/x", correctArtist: 1, correctTitle: 2, artistWinners: [{ userId: "1", points: 900 }], titleWinners: [], nextAt: Date.now() + 5000 }),
  quizFinal: () => finalView({ accent: "#D4783A", mode: "drop", played: 10, leaders: Array.from({ length: 12 }, (_, i) => ({ userId: String(100000000000000000 + i), points: 9000 - i * 500, artist: 7, title: 5 })), stoppedBy: "1" }),
  quizTop: () => topView("#D4783A", [["1", { points: 54000, games: 12, wins: 5, artist: 80, title: 70, rounds: 120 }]]),
  quizNotice: () => noticeView("#D4783A", "Игра остановлена."),
  unbanMenu: () => ({ components: unbanMenu(Array.from({ length: 30 }, (_, i) => ({ key: `artist${i}`.repeat(20), name: `Исполнитель ${i} `.repeat(12), why: i % 2 ? ("ban" as const) : ("skips" as const), at: i }))) }),
  unbanButton: () => ({ components: [unbanButton("ochen dlinnoe imia ispolnitelia ".repeat(5))] }),
};
let failed = 0;
for (const [name, build] of Object.entries(cases)) {
  try {
    const json = JSON.stringify(build().components.map((c) => c.toJSON()));
    console.log(`ok   ${name} (${json.length} байт)`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${(e as Error).message.split("\n").slice(0, 6).join(" | ")}`);
  }
}
process.exit(failed ? 1 : 0);
