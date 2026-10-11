import {
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Interaction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type User,
} from "discord.js";
import type { RepeatMode, Track } from "lavalink-client";
import type { Config } from "../config.js";
import { escapeMd, formatDuration, parseTime, tracksWord, truncate } from "../format.js";
import { createLogger } from "../logger.js";
import type { MusicService, PlayResult } from "../music/service.js";
import { MusicError, type Requester } from "../music/types.js";
import type { SettingsStore } from "../settings.js";
import { SEARCH_SOURCES, SEARCH_SOURCE_KEYS, isSearchSourceKey, isUrl, sourceInfo, type SearchSourceKey } from "../sources.js";
import type { LiveLyrics } from "../ui/lyrics-view.js";
import { LYRICS_IDS } from "../ui/lyrics-view.js";
import type { PlayerMessage } from "../ui/player-message.js";
import { OPTION_VALUES, PLAYER_IDS, SETTINGS_IDS, buildSettingsCard } from "../ui/player-view.js";
import { QUEUE_JUMP_ID, QUEUE_PAGE_PREFIX, buildQueueMessage } from "../ui/queue-view.js";
import type { TrackCache } from "./track-cache.js";

const log = createLogger("commands");

export interface Ctx {
  config: Config;
  music: MusicService;
  settings: SettingsStore;
  playerMessage: PlayerMessage;
  lyrics: LiveLyrics;
  cache: TrackCache;
}

type Replyable = ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

function toRequester(user: User): Requester {
  return { id: user.id, username: user.globalName ?? user.username, avatar: user.displayAvatarURL() };
}

function userVoiceChannel(i: Interaction): string | null {
  const member = i.member as GuildMember | null;
  return member?.voice?.channelId ?? null;
}

/** Управлять плеером можно только из того же голосового канала. */
function assertSameChannel(i: Interaction, music: MusicService) {
  const botChannel = music.player?.voiceChannelId;
  if (!botChannel) return;
  if (userVoiceChannel(i) !== botChannel) throw new MusicError(`Зайди в <#${botChannel}>, чтобы управлять музыкой.`);
}

async function say(i: Replyable, content: string, ephemeral = true) {
  const payload = { content, allowedMentions: { parse: [] as never[] }, flags: (ephemeral ? MessageFlags.Ephemeral : 0) | MessageFlags.SuppressEmbeds };
  if (i.deferred || i.replied) await i.followUp(payload);
  else await i.reply(payload);
}

async function fail(i: Replyable, error: unknown) {
  const text = error instanceof MusicError ? error.message : "Что-то пошло не так. Подробности в логах веб-панели.";
  if (!(error instanceof MusicError)) log.error("Ошибка обработки:", error);
  try {
    // У кнопок deferUpdate привязан к сообщению плеера — editReply переписал бы его, поэтому только followUp.
    if (i.isChatInputCommand() && i.deferred && !i.replied) await i.editReply({ content: `❌ ${text}`, allowedMentions: { parse: [] } });
    else await say(i, `❌ ${text}`);
  } catch (e) {
    log.warn("Не удалось ответить на взаимодействие:", e);
  }
}

function trackLink(t: Track): string {
  const name = escapeMd(truncate(`${t.info.author} — ${t.info.title}`, 90));
  return t.info.uri ? `[${name}](<${t.info.uri}>)` : name;
}

function describePlay(r: PlayResult): string {
  const first = r.added[0]!;
  const skipped = r.skipped > 0 ? `\n-# Пропущено: ${tracksWord(r.skipped)} (лимиты очереди/длительности)` : "";
  if (r.playlistName) {
    const total = r.added.reduce((s, t) => s + (t.info.duration ?? 0), 0);
    return `📃 Добавлен плейлист **${escapeMd(truncate(r.playlistName, 80))}** — ${tracksWord(r.added.length)}, ${formatDuration(total)}${r.startedNow ? "\n▶️ Начинаю воспроизведение" : ""}${skipped}`;
  }
  const src = sourceInfo(first.info.sourceName);
  if (r.startedNow) return `▶️ Включаю ${src.emoji} ${trackLink(first)} \`${formatDuration(first.info.duration)}\`${skipped}`;
  return `➕ В очереди под номером **${r.position}**: ${src.emoji} ${trackLink(first)} \`${formatDuration(first.info.duration)}\`${skipped}`;
}

/* ------------------------------- команды ------------------------------- */

async function runCommand(i: ChatInputCommandInteraction, ctx: Ctx) {
  const { music, settings } = ctx;

  switch (i.commandName) {
    case "play": {
      const voice = userVoiceChannel(i);
      if (!voice) throw new MusicError("Сначала зайди в голосовой канал.");
      await i.deferReply();
      const raw = i.options.getString("запрос", true);
      const sourceOpt = i.options.getString("площадка");
      const source = isSearchSourceKey(sourceOpt) ? sourceOpt : undefined;
      const cached = ctx.cache.getTrack(raw);
      const track = cached ? ({ ...cached, requester: toRequester(i.user) } as Track) : undefined;
      const query = ctx.cache.getText(raw) ?? raw;
      const result = await music.play({
        query,
        source,
        track,
        voiceChannelId: voice,
        textChannelId: i.channelId,
        requester: toRequester(i.user),
        next: i.options.getBoolean("следующим") ?? false,
      });
      await i.editReply({ content: describePlay(result), allowedMentions: { parse: [] } });
      return;
    }
    case "pause": {
      assertSameChannel(i, music);
      const paused = await music.togglePause();
      return say(i, paused ? "⏸ Пауза" : "▶️ Продолжаю");
    }
    case "skip": {
      assertSameChannel(i, music);
      const n = i.options.getInteger("сколько") ?? 1;
      await music.skip(n);
      return say(i, n > 1 ? `⏭ Пропущено ${tracksWord(n)}` : "⏭ Следующий трек");
    }
    case "previous": {
      assertSameChannel(i, music);
      const t = await music.previous();
      return say(i, `⏮ Возвращаюсь к ${trackLink(t)}`);
    }
    case "stop": {
      assertSameChannel(i, music);
      await music.stop();
      return say(i, settings.get().stay247 ? "⏹ Остановлено, очередь очищена. Остаюсь в канале (24/7)." : "⏹ Остановлено, до встречи!", false);
    }
    case "leave": {
      assertSameChannel(i, music);
      const was247 = settings.get().stay247;
      if (was247) settings.update({ stay247: false });
      await music.leave();
      return say(i, `👋 Вышел из канала${was247 ? ". Режим 24/7 выключен." : ""}`, false);
    }
    case "queue": {
      const page = i.options.getInteger("страница") ?? 1;
      await i.reply({ ...buildQueueMessage(music.snapshot(), settings.get(), page), flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return;
    }
    case "nowplaying": {
      if (!music.player) throw new MusicError("Сейчас ничего не играет.");
      ctx.playerMessage.bump();
      return say(i, "🎶 Мини-плеер внизу чата");
    }
    case "shuffle": {
      assertSameChannel(i, music);
      const n = await music.shuffle();
      return say(i, `🔀 Перемешал ${tracksWord(n)}`);
    }
    case "loop": {
      assertSameChannel(i, music);
      const mode = i.options.getString("режим", true) as RepeatMode;
      await music.setRepeat(mode);
      return say(i, mode === "off" ? "➡️ Повтор выключен" : mode === "queue" ? "🔁 Повторяю очередь" : "🔂 Повторяю трек");
    }
    case "volume": {
      assertSameChannel(i, music);
      const v = await music.setVolume(i.options.getInteger("уровень", true));
      return say(i, `🔊 Громкость ${v}%`);
    }
    case "seek": {
      assertSameChannel(i, music);
      const ms = parseTime(i.options.getString("время", true));
      if (ms === null) throw new MusicError("Не понял время. Пример: `1:30` или `90`.");
      await music.seek(ms);
      return say(i, `⏩ Перемотал на ${formatDuration(ms)}`);
    }
    case "remove": {
      assertSameChannel(i, music);
      const t = await music.remove(i.options.getInteger("номер", true));
      return say(i, `🗑 Убрал из очереди: ${escapeMd(truncate(t.info.title, 90))}`);
    }
    case "move": {
      assertSameChannel(i, music);
      const to = i.options.getInteger("куда", true);
      const t = await music.move(i.options.getInteger("откуда", true), to);
      return say(i, `↕️ ${escapeMd(truncate(t.info.title, 90))} теперь под номером ${to}`);
    }
    case "jump": {
      assertSameChannel(i, music);
      const t = await music.jump(i.options.getInteger("номер", true));
      return say(i, `⏩ Перехожу к ${escapeMd(truncate(t.info.title, 90))}`);
    }
    case "clear": {
      assertSameChannel(i, music);
      const n = await music.clear();
      return say(i, `🧹 Очередь очищена (${tracksWord(n)})`);
    }
    case "autoplay": {
      const enabled = i.options.getBoolean("включить") ?? !settings.get().autoplay;
      music.setAutoplayEnabled(enabled);
      return say(i, enabled ? "♾️ Автоплей включён: когда очередь кончится, добавлю похожие треки" : "♾️ Автоплей выключен");
    }
    case "lyrics": {
      if (!music.player?.queue.current) throw new MusicError("Сейчас ничего не играет.");
      if (!i.channel?.isSendable()) throw new MusicError("Не могу писать в этот канал.");
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await ctx.lyrics.open(i.channel);
      await i.editReply("🎤 Текст песни в чате, он будет следовать за треком");
      return;
    }
    case "247": {
      const enabled = i.options.getBoolean("включить") ?? !settings.get().stay247;
      if (enabled) {
        const voice = music.player?.voiceChannelId ?? userVoiceChannel(i);
        if (!voice) throw new MusicError("Зайди в голосовой канал, где бот должен дежурить, и повтори команду.");
        settings.update({ stay247: true, stay247ChannelId: voice });
        await music.ensurePlayer(voice, i.channelId);
        music.emit("update", "settings");
        return say(i, `🌙 Режим 24/7 включён: остаюсь в <#${voice}> и вернусь туда после перезапуска`, false);
      }
      settings.update({ stay247: false });
      music.emit("update", "settings");
      return say(i, "☀️ Режим 24/7 выключен", false);
    }
    case "panel": {
      return say(
        i,
        [
          "🛠 **Веб-панель** открыта только для владельца сервера через SSH-туннель.",
          "На своём компьютере запусти `open-panel.cmd` из папки проекта (или команду ниже) и открой http://localhost:8090",
          "```",
          "ssh -N -L 8090:127.0.0.1:8090 mcr",
          "```",
        ].join("\n"),
      );
    }
  }
}

/* ---------------------------- автодополнение ---------------------------- */

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error("timeout")), ms)))]).finally(() => clearTimeout(t));
}

async function runAutocomplete(i: AutocompleteInteraction, ctx: Ctx) {
  const focused = i.options.getFocused(true);
  if (i.commandName !== "play" || focused.name !== "запрос") return i.respond([]);
  const q = String(focused.value).trim();

  if (q.length < 2) {
    // Пустое поле: предлагаем недавние треки.
    const recent = ctx.music.player?.queue.previous ?? [];
    const seen = new Set<string>();
    const choices = recent
      .filter((t) => (seen.has(t.info.identifier) ? false : (seen.add(t.info.identifier), true)))
      .slice(0, 10)
      .map((t) => ({ name: truncate(`🕘 ${t.info.author} — ${t.info.title}`, 100), value: ctx.cache.putTrack(t) }));
    return i.respond(choices);
  }

  if (isUrl(q)) {
    // Загружаем ссылку и показываем, что по ней найдено. Если выбрать вариант, /play получит готовый трек.
    const raw = q.length <= 100 ? q : ctx.cache.putText(q);
    const linkChoice = { name: truncate(`🔗 ${q}`, 100), value: raw };
    try {
      let result = ctx.cache.getSearch(`url:${q}`);
      if (!result) {
        result = await withTimeout(ctx.music.search(q, undefined, toRequester(i.user)), 2300);
        ctx.cache.putSearch(`url:${q}`, result);
      }
      if (result.loadType === "playlist") {
        const name = result.playlist?.name ?? "Плейлист";
        return i.respond([{ name: truncate(`📃 ${name} — ${tracksWord(result.tracks.length)}`, 100), value: raw }]);
      }
      const t = result.tracks[0];
      if (!t) return i.respond([linkChoice]);
      const dur = t.info.isStream ? "LIVE" : formatDuration(t.info.duration);
      return i.respond([{ name: truncate(`${sourceInfo(t.info.sourceName).emoji} ${t.info.author} — ${t.info.title} · ${dur}`, 100), value: ctx.cache.putTrack(t) }]);
    } catch {
      return i.respond([linkChoice]);
    }
  }

  const sourceOpt = i.options.getString("площадка");
  const source: SearchSourceKey = isSearchSourceKey(sourceOpt) ? sourceOpt : (ctx.settings.get().defaultSource as SearchSourceKey);
  const cacheKey = `${source}:${q.toLowerCase()}`;
  const fallback = [{ name: truncate(`🔍 Искать «${q}» в ${SEARCH_SOURCES[source].label}`, 100), value: q.length <= 100 ? q : ctx.cache.putText(q) }];

  try {
    let result = ctx.cache.getSearch(cacheKey);
    if (!result) {
      result = await withTimeout(ctx.music.search(q, source, toRequester(i.user)), 2300);
      ctx.cache.putSearch(cacheKey, result);
    }
    const choices = result.tracks.slice(0, 10).map((t) => {
      const dur = t.info.isStream ? "LIVE" : formatDuration(t.info.duration);
      return { name: truncate(`${sourceInfo(t.info.sourceName).emoji} ${t.info.author} — ${t.info.title} · ${dur}`, 100), value: ctx.cache.putTrack(t) };
    });
    await i.respond(choices.length ? choices : fallback);
  } catch {
    await i.respond(fallback).catch(() => undefined);
  }
}

/* --------------------------- кнопки и меню --------------------------- */

const ADD_MODAL_ID = "mp:addmodal";

function buildAddModal(ctx: Ctx) {
  const def = ctx.settings.get().defaultSource;
  return new ModalBuilder()
    .setCustomId(ADD_MODAL_ID)
    .setTitle("Добавить трек")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Название или ссылка")
        .setDescription("YouTube, Spotify, SoundCloud, Apple Music, Яндекс, VK — трек, альбом или плейлист")
        .setTextInputComponent(
          new TextInputBuilder().setCustomId("query").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(500).setPlaceholder("Например: Кино — Группа крови"),
        ),
      new LabelBuilder()
        .setLabel("Где искать по названию")
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId("source")
            .addOptions(SEARCH_SOURCE_KEYS.map((k) => ({ label: SEARCH_SOURCES[k].label, value: k, default: k === def }))),
        ),
      new LabelBuilder()
        .setLabel("Куда поставить")
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId("position")
            .addOptions({ label: "В конец очереди", value: "end", default: true }, { label: "Следующим", value: "next" }),
        ),
    );
}

async function runOption(i: StringSelectMenuInteraction, ctx: Ctx) {
  const { music, settings } = ctx;
  switch (i.values[0]) {
    case OPTION_VALUES.loopQueue:
      await music.toggleRepeat("queue");
      break;
    case OPTION_VALUES.loopTrack:
      await music.toggleRepeat("track");
      break;
    case OPTION_VALUES.autoplay:
      music.setAutoplayEnabled(!settings.get().autoplay);
      break;
    case OPTION_VALUES.volDown:
      await music.changeVolume(-settings.get().volumeStep);
      break;
    case OPTION_VALUES.volUp:
      await music.changeVolume(settings.get().volumeStep);
      break;
    case OPTION_VALUES.stay247: {
      if (settings.get().stay247) {
        settings.update({ stay247: false });
      } else {
        const voice = music.player?.voiceChannelId ?? userVoiceChannel(i);
        if (!voice) throw new MusicError("Зайди в голосовой канал, где бот должен дежурить.");
        settings.update({ stay247: true, stay247ChannelId: voice });
      }
      music.emit("update", "settings");
      break;
    }
    case OPTION_VALUES.clear:
      await music.clear();
      break;
    case OPTION_VALUES.stop:
      await music.stop();
      break;
  }
  // Меню должно сброситься на подсказку, даже если состояние не изменилось.
  ctx.playerMessage.refresh();
}

async function runComponent(i: ButtonInteraction | StringSelectMenuInteraction, ctx: Ctx) {
  const { music, settings } = ctx;
  const id = i.customId;

  if (id.startsWith(QUEUE_PAGE_PREFIX)) {
    const page = Number(id.slice(QUEUE_PAGE_PREFIX.length).split(":")[0]) || 1;
    await i.update(buildQueueMessage(music.snapshot(), settings.get(), page));
    return;
  }
  if (id === QUEUE_JUMP_ID && i.isStringSelectMenu()) {
    assertSameChannel(i, music);
    await music.jump(Number(i.values[0]));
    await i.update(buildQueueMessage(music.snapshot(), settings.get(), 1));
    return;
  }

  if (id === LYRICS_IDS.close) {
    await i.deferUpdate();
    if (ctx.lyrics.isLyricsMessage(i.message.id)) await ctx.lyrics.close();
    else await i.message.delete().catch(() => undefined);
    return;
  }
  if (id === LYRICS_IDS.full) {
    const lyr = ctx.lyrics.currentLyrics();
    const text = lyr?.text?.trim() || lyr?.lines.map((l) => l.text).join("\n") || "Текст не найден.";
    return say(i, truncate(text, 1950));
  }

  if (id.startsWith("st:")) {
    if (id === SETTINGS_IDS.volDown || id === SETTINGS_IDS.volUp) {
      assertSameChannel(i, music);
      await music.changeVolume((id === SETTINGS_IDS.volUp ? 1 : -1) * settings.get().volumeStep);
    }
    await i.update(buildSettingsCard(music.snapshot(), settings.get()));
    return;
  }

  if (!id.startsWith("mp:")) return;

  // Просмотр очереди, настройки и добавление доступны всем, остальное — только из канала бота.
  if (id === PLAYER_IDS.queue) {
    await i.reply({ ...buildQueueMessage(music.snapshot(), settings.get(), 1), flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }
  if (id === PLAYER_IDS.settings) {
    await i.reply({ ...buildSettingsCard(music.snapshot(), settings.get()), flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    return;
  }
  if (id === PLAYER_IDS.add) {
    await i.showModal(buildAddModal(ctx));
    return;
  }

  assertSameChannel(i, music);
  switch (id) {
    case PLAYER_IDS.toggle:
      await music.togglePause();
      break;
    case PLAYER_IDS.skip:
      await music.skip();
      break;
    case PLAYER_IDS.prev:
      await music.previous();
      break;
    case PLAYER_IDS.shuffle:
      await music.shuffle();
      break;
    case PLAYER_IDS.leave:
      if (settings.get().stay247) settings.update({ stay247: false });
      await music.leave();
      break;
    case PLAYER_IDS.options:
      if (i.isStringSelectMenu()) await runOption(i, ctx);
      break;
    case PLAYER_IDS.lyrics: {
      if (ctx.lyrics.active) {
        await ctx.lyrics.close();
        await i.deferUpdate();
        return;
      }
      if (!music.player?.queue.current) throw new MusicError("Сейчас ничего не играет.");
      if (!i.channel?.isSendable()) throw new MusicError("Не могу писать в этот канал.");
      await i.deferUpdate();
      await ctx.lyrics.open(i.channel);
      return;
    }
    default:
      return;
  }
  if (!i.replied && !i.deferred) await i.deferUpdate();
}

async function runModal(i: ModalSubmitInteraction, ctx: Ctx) {
  if (i.customId !== ADD_MODAL_ID) return;
  const voice = userVoiceChannel(i);
  if (!voice) throw new MusicError("Сначала зайди в голосовой канал.");
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const sourceValue = i.fields.getStringSelectValues("source")[0];
  const result = await ctx.music.play({
    query: i.fields.getTextInputValue("query"),
    source: isSearchSourceKey(sourceValue) ? sourceValue : undefined,
    voiceChannelId: voice,
    textChannelId: i.channelId,
    requester: toRequester(i.user),
    next: i.fields.getStringSelectValues("position")[0] === "next",
  });
  await i.editReply({ content: describePlay(result), allowedMentions: { parse: [] } });
}

/* ------------------------------ диспетчер ------------------------------ */

function describeCommand(i: ChatInputCommandInteraction): string {
  const opts = i.options.data.map((o) => `${o.name}=${String(o.value ?? "").slice(0, 120)}`).join(" ");
  return `/${i.commandName}${opts ? ` ${opts}` : ""}`;
}

export async function handleInteraction(i: Interaction, ctx: Ctx) {
  if (i.guildId !== ctx.config.DISCORD_GUILD_ID) return;
  if (i.isAutocomplete()) {
    await runAutocomplete(i, ctx).catch((e) => log.warn(`Автодополнение "${String(i.options.getFocused()).slice(0, 80)}":`, e));
    return;
  }
  if (i.isChatInputCommand()) {
    log.info(`${i.user.username}: ${describeCommand(i)}`);
    await runCommand(i, ctx).catch((e) => fail(i, e));
    return;
  }
  if (i.isButton() || i.isStringSelectMenu()) {
    log.debug(`${i.user.username}: ${i.customId}`);
    await runComponent(i, ctx).catch((e) => fail(i, e));
    return;
  }
  if (i.isModalSubmit()) {
    log.info(`${i.user.username}: окно ${i.customId}`);
    await runModal(i, ctx).catch((e) => fail(i, e));
  }
}
