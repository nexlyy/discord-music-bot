import { ActivityType, Client, Events, GatewayIntentBits } from "discord.js";
import { commandsJson } from "./commands/definitions.js";
import { handleInteraction, type Ctx } from "./commands/handlers.js";
import { TrackCache } from "./commands/track-cache.js";
import { loadConfig } from "./config.js";
import { LavalinkAdmin } from "./lavalink-admin.js";
import { createLogger } from "./logger.js";
import { Alerts } from "./monitor.js";
import { createAutoplay } from "./music/autoplay.js";
import { MusicService } from "./music/service.js";
import { SettingsStore } from "./settings.js";
import { LiveLyrics } from "./ui/lyrics-view.js";
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

const ctx: Ctx = {
  config,
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

client.once(Events.ClientReady, async (c) => {
  log.info(`Вошёл как ${c.user.tag}`);
  const guild = c.guilds.cache.get(config.DISCORD_GUILD_ID);
  if (!guild) {
    log.error(`Бот не состоит на сервере ${config.DISCORD_GUILD_ID}. Пригласи его по ссылке из README.`);
  } else {
    await guild.commands.set(commandsJson).then(
      (cmds) => log.info(`Зарегистрировано команд: ${cmds.size}`),
      (e) => log.error("Не удалось зарегистрировать команды:", e),
    );
    // Глобальные команды не используем — чистим, чтобы не было дублей.
    await c.application.commands.set([]).catch(() => undefined);
  }
  c.user.setActivity("/play", { type: ActivityType.Custom });
  await music.init();
  void alerts.send("started", "info", "✅ Бот запущен", `Вошёл как **${c.user.tag}**.`, 60_000);
});

process.on("unhandledRejection", (e) => {
  log.error("unhandledRejection:", e);
  void alerts.send("unhandled", "error", "⚠️ Необработанная ошибка", String(e instanceof Error ? (e.stack ?? e.message) : e), 15 * 60_000);
});
process.on("uncaughtException", (e) => {
  log.error("uncaughtException:", e);
  void alerts.send("uncaught", "error", "⚠️ Необработанное исключение", e.stack ?? e.message, 15 * 60_000);
});

async function shutdown(signal: string) {
  log.info(`Получен ${signal}, выключаюсь`);
  try {
    await ctx.lyrics.close();
    await client.destroy();
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await startPanel({ config, client, music, settings, admin: new LavalinkAdmin(config, music), alerts, startedAt });
await client.login(config.DISCORD_TOKEN);
