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
import { EFFECTS, type EffectKey } from "../music/service.js";
import { MusicError } from "../music/types.js";
import { isUrl } from "../sources.js";
import { BR, FX, buildBrowseHome, buildEffectsCard, buildRecentView, buildTopView } from "../ui/browse-view.js";
import { PL, buildAddToPlaylist, buildDeleteConfirm, buildPlaylistView, buildPlaylistsHome } from "../ui/library-view.js";
import { assertSameChannel, describePlay, toRequester, userVoiceChannel, type Ctx } from "./common.js";

type Component = ButtonInteraction | StringSelectMenuInteraction;
type Opener = ButtonInteraction | StringSelectMenuInteraction | ChatInputCommandInteraction;

const EPHEMERAL_V2 = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;

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
  const voice = userVoiceChannel(i);
  if (!voice) throw new MusicError("Сначала зайди в голосовой канал.");
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
    const voice = userVoiceChannel(i);
    if (!voice) throw new MusicError("Сначала зайди в голосовой канал.");
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
  if (id.startsWith(BR.radio)) {
    const scope = id.slice(BR.radio.length) === "me" ? "me" : "server";
    const picks = ctx.history.radio(scope === "me" ? userId : undefined, 20);
    if (picks.length === 0) throw new MusicError(scope === "me" ? "Для радио нужна история: послушай что-нибудь." : "История сервера пока пуста.");
    await i.deferUpdate();
    if (!ctx.settings.get().autoplay) ctx.music.setAutoplayEnabled(true);
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
