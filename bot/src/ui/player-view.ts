import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
} from "discord.js";
import type { Settings } from "../settings.js";
import { escapeMd, formatDuration, truncate } from "../format.js";
import type { PlayerSnapshot, TrackView } from "../music/types.js";
import { SEARCH_SOURCES, isSearchSourceKey, sourceInfo } from "../sources.js";
import { icon, type IconKey } from "./emoji.js";

export const PLAYER_IDS = {
  shuffle: "mp:shuffle",
  prev: "mp:prev",
  toggle: "mp:toggle",
  skip: "mp:skip",
  queue: "mp:queue",
  options: "mp:opts",
  add: "mp:add",
  playlists: "mp:playlists",
  lyrics: "mp:lyrics",
  browse: "mp:browse",
  settings: "mp:settings",
  leave: "mp:leave",
} as const;

/** Значения пунктов меню «Параметры плеера». */
export const OPTION_VALUES = {
  like: "like",
  addTo: "addto",
  add: "add",
  lyrics: "lyrics",
  effects: "effects",
  loopQueue: "loopq",
  loopTrack: "loopt",
  autoplay: "autoplay",
  volDown: "voldown",
  volUp: "volup",
  stay247: "247",
  clear: "clear",
  stop: "stop",
} as const;

export function hexToInt(hex: string): number {
  return Number.parseInt(hex.replace("#", ""), 16);
}

export function trackLine(t: TrackView, maxLen = 70): string {
  const name = truncate(`${t.author} — ${t.title}`, maxLen);
  const dur = t.isStream ? "LIVE" : formatDuration(t.duration);
  return t.uri ? `[${escapeMd(name)}](${t.uri}) \`${dur}\`` : `${escapeMd(name)} \`${dur}\``;
}

/** Подпись «кто заказал»: служебные заказчики (автоплей, панель) не являются пользователями Discord. */
export function requesterLabel(r: TrackView["requester"]): string | null {
  if (!r) return null;
  if (r.id === "autoplay") return "автоплей";
  if (r.id === "panel") return "веб-панель";
  return `<@${r.id}>`;
}

function iconButton(id: string, key: IconKey, opts: { label?: string; disabled?: boolean; active?: boolean } = {}) {
  const b = new ButtonBuilder()
    .setCustomId(id)
    .setEmoji(icon(key))
    .setStyle(opts.active ? ButtonStyle.Primary : ButtonStyle.Secondary)
    .setDisabled(opts.disabled ?? false);
  if (opts.label) b.setLabel(opts.label);
  return b;
}

const onOff = (v: boolean) => (v ? "Сейчас: включено" : "Сейчас: выключено");

function optionsMenu(snap: PlayerSnapshot, settings: Settings) {
  return new StringSelectMenuBuilder()
    .setCustomId(PLAYER_IDS.options)
    .setPlaceholder("Параметры плеера")
    .addOptions(
      { label: "Нравится", value: OPTION_VALUES.like, description: "Добавить в «Любимые» или убрать оттуда", emoji: icon("heart") },
      { label: "Добавить в плейлист", value: OPTION_VALUES.addTo, description: "Сохранить текущий трек в свой плейлист", emoji: icon("playlist") },
      { label: "Добавить трек", value: OPTION_VALUES.add, description: "Найти и поставить в очередь", emoji: icon("search") },
      {
        label: "Эффекты",
        value: OPTION_VALUES.effects,
        description: snap.effects.length ? `Включено: ${snap.effects.length}` : "Басы, nightcore, 8D и другие",
        emoji: icon("effects"),
      },
      { label: "Повтор очереди", value: OPTION_VALUES.loopQueue, description: onOff(snap.repeatMode === "queue"), emoji: icon("repeat") },
      { label: "Повтор трека", value: OPTION_VALUES.loopTrack, description: onOff(snap.repeatMode === "track"), emoji: icon("repeat1") },
      { label: "Автоплей", value: OPTION_VALUES.autoplay, description: `Похожие треки после очереди. ${onOff(snap.autoplay)}`, emoji: icon("autoplay") },
      { label: `Тише (−${settings.volumeStep}%)`, value: OPTION_VALUES.volDown, description: `Громкость сейчас ${snap.volume}%`, emoji: icon("voldown") },
      { label: `Громче (+${settings.volumeStep}%)`, value: OPTION_VALUES.volUp, description: `Громкость сейчас ${snap.volume}%`, emoji: icon("volup") },
      ...(snap.canStay247 ? [{ label: "Режим 24/7", value: OPTION_VALUES.stay247, description: `Не выходить из канала. ${onOff(snap.stay247)}`, emoji: icon("moon") }] : []),
      { label: "Очистить очередь", value: OPTION_VALUES.clear, description: `В очереди: ${snap.queue.length}`, emoji: icon("clear") },
      { label: "Остановить", value: OPTION_VALUES.stop, description: snap.stay247 ? "Очистить очередь, остаться в канале" : "Очистить очередь и выйти", emoji: icon("stop") },
    );
}

function bottomRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    iconButton(PLAYER_IDS.playlists, "playlist", { label: "Плейлисты" }),
    iconButton(PLAYER_IDS.browse, "browse", { label: "Обзор" }),
    iconButton(PLAYER_IDS.lyrics, "lyrics", { label: "Текст" }),
    iconButton(PLAYER_IDS.settings, "settings"),
  );
}

/** Мини-плеер (Components V2) в стиле: шапка, обложка, название, кнопки, меню параметров. */
export function buildPlayerMessage(snap: PlayerSnapshot, settings: Settings) {
  const container = new ContainerBuilder().setAccentColor(hexToInt(settings.accentColor));
  const cur = snap.current;

  if (!cur) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          snap.voiceChannelId ? `-# 🔊 <#${snap.voiceChannelId}>` : "",
          "### Очередь пуста",
          snap.autoplay ? "Автоплей включён, но похожих треков не нашлось." : "Добавь трек кнопкой ниже или командой `/play`.",
          snap.stay247 ? "-# Режим 24/7: бот останется в канале." : `-# Бот выйдет из канала через ${settings.leaveOnQueueEndSec} с, если ничего не добавить.`,
        ].join("\n"),
      ),
    );
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        iconButton(PLAYER_IDS.add, "search", { label: "Добавить трек" }),
        iconButton(PLAYER_IDS.playlists, "playlist", { label: "Плейлисты" }),
        iconButton(PLAYER_IDS.browse, "browse", { label: "Обзор" }),
        iconButton(PLAYER_IDS.leave, "stop", { label: snap.stay247 ? "Выйти (выключит 24/7)" : "Выйти" }),
      ),
    );
    return { components: [container], flags: MessageFlags.IsComponentsV2 as const };
  }

  // Шапка: номер трека · кто заказал · откуда
  const src = sourceInfo(cur.sourceName);
  const from = cur.playlistName
    ? `Плейлист: ${cur.playlistUrl ? `[${escapeMd(truncate(cur.playlistName, 60))}](${cur.playlistUrl})` : escapeMd(truncate(cur.playlistName, 60))}`
    : cur.uri
      ? `[${src.label}](${cur.uri})`
      : src.label;
  const where = snap.voiceChannelId ? `🔊 <#${snap.voiceChannelId}>` : null;
  const head = [where, `\`${String(snap.trackNumber || 1).padStart(2, "0")}\``, requesterLabel(cur.requester), from].filter(Boolean).join(" · ");
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${head}`));

  if (cur.artworkUrl) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(cur.artworkUrl).setDescription(truncate(cur.title, 100))),
    );
  }

  const state = [
    cur.isStream ? "🔴 LIVE" : formatDuration(cur.duration),
    snap.paused ? "на паузе" : null,
    snap.repeatMode === "track" ? "повтор трека" : snap.repeatMode === "queue" ? "повтор очереди" : null,
    snap.shuffle ? "перемешивание" : null,
    snap.effects.length ? `эффекты: ${snap.effects.length}` : null,
    snap.stay247 ? "24/7" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`### ${escapeMd(truncate(cur.title, 150))}\n${escapeMd(truncate(cur.author, 150))}\n-# ${state}`),
  );

  if (settings.showUpNext && snap.queue.length > 0) {
    const next = snap.queue.slice(0, 3).map((t, i) => `-# \`${i + 1}.\` ${trackLine(t, 60)}`);
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(next.join("\n")));
  }

  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      iconButton(PLAYER_IDS.shuffle, "shuffle", { active: snap.shuffle }),
      iconButton(PLAYER_IDS.prev, "prev", { disabled: snap.previousCount === 0 }),
      iconButton(PLAYER_IDS.toggle, snap.paused ? "play" : "pause"),
      iconButton(PLAYER_IDS.skip, "next"),
      iconButton(PLAYER_IDS.queue, "queue"),
    ),
  );
  container.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(optionsMenu(snap, settings)));
  container.addActionRowComponents(bottomRow());

  return { components: [container], flags: MessageFlags.IsComponentsV2 as const };
}

export const SETTINGS_IDS = { volDown: "st:voldown", volUp: "st:volup", refresh: "st:refresh" } as const;

/** Карточка ⚙ (видна только нажавшему): состояние плеера и быстрая громкость. */
export function buildSettingsCard(snap: PlayerSnapshot, settings: Settings) {
  const repeat = snap.repeatMode === "queue" ? "очередь" : snap.repeatMode === "track" ? "трек" : "выключен";
  const lines = [
    "### Параметры",
    `Громкость: **${snap.volume}%** (максимум ${settings.maxVolume}%)`,
    `Повтор: **${repeat}**`,
    `Автоплей: **${snap.autoplay ? "включён" : "выключен"}**`,
    snap.canStay247 ? `Режим 24/7: **${snap.stay247 ? "включён" : "выключен"}**` : "Режим 24/7: только у главного Артура",
    `Поиск по умолчанию: **${isSearchSourceKey(settings.defaultSource) ? SEARCH_SOURCES[settings.defaultSource].label : settings.defaultSource}**`,
    "",
    "-# Остальное (каналы, лимиты, цвет плеера, мониторинг) — в веб-панели, команда `/panel` подскажет, как её открыть.",
  ];
  const container = new ContainerBuilder()
    .setAccentColor(hexToInt(settings.accentColor))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")))
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        iconButton(SETTINGS_IDS.volDown, "voldown", { label: `−${settings.volumeStep}%`, disabled: !snap.active || snap.volume <= 0 }),
        iconButton(SETTINGS_IDS.volUp, "volup", { label: `+${settings.volumeStep}%`, disabled: !snap.active || snap.volume >= settings.maxVolume }),
        iconButton(SETTINGS_IDS.refresh, "repeat", { label: "Обновить" }),
      ),
    );
  return { components: [container], flags: MessageFlags.IsComponentsV2 as const };
}
