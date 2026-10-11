import { ActivityType, Client, Events, GatewayIntentBits, type Guild } from "discord.js";
import { commandsJson } from "./commands/definitions.js";
import type { Ctx } from "./commands/common.js";
import { handleInteraction } from "./commands/handlers.js";
import { TrackCache } from "./commands/track-cache.js";
import { loadConfig } from "./config.js";
import { LavalinkAdmin } from "./lavalink-admin.js";
import { HistoryStore } from "./library/history.js";
import { PlaylistStore } from "./library/playlists.js";
import { toStored } from "./library/stored-track.js";
import { VoiceStatus } from "./ui/voice-status.js";
import { Wrapped } from "./wrapped/wrapped.js";
import { createLogger } from "./logger.js";
import { Alerts } from "./monitor.js";
import { createAutoplay } from "./music/autoplay.js";
import { MusicService } from "./music/service.js";
import { SettingsStore } from "./settings.js";
import { LiveLyrics } from "./ui/lyrics-view.js";
import { syncEmojis } from "./ui/emoji.js";
import { PlayerMessage } from "./ui/player-message.js";
import { startPanel } from "./web/server.js";

const log = createLogger("main");
const startedAt = Date.now();
const config = loadConfig();
const settings = new SettingsStore(config.DATA_DIR);
const alerts = new Alerts(config, settings);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const music = new MusicService(client, config, settings);
music.setAutoplay(createAutoplay());
alerts.attach(music);

const playlists = new PlaylistStore(config.DATA_DIR);
const history = new HistoryStore(config.DATA_DIR);

// История прослушиваний: для топов, «Недавних», радио и итогов месяца.
let playing: { startedAt: number; duration: number } | null = null;
const finishPlay = () => {
  if (playing) history.addListenedMs(Math.min(Date.now() - playing.startedAt, playing.duration));
  playing = null;
};
music.lavalink.on("trackStart", (_player, track) => {
  finishPlay();
  const stored = track ? toStored(track) : null;
  const requester = (track?.requester as { id?: string } | undefined)?.id ?? "unknown";
  if (stored && !track?.info.isStream) {
    history.add(requester, stored);
    playing = { startedAt: Date.now(), duration: track!.info.duration };
  }
});
music.lavalink.on("trackEnd", finishPlay);
music.lavalink.on("queueEnd", finishPlay);
music.lavalink.on("playerDestroy", finishPlay);

// Кто сколько слушал: раз в 30 секунд начисляем время тем, кто в канале, пока музыка играет.
setInterval(() => {
  const p = music.player;
  if (p?.queue.current && p.playing && !p.paused) history.addListeners(music.channelListeners(), 30);
}, 30_000);

const wrapped = new Wrapped(client, config, settings, history);
const voiceStatus = new VoiceStatus(client, music, settings);

const ctx: Ctx = {
  config,
  playlists,
  history,
  wrapped,
  music,
  settings,
  playerMessage: new PlayerMessage(client, music, settings),
  lyrics: new LiveLyrics(music, settings),
  cache: new TrackCache(),
};

client.on(Events.Raw, (packet) => void music.lavalink.sendRawData(packet));
client.on(Events.InteractionCreate, (i) => void handleInteraction(i, ctx));
client.on(Events.VoiceStateUpdate, (o, n) => void music.handleVoiceState(o, n).catch((e) => log.warn("voiceState:", e)));

// Статус бота: что играет сейчас.
music.on("update", (reason) => {
  if (!["trackStart", "destroy", "queue"].includes(reason)) return;
  const cur = music.player?.queue.current;
  client.user?.setActivity(cur ? `${cur.info.author} — ${cur.info.title}`.slice(0, 120) : "/play", { type: cur ? ActivityType.Listening : ActivityType.Custom });
});

async function registerCommands(guild: Guild) {
  await guild.commands.set(commandsJson).then(
    (cmds) => log.info(`Зарегистрировано команд: ${cmds.size}`),
    (e) => log.error("Не удалось зарегистрировать команды:", e),
  );
}

// Если бота убрали с сервера и добавили снова (например, ради новых прав), Discord удаляет его команды —
// регистрируем их заново сразу при возвращении.
client.on(Events.GuildCreate, async (guild) => {
  if (guild.id !== config.DISCORD_GUILD_ID) return;
  log.info("Бот снова добавлен на сервер — регистрирую команды");
  await registerCommands(guild);
  await music.ensureStay247();
});
client.on(Events.GuildDelete, (guild) => {
  if (guild.id !== config.DISCORD_GUILD_ID) return;
  log.warn("Бота убрали с сервера");
  void alerts.send("guild-removed", "warn", "🟠 Бота убрали с сервера", "Когда его добавят снова, команды зарегистрируются автоматически.", 0);
});

client.once(Events.ClientReady, async (c) => {
  log.info(`Вошёл как ${c.user.tag}`);
  const guild = c.guilds.cache.get(config.DISCORD_GUILD_ID);
  if (!guild) {
    log.error(`Бот не состоит на сервере ${config.DISCORD_GUILD_ID}. Пригласи его по ссылке из README.`);
  } else {
    await registerCommands(guild);
    // Глобальные команды не используем — чистим, чтобы не было дублей.
    await c.application.commands.set([]).catch(() => undefined);
  }
  c.user.setActivity("/play", { type: ActivityType.Custom });
  await syncEmojis(c);
  await music.init();
  wrapped.start();
  void voiceStatus;
  void alerts.send("started", "info", "✅ Бот запущен", `Вошёл как **${c.user.tag}**.`, 60_000);
});

process.on("unhandledRejection", (e) => {
  log.error("unhandledRejection:", e);
  void alerts.send("unhandled", "error", "⚠️ Необработанная ошибка", String(e instanceof Error ? (e.stack ?? e.message) : e), 15 * 60_000);
});
process.on("uncaughtException", (e) => {
  log.error("uncaughtException:", e);
  // После такого исключения состояние процесса не гарантировано: шлём уведомление и даём Docker перезапустить бота.
  void alerts
    .send("uncaught", "error", "⚠️ Бот упал и перезапускается", e.stack ?? e.message, 15 * 60_000)
    .finally(() => process.exit(1));
});

async function shutdown(signal: string) {
  log.info(`Получен ${signal}, выключаюсь`);
  try {
    await ctx.lyrics.closeAll("Бот перезапускается — открой текст заново через минуту");
    playlists.flush();
    history.flush();
    await client.destroy();
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await startPanel({ config, client, music, settings, admin: new LavalinkAdmin(config, music), alerts, startedAt });
try {
  await client.login(config.DISCORD_TOKEN);
} catch (e) {
  log.error("Не удалось войти в Discord. Проверь DISCORD_TOKEN в .env:", e);
  await alerts.send("login", "error", "🔴 Бот не может войти в Discord", String(e), 60 * 60_000);
  process.exit(1);
}
