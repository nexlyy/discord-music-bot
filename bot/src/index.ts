import { ActivityType, Client, Events, GatewayIntentBits, MessageFlags, type Guild, type GuildMember, type Interaction } from "discord.js";
import type { Ctx } from "./commands/common.js";
import { commandsJson } from "./commands/definitions.js";
import { handleInteraction } from "./commands/handlers.js";
import { TrackCache } from "./commands/track-cache.js";
import { loadConfig } from "./config.js";
import { LavalinkAdmin } from "./lavalink-admin.js";
import { HistoryStore } from "./library/history.js";
import { PlaylistStore } from "./library/playlists.js";
import { toStored } from "./library/stored-track.js";
import { createLogger } from "./logger.js";
import { Alerts } from "./monitor.js";
import { createAutoplay } from "./music/autoplay.js";
import { MusicService } from "./music/service.js";
import { SessionKeeper } from "./music/session.js";
import { QuizManager } from "./quiz/game.js";
import { QuizStore } from "./quiz/store.js";
import { SettingsStore } from "./settings.js";
import { syncEmojis, withEmojiScope } from "./ui/emoji.js";
import { LiveLyrics } from "./ui/lyrics-view.js";
import { PlayerMessage } from "./ui/player-message.js";
import { VoiceStatus } from "./ui/voice-status.js";
import { startPanel } from "./web/server.js";
import { Wrapped } from "./wrapped/wrapped.js";

const log = createLogger("main");
const startedAt = Date.now();
const config = loadConfig();
const settings = new SettingsStore(config.DATA_DIR);
const alerts = new Alerts(config, settings);

// Общие для всех Артуров данные.
const playlists = new PlaylistStore(config.DATA_DIR);
const history = new HistoryStore(config.DATA_DIR);
const quizStore = new QuizStore(config.DATA_DIR);
const cache = new TrackCache();

/**
 * Discord пускает одного бота только в один голосовой канал сервера, поэтому для нескольких каналов —
 * несколько ботов. Главный (index 0) держит слэш-команды и режим 24/7, помощники играют в других войсах.
 */
export interface BotInstance {
  index: number;
  client: Client;
  music: MusicService;
  playerMessage: PlayerMessage;
  lyrics: LiveLyrics;
  quiz: QuizManager;
  voiceStatus: VoiceStatus;
  sessions: SessionKeeper;
}

const instances: BotInstance[] = [];

function createInstance(index: number): BotInstance {
  const client = new Client({
    // GuildMessages нужен только чтобы знать, что в канале появилось сообщение (текст боту не нужен).
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages],
  });
  const music = new MusicService(client, config, settings, index === 0);
  music.setAutoplay(createAutoplay());
  alerts.attach(music);

  // Бесшовный перезапуск: продолжаем то, что играло до обновления/перезапуска, в том же сообщении плеера.
  const playerMessage = new PlayerMessage(client, music, settings);
  const sessions = new SessionKeeper(music, config.DATA_DIR, index === 0 ? "session.json" : `session-${index}.json`, playerMessage);
  const pending = sessions.takePending();
  if (pending) music.onFirstReady = () => sessions.restore(pending);
  sessions.start();

  // История прослушиваний: для топов, «Недавних», радио и итогов месяца.
  let playing: { startedAt: number; duration: number } | null = null;
  const finishPlay = () => {
    if (playing) history.addListenedMs(Math.min(Date.now() - playing.startedAt, playing.duration));
    playing = null;
  };
  music.lavalink.on("trackStart", (_player, track) => {
    finishPlay();
    if (music.quietMode) return; // треки «Угадай трек» не попадают в историю и итоги
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

  const inst: BotInstance = {
    index,
    client,
    music,
    sessions,
    playerMessage,
    lyrics: new LiveLyrics(music, settings),
    quiz: new QuizManager(client, music, history, settings, quizStore),
    voiceStatus: new VoiceStatus(client, music, settings),
  };

  client.on(Events.Raw, (packet) => void music.lavalink.sendRawData(packet));
  client.on(Events.InteractionCreate, (i) => void dispatch(i));
  client.on(Events.VoiceStateUpdate, (o, n) => void music.handleVoiceState(o, n).catch((e) => log.warn("voiceState:", e)));

  // Статус бота: что играет сейчас.
  music.on("quiet", (on) => {
    if (on) client.user?.setActivity("🎮 Угадай трек", { type: ActivityType.Custom });
  });
  music.on("update", (reason) => {
    if (!["trackStart", "destroy", "queue"].includes(reason)) return;
    const cur = music.player?.queue.current;
    client.user?.setActivity(cur ? `${cur.info.author} — ${cur.info.title}`.slice(0, 120) : "/play", { type: cur ? ActivityType.Listening : ActivityType.Custom });
  });

  // Если бота убрали с сервера и добавили снова (например, ради новых прав), Discord удаляет его команды.
  client.on(Events.GuildCreate, async (guild) => {
    if (guild.id !== config.DISCORD_GUILD_ID) return;
    log.info(`${client.user?.username}: снова на сервере`);
    if (index === 0) await registerCommands(guild);
    await music.ensureStay247();
  });
  client.on(Events.GuildDelete, (guild) => {
    if (guild.id !== config.DISCORD_GUILD_ID) return;
    log.warn(`${client.user?.username}: убрали с сервера`);
    void alerts.send(`guild-removed-${index}`, "warn", `🟠 ${client.user?.username ?? "Бота"} убрали с сервера`, "Когда его добавят снова, всё подключится автоматически.", 0);
  });

  client.once(Events.ClientReady, async (c) => {
    log.info(`Вошёл как ${c.user.tag}${index ? ` (помощник ${index})` : ""}`);
    const guild = c.guilds.cache.get(config.DISCORD_GUILD_ID);
    if (!guild) {
      log.error(`${c.user.username} не состоит на сервере ${config.DISCORD_GUILD_ID}. Пригласи его по ссылке из README.`);
    } else if (index === 0) {
      await registerCommands(guild);
    } else {
      // У помощников своих команд нет: всё вызывается через главного Артура.
      await guild.commands.set([]).catch(() => undefined);
    }
    await c.application.commands.set([]).catch(() => undefined);
    c.user.setActivity("/play", { type: ActivityType.Custom });
    await syncEmojis(c);
    await music.init();
    // Когда сессия восстановится и плеер будет подхвачен, убираем плееры, брошенные прошлым запуском.
    setTimeout(() => void inst.playerMessage.sweepGuild(config.DISCORD_GUILD_ID).catch((e) => log.warn("Уборка плееров:", e)), 20_000);
    if (index === 0) {
      wrapped.start();
      void alerts.send("started", "info", "✅ Бот запущен", `Вошёл как **${c.user.tag}**, помощников: ${instances.length - 1}.`, 60_000);
    }
  });

  return inst;
}

async function registerCommands(guild: Guild) {
  await guild.commands.set(commandsJson).then(
    (cmds) => log.info(`Зарегистрировано команд: ${cmds.size}`),
    (e) => log.error("Не удалось зарегистрировать команды:", e),
  );
}

const tokens = [config.DISCORD_TOKEN, ...config.DISCORD_HELPER_TOKENS];
tokens.forEach((_, index) => instances.push(createInstance(index)));
const main = instances[0]!;
const wrapped = new Wrapped(main.client, config, settings, history, quizStore);

/**
 * Какой Артур отвечает на действие. Кнопки помощника — сам помощник. Для команд главного: тот, кто уже
 * играет в войсе пользователя, иначе первый свободный (главный, если не занят). 24/7 — только главный.
 */
function pickInstance(i: Interaction): { inst: BotInstance; bound: boolean } {
  const voice = (i.member as GuildMember | null)?.voice?.channelId ?? null;
  const own = instances.find((x) => x.client === i.client) ?? main;
  const servesVoice = (x: BotInstance) => Boolean(voice) && (x.music.player?.voiceChannelId === voice || x.music.isFreeFor(voice!));
  // Кнопки на обычных сообщениях бота (его плеер, «Угадай трек») — к тому Артуру, что их отправил.
  // Скрытые ответы (очередь, плейлисты, обзор) общие — для них решает войс пользователя.
  if (i.isMessageComponent() && !i.message.flags.has(MessageFlags.Ephemeral)) return { inst: own, bound: servesVoice(own) };
  if (own.index !== 0) return { inst: own, bound: servesVoice(own) };
  if (i.isChatInputCommand() && i.commandName === "247") return { inst: main, bound: servesVoice(main) };
  if (!voice) return { inst: main, bound: false };
  // Главный Артур держится за основной канал (выбранный для 24/7): в другие войсы сначала идут помощники.
  const home = settings.get().stay247ChannelId;
  const order = voice === home || !home ? instances : [...instances.slice(1), main];
  const serving = instances.find((x) => x.music.player?.voiceChannelId === voice) ?? order.find((x) => x.music.isFreeFor(voice));
  return serving ? { inst: serving, bound: true } : { inst: main, bound: false };
}

function ctxFor(inst: BotInstance, bound: boolean): Ctx {
  return {
    config,
    settings,
    playlists,
    history,
    wrapped,
    cache,
    music: inst.music,
    quiz: inst.quiz,
    playerMessage: inst.playerMessage,
    lyrics: inst.lyrics,
    instanceIndex: inst.index,
    boundToVoice: bound,
    bots: instances.map((x) => ({ client: x.client, playerMessage: x.playerMessage })),
  };
}

async function dispatch(i: Interaction) {
  const { inst, bound } = pickInstance(i);
  // Отвечает тот бот, которому пришло взаимодействие, — значит, и иконки его.
  await withEmojiScope(i.client.application?.id, () => handleInteraction(i, ctxFor(inst, bound)));
}

// Кто сколько слушал: раз в 30 секунд начисляем время тем, кто в канале, пока музыка играет.
setInterval(() => {
  for (const { music } of instances) {
    const p = music.player;
    if (p?.queue.current && p.playing && !p.paused && !music.quietMode) history.addListeners(music.channelListeners(), 30);
  }
}, 30_000);

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
    for (const inst of instances) inst.sessions.saveAndFreeze();
    await Promise.all(instances.map((x) => x.lyrics.closeAll("Бот перезапускается — открой текст заново через минуту")));
    playlists.flush();
    history.flush();
    await Promise.all(instances.map((x) => x.client.destroy()));
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await startPanel({
  config,
  client: main.client,
  bots: instances.map((x) => ({ index: x.index, client: x.client, music: x.music })),
  settings,
  admin: new LavalinkAdmin(config, main.music),
  alerts,
  startedAt,
});

for (const [index, token] of tokens.entries()) {
  try {
    await instances[index]!.client.login(token);
  } catch (e) {
    const who = index === 0 ? "Главный бот" : `Помощник ${index}`;
    log.error(`${who} не может войти в Discord. Проверь токен в .env:`, e);
    await alerts.send(`login-${index}`, "error", `🔴 ${who} не может войти в Discord`, String(e), 60 * 60_000);
    if (index === 0) process.exit(1);
  }
}
