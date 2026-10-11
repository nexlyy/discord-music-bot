// Проверка реального воспроизведения в Lavalink без Discord: создаёт плееры через REST и ждёт событий трека.
// Запуск на сервере: bash scripts/probe-playback.sh [ссылка или запрос ...]
import WebSocket from "ws";

const P = process.env.LAVALINK_PASSWORD;
const H = process.env.LAVALINK_HOST ?? "lavalink:2333";
const DEFAULT = [
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://www.youtube.com/watch?v=kJQP7kiw5Fk",
  "https://www.youtube.com/watch?v=9bZkp7q19f0",
  "https://www.youtube.com/watch?v=lp0drugrSM4",
  "https://www.youtube.com/watch?v=8CFh_-qtzeg",
  "ytmsearch:кино группа крови",
  "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b",
  "https://music.apple.com/us/album/blinding-lights/1499378108?i=1499378615",
  "https://soundcloud.com/forss/flickermood",
];
const ids = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT;
const state = new Map();
const headers = { Authorization: P, "Content-Type": "application/json" };

const ws = new WebSocket(`ws://${H}/v4/websocket`, { headers: { Authorization: P, "User-Id": "1", "Client-Name": "probe/1.0" } });
ws.on("message", async (raw) => {
  const m = JSON.parse(raw);
  if (m.op === "ready") return run(m.sessionId);
  if (m.op !== "event") return;
  const s = state.get(m.guildId);
  if (!s) return;
  if (m.type === "TrackExceptionEvent") s.error = (m.exception?.message ?? "").split("\n").filter((l) => l.startsWith("Client [") || !l.startsWith("\t")).slice(0, 8).join(" | ");
  if (m.type === "TrackStuckEvent") s.error = "stuck";
});

async function run(session) {
  let guild = 100000000000000000n;
  for (const id of ids) {
    const g = String(guild++);
    const s = { id, title: "", error: null };
    state.set(g, s);
    const r = await (await fetch(`http://${H}/v4/loadtracks?identifier=${encodeURIComponent(id)}`, { headers })).json();
    const t = r.loadType === "track" ? r.data : r.loadType === "search" ? r.data[0] : r.loadType === "playlist" ? r.data.tracks[0] : null;
    if (!t) { s.error = `load: ${r.loadType} ${r.data?.message ?? ""}`; continue; }
    s.title = `${t.info.author} — ${t.info.title}`.slice(0, 50);
    await fetch(`http://${H}/v4/sessions/${session}/players/${g}`, { method: "PATCH", headers, body: JSON.stringify({ track: { encoded: t.encoded } }) });
  }
  setTimeout(async () => {
    let ok = 0;
    for (const [g, s] of state) {
      if (!s.error) ok++;
      console.log(`${s.error ? "✗" : "✓"} ${s.id.replace(/^https?:\/\/(www\.)?/, "").slice(0, 48).padEnd(48)} ${s.title}${s.error ? `\n    ${s.error.slice(0, 400)}` : ""}`);
      await fetch(`http://${H}/v4/sessions/${session}/players/${g}`, { method: "DELETE", headers }).catch(() => {});
    }
    console.log(`\nИтого: ${ok}/${state.size} играют`);
    process.exit(ok === state.size ? 0 : 1);
  }, 20000);
}
