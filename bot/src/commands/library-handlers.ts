import {
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { escapeMd, tracksWord, truncate } from "../format.js";
import { CHARTS } from "../library/charts.js";
import { fromStored, toStored, type StoredTrack } from "../library/stored-track.js";
import type { Track } from "lavalink-client";
import { looseKey } from "../library/history.js";
import { createLogger } from "../logger.js";
import { similarTracks } from "../music/autoplay.js";
import { EFFECTS, type EffectKey } from "../music/service.js";
import { AUTOPLAY_REQUESTER, MusicError } from "../music/types.js";
import { isUrl } from "../sources.js";
import { BR, FX, buildBrowseHome, buildEffectsCard, buildRecentView, buildRepeatView, buildTopView } from "../ui/browse-view.js";
import { PL, buildAddToPlaylist, buildDeleteConfirm, buildPlaylistView, buildPlaylistsHome } from "../ui/library-view.js";
import { assertSameChannel, assertVoiceBot, describePlay, toRequester, userVoiceChannel, type Ctx } from "./common.js";

type Component = ButtonInteraction | StringSelectMenuInteraction;
type Opener = ButtonInteraction | StringSelectMenuInteraction | ChatInputCommandInteraction;

const EPHEMERAL_V2 = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;
const log = createLogger("library");

/* ------------------------------ общие ------------------------------ */

function currentStored(ctx: Ctx): StoredTrack {
  const cur = ctx.music.player?.queue.current;
  const stored = cur ? toStored(cur) : null;
  if (!stored) throw new MusicError("Сейчас ничего не играет.");
  return stored;
}

/** Поставить сохранённые треки в очередь от имени пользователя. Ответ — отдельным эфемерным сообщением. */
async function playStored(
  i: Component | ModalSubmitInteraction,
  ctx: Ctx,
  stored: StoredTrack[],
  opts: { name?: string | null; url?: string | null; shuffle?: boolean } = {},
) {
  assertVoiceBot(i, ctx, true);
  const voice = userVoiceChannel(i)!;
  const requester = toRequester(i.user);
  const tracks = stored.map((s) => fromStored(s, ctx.music.lavalink, requester));
  const result = await ctx.music.play({
    query: "",
    tracks,
    playlistName: opts.name ?? null,
    playlistUrl: opts.url ?? null,
    shuffle: opts.shuffle,
    voiceChannelId: voice,
    textChannelId: i.channelId,
    requester,
  });
  return describePlay(result);
}

async function followUp(i: Component | ModalSubmitInteraction, content: string) {
  await i.followUp({ content, flags: MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds, allowedMentions: { parse: [] } });
}

/* ------------------------------ микс войса ------------------------------ */

const BLEND_NAME = "Микс войса";
const BLEND_SIZE = 24;
/** Сколько новых треков (которых на сервере ещё не слышали) подмешать в микс. */
const BLEND_FRESH = 6;

/**
 * «Микс войса»: любимое каждого, кто сейчас в войсе, по очереди, и немного новых похожих треков.
 * Микс начинает играть сразу, а новые треки ищутся в фоне и встают между знакомыми.
 */
async function playBlend(i: Component, ctx: Ctx) {
  assertVoiceBot(i, ctx, true);
  const voice = userVoiceChannel(i)!;
  const channel = i.guild?.channels.cache.get(voice);
  const people = channel?.isVoiceBased() ? [...channel.members.filter((m) => !m.user.bot).values()] : [];
  const ids = people.length ? people.map((m) => m.id) : [i.user.id];
  const blend = ctx.history.blend(ids, BLEND_SIZE);
  if (blend.tracks.length === 0) throw new MusicError("У тех, кто в войсе, пока нет истории: включите что-нибудь, и микс соберётся.");

  await i.deferUpdate();
  const requester = toRequester(i.user);
  const result = await ctx.music.play({
    query: "",
    tracks: blend.tracks.map((s) => fromStored(s, ctx.music.lavalink, requester)),
    playlistName: BLEND_NAME,
    shuffle: false,
    voiceChannelId: voice,
    textChannelId: i.channelId,
    requester,
  });
  const names = blend.members.map((id) => escapeMd(people.find((m) => m.id === id)?.displayName ?? "?"));
  await followUp(i, `${describePlay(result)}\n-# Любимое: ${names.join(", ")}. Сейчас подмешаю новые похожие треки, которых здесь ещё не слышали.`);

  void addFreshTracks(ctx, blend.tracks, new Set(result.added)).catch((e) => log.warn("Микс войса: новые треки не добавились:", e));
}

async function addFreshTracks(ctx: Ctx, seeds: StoredTrack[], blendTracks: Set<Track>) {
  const player = ctx.music.player;
  if (!player) return;
  const heard = ctx.history.heardKeys();
  const fresh: Track[] = [];
  // Семена — первые треки микса (по одному любимому от каждого), похожие ищем через рекомендации площадки.
  for (const seed of seeds.slice(0, 4)) {
    if (fresh.length >= BLEND_FRESH || !seed.encoded) continue;
    const similar = await similarTracks(player, fromStored(seed, ctx.music.lavalink, AUTOPLAY_REQUESTER)).catch(() => [] as Track[]);
    let fromSeed = 0;
    for (const t of similar) {
      if (t.info.isStream || (t.info.duration ?? 0) > 10 * 60_000 || (t.info.duration ?? 0) < 60_000) continue;
      const key = looseKey(t.info.author, t.info.title);
      if (heard.has(key)) continue;
      heard.add(key);
      t.userData = { ...(t.userData ?? {}), playlistName: BLEND_NAME, playlistUrl: null };
      fresh.push(t);
      if (++fromSeed >= 2 || fresh.length >= BLEND_FRESH) break;
    }
  }
  if (fresh.length === 0 || ctx.music.player !== player) return;

  // Встаём между треками микса, не раньше третьего: начало — знакомое.
  for (const t of fresh) {
    const positions = player.queue.tracks.map((q, idx) => (blendTracks.has(q as Track) ? idx : -1)).filter((idx) => idx >= 2);
    if (positions.length === 0) break;
    const at = positions[Math.floor(Math.random() * positions.length)]! + 1;
    await player.queue.add(t, at);
  }
  log.info(`Микс войса: подмешал ${fresh.length} новых треков`);
  ctx.music.emit("update", "queue");
}

/* ------------------------------ открытие экранов ------------------------------ */

export async function openPlaylists(i: Opener, ctx: Ctx, note?: string) {
  await i.reply({ ...buildPlaylistsHome(ctx.playlists.list(i.user.id), ctx.settings.get(), note), flags: EPHEMERAL_V2 });
}

export async function openBrowse(i: Opener, ctx: Ctx) {
  await i.reply({ ...buildBrowseHome(ctx.settings.get(), ctx.history.size), flags: EPHEMERAL_V2 });
}

export async function openEffects(i: Opener, ctx: Ctx) {
  if (!ctx.music.player?.queue.current) throw new MusicError("Эффекты включаются, когда что-то играет.");
  await i.reply({ ...buildEffectsCard(ctx.music.effectsState(), ctx.settings.get()), flags: EPHEMERAL_V2 });
}

export async function openAddTo(i: Opener, ctx: Ctx) {
  const track = currentStored(ctx);
  ctx.playlists.liked(i.user.id); // чтобы «Любимые» всегда были в списке
  await i.reply({ ...buildAddToPlaylist(ctx.playlists.list(i.user.id), track, ctx.settings.get()), flags: EPHEMERAL_V2 });
}

export async function toggleLike(i: Opener, ctx: Ctx) {
  const track = currentStored(ctx);
  const liked = ctx.playlists.toggleLike(i.user.id, track);
  const name = escapeMd(truncate(`${track.info.author} — ${track.info.title}`, 90));
  await i.reply({
    content: liked ? `❤️ **${name}** добавлен в «Любимые»` : `💔 **${name}** убран из «Любимых»`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

/* ------------------------------ модальные окна ------------------------------ */

function nameInput(value?: string) {
  const input = new TextInputBuilder().setCustomId("name").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(60).setPlaceholder("Например: Вечерний чилл");
  if (value) input.setValue(value);
  return new LabelBuilder().setLabel("Название").setTextInputComponent(input);
}

function createModal() {
  return new ModalBuilder()
    .setCustomId(PL.modalCreate)
    .setTitle("Новый плейлист")
    .addLabelComponents(
      nameInput(),
      new LabelBuilder()
        .setLabel("Импорт по ссылке (необязательно)")
        .setDescription("Плейлист или альбом Spotify, YouTube, SoundCloud, Apple Music")
        .setTextInputComponent(new TextInputBuilder().setCustomId("url").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(500)),
    );
}

const simpleNameModal = (id: string, title: string, value?: string) => new ModalBuilder().setCustomId(id).setTitle(title).addLabelComponents(nameInput(value));

export async function runLibraryModal(i: ModalSubmitInteraction, ctx: Ctx): Promise<boolean> {
  const id = i.customId;
  const userId = i.user.id;
  const settings = ctx.settings.get();

  if (id === PL.modalCreate) {
    const name = i.fields.getTextInputValue("name");
    const url = i.fields.getTextInputValue("url").trim();
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    let tracks: StoredTrack[] = [];
    if (url) {
      if (!isUrl(url)) throw new MusicError("Ссылка должна начинаться с http:// или https://");
      const res = await ctx.music.search(url, undefined, toRequester(i.user));
      tracks = res.tracks.map(toStored).filter((t): t is StoredTrack => t !== null);
    }
    const p = ctx.playlists.create(userId, name, tracks, url || null);
    await i.editReply({ ...buildPlaylistView(p, settings, 1, url ? `✅ Импортировано: ${tracksWord(p.tracks.length)}` : "✅ Плейлист создан") });
    return true;
  }
  if (id === PL.modalSave) {
    const player = ctx.music.player;
    const items = [player?.queue.current, ...(player?.queue.tracks ?? [])].filter(Boolean);
    const stored = items.map((t) => toStored(t as never)).filter((t): t is StoredTrack => t !== null);
    if (stored.length === 0) throw new MusicError("Очередь пуста — сохранять нечего.");
    const p = ctx.playlists.create(userId, i.fields.getTextInputValue("name"), stored);
    await i.reply({ ...buildPlaylistView(p, settings, 1, `✅ Очередь сохранена: ${tracksWord(p.tracks.length)}`), flags: EPHEMERAL_V2 });
    return true;
  }
  if (id === PL.modalCreateWith) {
    const p = ctx.playlists.create(userId, i.fields.getTextInputValue("name"), [currentStored(ctx)]);
    await i.reply({ ...buildPlaylistView(p, settings, 1, "✅ Плейлист создан, трек добавлен"), flags: EPHEMERAL_V2 });
    return true;
  }
  if (id.startsWith(PL.modalRename)) {
    const p = ctx.playlists.rename(id.slice(PL.modalRename.length), userId, i.fields.getTextInputValue("name"));
    await i.reply({ ...buildPlaylistView(p, settings, 1, "✅ Переименовано"), flags: EPHEMERAL_V2 });
    return true;
  }
  return false;
}

/* ------------------------------ кнопки и меню ------------------------------ */

/** Обработать взаимодействие экранов плейлистов, обзора и эффектов. false — не наше. */
export async function runLibraryComponent(i: Component, ctx: Ctx): Promise<boolean> {
  const id = i.customId;
  const userId = i.user.id;
  const settings = ctx.settings.get();
  const select = i.isStringSelectMenu() ? i.values[0]! : "";

  /* --- плейлисты --- */
  if (id === PL.home) {
    await i.update(buildPlaylistsHome(ctx.playlists.list(userId), settings));
    return true;
  }
  if (id === PL.open) {
    await i.update(buildPlaylistView(ctx.playlists.own(select, userId), settings, 1));
    return true;
  }
  if (id.startsWith(PL.view)) {
    await i.update(buildPlaylistView(ctx.playlists.own(id.slice(PL.view.length), userId), settings, 1));
    return true;
  }
  if (id.startsWith(PL.page)) {
    const [plId, page] = id.slice(PL.page.length).split(":");
    await i.update(buildPlaylistView(ctx.playlists.own(plId!, userId), settings, Number(page) || 1));
    return true;
  }
  if (id === PL.create) {
    await i.showModal(createModal());
    return true;
  }
  if (id === PL.saveQueue) {
    await i.showModal(simpleNameModal(PL.modalSave, "Сохранить очередь как плейлист"));
    return true;
  }
  if (id === PL.createWith) {
    await i.showModal(simpleNameModal(PL.modalCreateWith, "Новый плейлист с текущим треком"));
    return true;
  }
  if (id.startsWith(PL.rename)) {
    const p = ctx.playlists.own(id.slice(PL.rename.length), userId);
    await i.showModal(simpleNameModal(PL.modalRename + p.id, "Переименовать плейлист", p.name));
    return true;
  }
  if (id.startsWith(PL.delConfirm)) {
    const p = ctx.playlists.delete(id.slice(PL.delConfirm.length), userId);
    await i.update(buildPlaylistsHome(ctx.playlists.list(userId), settings, `🗑 Плейлист «${escapeMd(p.name)}» удалён`));
    return true;
  }
  if (id.startsWith(PL.del)) {
    await i.update(buildDeleteConfirm(ctx.playlists.own(id.slice(PL.del.length), userId), settings));
    return true;
  }
  if (id.startsWith(PL.addCurrent)) {
    const p = ctx.playlists.own(id.slice(PL.addCurrent.length), userId);
    const added = ctx.playlists.add(p.id, userId, [currentStored(ctx)]);
    await i.update(buildPlaylistView(p, settings, Math.ceil(p.tracks.length / 10), added ? "✅ Текущий трек добавлен" : "Этот трек уже есть в плейлисте"));
    return true;
  }
  if (id.startsWith(PL.remove)) {
    const [plId, page] = id.slice(PL.remove.length).split(":");
    const removed = ctx.playlists.removeAt(plId!, userId, Number(select));
    const p = ctx.playlists.own(plId!, userId);
    await i.update(buildPlaylistView(p, settings, Number(page) || 1, `🗑 Убран: ${escapeMd(truncate(removed.info.title, 80))}`));
    return true;
  }
  if (id.startsWith(PL.play) || id.startsWith(PL.shuffle)) {
    const shuffle = id.startsWith(PL.shuffle);
    const p = ctx.playlists.own(id.slice((shuffle ? PL.shuffle : PL.play).length), userId);
    if (p.tracks.length === 0) throw new MusicError("Плейлист пуст.");
    await i.deferUpdate();
    await followUp(i, await playStored(i, ctx, p.tracks, { name: p.name, url: p.sourceUrl, shuffle }));
    return true;
  }
  if (id === PL.addTo) {
    const track = currentStored(ctx);
    const p = ctx.playlists.own(select, userId);
    const added = ctx.playlists.add(p.id, userId, [track]);
    await i.update(buildAddToPlaylist(ctx.playlists.list(userId), track, settings, added ? `✅ Добавлено в «${escapeMd(p.name)}»` : `Уже есть в «${escapeMd(p.name)}»`));
    return true;
  }

  /* --- обзор --- */
  if (id === BR.home) {
    await i.update(buildBrowseHome(settings, ctx.history.size));
    return true;
  }
  if (id === BR.chart) {
    const chart = CHARTS[Number(select)];
    if (!chart) return true;
    assertVoiceBot(i, ctx, true);
    const voice = userVoiceChannel(i)!;
    await i.deferUpdate();
    const result = await ctx.music.play({ query: chart.url, voiceChannelId: voice, textChannelId: i.channelId, requester: toRequester(i.user) });
    await followUp(i, describePlay(result));
    return true;
  }
  if (id.startsWith(BR.top)) {
    const scope = id.slice(BR.top.length) === "me" ? "me" : "server";
    await i.update(buildTopView(scope, ctx.history.top({ userId: scope === "me" ? userId : undefined, limit: 15 }), settings));
    return true;
  }
  if (id.startsWith(BR.playTop)) {
    const scope = id.slice(BR.playTop.length) === "me" ? "me" : "server";
    const top = ctx.history.top({ userId: scope === "me" ? userId : undefined, limit: 25 });
    if (top.length === 0) throw new MusicError("Топ пока пуст.");
    await i.deferUpdate();
    await followUp(i, await playStored(i, ctx, top.map((e) => e.track), { name: scope === "me" ? "Мой топ" : "Топ сервера" }));
    return true;
  }
  if (id === BR.wrapped) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const message = await ctx.wrapped.build("month");
    if (!message) await i.editReply({ content: "В этом месяце ещё ничего не слушали." });
    else await i.editReply({ ...message, allowedMentions: { parse: [] } });
    return true;
  }
  if (id === BR.recent) {
    await i.update(buildRecentView(ctx.history.recent(userId, 25), settings));
    return true;
  }
  if (id === BR.playRecent) {
    const track = ctx.history.recent(userId, 25)[Number(select)];
    if (!track) throw new MusicError("Трек не найден, открой «Недавние» заново.");
    await i.deferUpdate();
    await followUp(i, await playStored(i, ctx, [track]));
    return true;
  }
  if (id === BR.repeat) {
    await i.update(buildRepeatView(ctx.history.onRepeat(userId), settings));
    return true;
  }
  if (id.startsWith(BR.playRepeat)) {
    const entries = ctx.history.onRepeat(userId);
    if (entries.length === 0) throw new MusicError("«На повторе» пока пусто.");
    await i.deferUpdate();
    const shuffle = id.slice(BR.playRepeat.length) === "shuffle";
    await followUp(i, await playStored(i, ctx, entries.map((e) => e.track), { name: "На повторе", shuffle }));
    return true;
  }
  if (id === BR.blend) {
    await playBlend(i, ctx);
    return true;
  }
  if (id.startsWith(BR.radio)) {
    const scope = id.slice(BR.radio.length) === "me" ? "me" : "server";
    const picks = ctx.history.radio(scope === "me" ? userId : undefined, 20);
    if (picks.length === 0) throw new MusicError(scope === "me" ? "Для радио нужна история: послушай что-нибудь." : "История сервера пока пуста.");
    await i.deferUpdate();
    if (!ctx.music.autoplayEnabled) ctx.music.setAutoplayEnabled(true);
    const text = await playStored(i, ctx, picks, { name: scope === "me" ? "Моё радио" : "Радио сервера" });
    await followUp(i, `${text}\n-# Когда подборка закончится, автоплей продолжит похожими треками.`);
    return true;
  }

  /* --- эффекты --- */
  if (id === FX.set) {
    assertSameChannel(i, ctx.music);
    const key = select as EffectKey | "off";
    const on = await ctx.music.toggleEffect(key);
    const note = key === "off" ? "Все эффекты выключены" : `${EFFECTS[key]}: ${on ? "включён" : "выключен"}`;
    await i.update(buildEffectsCard(ctx.music.effectsState(), settings, note));
    return true;
  }

  return false;
}
