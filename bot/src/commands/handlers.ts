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
  type Interaction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { RepeatMode, Track } from "lavalink-client";
import { escapeMd, formatDuration, parseTime, tracksWord, truncate } from "../format.js";
import { createLogger } from "../logger.js";
import { MusicError } from "../music/types.js";
import { SEARCH_SOURCES, SEARCH_SOURCE_KEYS, isSearchSourceKey, isUrl, sourceInfo, type SearchSourceKey } from "../sources.js";
import { LYRICS_IDS } from "../ui/lyrics-view.js";
import { OPTION_VALUES, PLAYER_IDS, SETTINGS_IDS, buildSettingsCard } from "../ui/player-view.js";
import { QUEUE_JUMP_ID, QUEUE_PAGE_PREFIX, buildQueueMessage } from "../ui/queue-view.js";
import { fromStored, withRequester } from "../library/stored-track.js";
import type { WrappedPeriod } from "../wrapped/wrapped.js";
import type { QuizMode } from "../quiz/drop.js";
import { assertSameChannel, assertVoiceBot, describePlay, fail, say, toRequester, trackLink, userVoiceChannel, type Ctx } from "./common.js";

/** Команды, которые действуют на Артура из войса пользователя (остальные — общие для сервера). */
const VOICE_COMMANDS = new Set([
  "play", "pause", "skip", "previous", "stop", "leave", "queue", "nowplaying", "shuffle", "like",
  "loop", "volume", "seek", "remove", "move", "jump", "clear", "autoplay", "lyrics", "quiz",
]);
import { openAddTo, openBrowse, openEffects, openPlaylists, runLibraryComponent, runLibraryModal, toggleLike } from "./library-handlers.js";

const log = createLogger("commands");

/* ------------------------------- команды ------------------------------- */

async function runCommand(i: ChatInputCommandInteraction, ctx: Ctx) {
  const { music, settings } = ctx;
  if (VOICE_COMMANDS.has(i.commandName) && !(i.commandName === "quiz" && i.options.getSubcommand() === "top")) {
    const starting = i.commandName === "play" || (i.commandName === "quiz" && i.options.getSubcommand() === "start");
    assertVoiceBot(i, ctx, starting);
  }

  switch (i.commandName) {
    case "play": {
      const voice = userVoiceChannel(i);
      if (!voice) throw new MusicError("Сначала зайди в голосовой канал.");
      // Ответ видит только автор: кто что заказал, и так видно в шапке плеера.
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const raw = i.options.getString("запрос", true);
      const sourceOpt = i.options.getString("площадка");
      const source = isSearchSourceKey(sourceOpt) ? sourceOpt : undefined;
      if (raw.startsWith("pl:")) {
        const pl = ctx.playlists.own(raw.slice(3), i.user.id);
        const requester = toRequester(i.user);
        const result = await music.play({
          query: "",
          tracks: pl.tracks.map((t) => fromStored(t, music.lavalink, requester)),
          playlistName: pl.name,
          playlistUrl: pl.sourceUrl,
          voiceChannelId: voice,
          textChannelId: i.channelId,
          requester,
          next: i.options.getBoolean("следующим") ?? false,
        });
        await i.editReply({ content: describePlay(result), allowedMentions: { parse: [] } });
        return;
      }
      const cached = ctx.cache.getTrack(raw);
      const track = cached ? withRequester(cached, music.lavalink, toRequester(i.user)) : undefined;
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
      return say(i, music.stay247 ? "⏹ Остановлено, очередь очищена. Остаюсь в канале (24/7)." : "⏹ Остановлено, до встречи!");
    }
    case "leave": {
      assertSameChannel(i, music);
      // 24/7 бывает только у главного Артура — выход помощника его не трогает.
      const was247 = music.stay247;
      if (was247) settings.update({ stay247: false });
      await music.leave();
      return say(i, `👋 Вышел из канала${was247 ? ". Режим 24/7 выключен." : ""}`);
    }
    case "queue": {
      assertSameChannel(i, music);
      const page = i.options.getInteger("страница") ?? 1;
      await i.reply({ ...buildQueueMessage(music.snapshot(), settings.get(), page), flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return;
    }
    case "nowplaying": {
      assertSameChannel(i, music);
      if (!music.player?.queue.current) throw new MusicError("В твоём войсе сейчас ничего не играет.");
      ctx.playerMessage.bump();
      return say(i, "🎶 Мини-плеер внизу чата");
    }
    case "shuffle": {
      assertSameChannel(i, music);
      const on = await music.toggleShuffle();
      return say(i, on ? "🔀 Перемешивание включено: очередь перемешана, новые треки встанут в случайные места" : "➡️ Перемешивание выключено, порядок очереди восстановлен");
    }
    case "playlists":
      return openPlaylists(i, ctx);
    case "browse":
      return openBrowse(i, ctx);
    case "like":
      assertSameChannel(i, music);
      return toggleLike(i, ctx);
    case "quiz": {
      const sub = i.options.getSubcommand();
      if (sub === "start") {
        return ctx.quiz.start(i, i.options.getString("режим", true) as QuizMode, i.options.getInteger("раунды") ?? 10, i.options.getInteger("время") ?? 10);
      }
      if (sub === "stop") {
        await ctx.quiz.stop(i);
        return say(i, "⏹ Останавливаю игру — сейчас покажу итоги");
      }
      return ctx.quiz.top(i);
    }
    case "cleanup": {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      let deleted = 0;
      // Удалить чужое сообщение без особых прав нельзя, поэтому каждый Артур удаляет свои.
      // Только последние 300 сообщений канала; плееры и закреплённые не трогаем.
      for (const bot of ctx.bots) {
        const me = bot.client.user?.id;
        const channel = me ? await bot.client.channels.fetch(i.channelId).catch(() => null) : null;
        if (!channel || !("messages" in channel)) continue;
        let before: string | undefined;
        for (let page = 0; page < 3; page++) {
          const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
          if (!batch || batch.size === 0) break;
          for (const m of batch.values()) {
            if (m.author.id !== me || m.pinned || bot.playerMessage.isPlayerMessage(m.id)) continue;
            await m.delete().then(() => deleted++, () => undefined);
          }
          before = batch.lastKey();
        }
      }
      await i.editReply(deleted ? `🧹 Удалено моих сообщений: ${deleted}` : "🧹 Моих старых сообщений здесь нет");
      return;
    }
    case "wrapped": {
      await i.deferReply();
      const period = (i.options.getString("период") ?? "month") as WrappedPeriod;
      const message = await ctx.wrapped.build(period);
      if (!message) {
        await i.editReply({ content: "За этот период ещё ничего не слушали — итоги появятся, когда заиграет музыка." });
        return;
      }
      await i.editReply({ ...message, allowedMentions: { parse: [] } });
      return;
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
      assertSameChannel(i, music);
      const enabled = i.options.getBoolean("включить") ?? !music.autoplayEnabled;
      music.setAutoplayEnabled(enabled);
      return say(i, enabled ? "♾️ Автоплей включён: когда очередь кончится, добавлю похожие треки" : "♾️ Автоплей выключен");
    }
    case "lyrics":
      // Текст видит только тот, кто его открыл.
      assertSameChannel(i, music);
      return ctx.lyrics.open(i);
    case "247": {
      const enabled = i.options.getBoolean("включить") ?? !settings.get().stay247;
      if (enabled) {
        const voice = music.player?.voiceChannelId ?? userVoiceChannel(i);
        if (!voice) throw new MusicError("Зайди в голосовой канал, где бот должен дежурить, и повтори команду.");
        settings.update({ stay247: true, stay247ChannelId: voice });
        await music.ensurePlayer(voice, i.channelId);
        music.emit("update", "settings");
        return say(i, `🌙 Режим 24/7 включён: остаюсь в <#${voice}> и вернусь туда после перезапуска`);
      }
      settings.update({ stay247: false });
      music.emit("update", "settings");
      return say(i, "☀️ Режим 24/7 выключен");
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

  // Свои плейлисты по названию — как у Euphony: «/play название-плейлиста».
  const playlistChoices = isUrl(q)
    ? []
    : ctx.playlists
        .search(i.user.id, q)
        .slice(0, q.length < 2 ? 5 : 3)
        .map((p) => ({ name: truncate(`${p.liked ? "❤️" : "📁"} ${p.name} — ${tracksWord(p.tracks.length)}`, 100), value: `pl:${p.id}` }));

  if (q.length < 2) {
    // Пустое поле: свои плейлисты и недавние треки.
    const recent = ctx.history.recent(i.user.id, 10);
    const choices = recent.map((t) => ({
      name: truncate(`🕘 ${t.info.author} — ${t.info.title}`, 100),
      value: ctx.cache.putTrack(fromStored(t, ctx.music.lavalink, toRequester(i.user))),
    }));
    return i.respond([...playlistChoices, ...choices].slice(0, 25));
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
    await i.respond([...playlistChoices, ...(choices.length ? choices : fallback)].slice(0, 25));
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

/** Пункты меню, которые не меняют воспроизведение: доступны всем, ответ — отдельным сообщением. */
async function runPersonalOption(i: StringSelectMenuInteraction, ctx: Ctx): Promise<boolean> {
  const value = i.values[0];
  if (value === OPTION_VALUES.like) await toggleLike(i, ctx);
  else if (value === OPTION_VALUES.addTo) await openAddTo(i, ctx);
  else if (value === OPTION_VALUES.effects) await openEffects(i, ctx);
  else if (value === OPTION_VALUES.add) await i.showModal(buildAddModal(ctx));
  else if (value === OPTION_VALUES.lyrics) await ctx.lyrics.open(i);
  else return false;
  ctx.playerMessage.refresh();
  return true;
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
      music.setAutoplayEnabled(!music.autoplayEnabled);
      break;
    case OPTION_VALUES.volDown:
      await music.changeVolume(-settings.get().volumeStep);
      break;
    case OPTION_VALUES.volUp:
      await music.changeVolume(settings.get().volumeStep);
      break;
    case OPTION_VALUES.stay247: {
      if (ctx.instanceIndex !== 0) throw new MusicError("Режим 24/7 есть только у главного Артура.");
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

  if (id.startsWith("qz:") && i.isButton()) return ctx.quiz.handleButton(i);

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
    ctx.lyrics.close(i.user.id);
    await i.deferUpdate();
    // Личное сообщение с текстом удаляем; старые общие сообщения (до обновления) — тоже.
    if (i.message.flags.has(MessageFlags.Ephemeral)) await i.deleteReply().catch(() => undefined);
    else await i.message.delete().catch(() => undefined);
    return;
  }
  if (id === LYRICS_IDS.full) {
    const lyr = ctx.lyrics.lyricsFor(i.user.id);
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

  if (await runLibraryComponent(i, ctx)) return;
  if (!id.startsWith("mp:")) return;

  // Просмотр очереди, плейлисты, обзор и настройки доступны всем, остальное — только из канала бота.
  if (id === PLAYER_IDS.playlists) return openPlaylists(i, ctx);
  if (id === PLAYER_IDS.browse) return openBrowse(i, ctx);
  if (id === PLAYER_IDS.lyrics) return ctx.lyrics.open(i);
  if (id === PLAYER_IDS.options && i.isStringSelectMenu() && (await runPersonalOption(i, ctx))) return;
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
      await music.toggleShuffle();
      break;
    case PLAYER_IDS.leave:
      if (music.stay247) settings.update({ stay247: false });
      await music.leave();
      break;
    case PLAYER_IDS.options:
      if (i.isStringSelectMenu()) await runOption(i, ctx);
      break;
    default:
      return;
  }
  if (!i.replied && !i.deferred) await i.deferUpdate();
}

async function runModal(i: ModalSubmitInteraction, ctx: Ctx) {
  if (await runLibraryModal(i, ctx)) return;
  if (i.customId !== ADD_MODAL_ID) return;
  assertVoiceBot(i, ctx, true);
  const voice = userVoiceChannel(i)!;
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
