import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
} from "discord.js";
import { escapeMd, formatDuration, tracksWord, truncate } from "../format.js";
import type { Playlist } from "../library/playlists.js";
import type { StoredTrack } from "../library/stored-track.js";
import type { Settings } from "../settings.js";
import { icon, type IconKey } from "./emoji.js";
import { hexToInt } from "./player-view.js";

/** customId экранов плейлистов. Динамические части добавляются через двоеточие. */
export const PL = {
  home: "pl:home",
  open: "pl:open",
  view: "pl:view:",
  create: "pl:new",
  saveQueue: "pl:savequeue",
  play: "pl:play:",
  shuffle: "pl:shuf:",
  addCurrent: "pl:addcur:",
  rename: "pl:ren:",
  del: "pl:del:",
  delConfirm: "pl:delok:",
  page: "pl:page:",
  remove: "pl:rm:",
  addTo: "pl:addto",
  createWith: "pl:newwith",
  modalCreate: "pl:m:new",
  modalSave: "pl:m:save",
  modalRename: "pl:m:ren:",
  modalCreateWith: "pl:m:newwith",
} as const;

const PAGE = 10;
const V2 = MessageFlags.IsComponentsV2 as const;

function btn(id: string, key: IconKey, label?: string, opts: { disabled?: boolean; style?: ButtonStyle } = {}) {
  const b = new ButtonBuilder().setCustomId(id).setEmoji(icon(key)).setStyle(opts.style ?? ButtonStyle.Secondary).setDisabled(opts.disabled ?? false);
  if (label) b.setLabel(label);
  return b;
}

function duration(tracks: StoredTrack[]) {
  return formatDuration(tracks.reduce((s, t) => s + (t.info.isStream ? 0 : t.info.duration), 0));
}

export function trackRow(t: StoredTrack, n: number, maxLen = 70) {
  const name = escapeMd(truncate(`${t.info.author} — ${t.info.title}`, maxLen));
  const dur = t.info.isStream ? "LIVE" : formatDuration(t.info.duration);
  return `\`${n}.\` ${t.info.uri ? `[${name}](${t.info.uri})` : name} \`${dur}\``;
}

function container(settings: Settings) {
  return new ContainerBuilder().setAccentColor(hexToInt(settings.accentColor));
}

const plIcon = (p: Playlist): IconKey => (p.liked ? "heart" : "playlist");

export function buildPlaylistsHome(playlists: Playlist[], settings: Settings, note?: string) {
  const c = container(settings);
  const lines = ["### Мои плейлисты"];
  if (note) lines.push(note);
  if (playlists.length === 0) {
    lines.push("Пока пусто. Создай плейлист, импортируй его по ссылке или отметь трек «Нравится» в меню плеера.");
  } else {
    lines.push(...playlists.slice(0, 20).map((p) => `${p.liked ? "❤️" : "📁"} **${escapeMd(p.name)}** · ${tracksWord(p.tracks.length)} · ${duration(p.tracks)}`));
  }
  lines.push("-# Плейлист можно включить и через `/play`: начни вводить его название.");
  c.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")));

  if (playlists.length > 0) {
    c.addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(PL.open)
          .setPlaceholder("Открыть плейлист…")
          .addOptions(
            playlists.slice(0, 25).map((p) => ({
              label: truncate(p.name, 100),
              value: p.id,
              description: `${tracksWord(p.tracks.length)} · ${duration(p.tracks)}`,
              emoji: icon(plIcon(p)),
            })),
          ),
      ),
    );
  }
  c.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      btn(PL.create, "add", "Создать или импортировать"),
      btn(PL.saveQueue, "queue", "Сохранить очередь"),
    ),
  );
  return { components: [c], flags: V2 };
}

export function buildPlaylistView(p: Playlist, settings: Settings, page: number, note?: string) {
  const pages = Math.max(1, Math.ceil(p.tracks.length / PAGE));
  const pg = Math.min(Math.max(page, 1), pages);
  const start = (pg - 1) * PAGE;
  const items = p.tracks.slice(start, start + PAGE);

  const c = container(settings);
  const meta = [tracksWord(p.tracks.length), duration(p.tracks), p.sourceUrl ? `[источник](${p.sourceUrl})` : null, pages > 1 ? `страница ${pg}/${pages}` : null]
    .filter(Boolean)
    .join(" · ");
  const lines = [`### ${p.liked ? "❤️" : "📁"} ${escapeMd(p.name)}`, `-# ${meta}`];
  if (note) lines.push(note);
  lines.push(items.length ? items.map((t, i) => trackRow(t, start + i + 1)).join("\n") : "В плейлисте пока нет треков.");
  c.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n").slice(0, 3900)));

  const empty = p.tracks.length === 0;
  c.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      btn(PL.play + p.id, "play", "Играть", { disabled: empty, style: ButtonStyle.Primary }),
      btn(PL.shuffle + p.id, "shuffle", "Вперемешку", { disabled: empty }),
      btn(PL.addCurrent + p.id, "add", "Текущий трек"),
      btn(PL.rename + p.id, "rename", undefined, { disabled: p.liked }),
      btn(PL.del + p.id, "trash", undefined, { disabled: p.liked }),
    ),
  );
  if (items.length > 0) {
    c.addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${PL.remove}${p.id}:${pg}`)
          .setPlaceholder("Убрать трек из плейлиста…")
          .addOptions(
            items.map((t, i) => ({
              label: truncate(`${start + i + 1}. ${t.info.title}`, 100),
              description: truncate(t.info.author, 100),
              value: String(start + i),
            })),
          ),
      ),
    );
  }
  c.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      btn(PL.home, "back", "Все плейлисты"),
      ...(pages > 1
        ? [btn(`${PL.page}${p.id}:${pg - 1}:prev`, "prev", undefined, { disabled: pg === 1 }), btn(`${PL.page}${p.id}:${pg + 1}:next`, "next", undefined, { disabled: pg === pages })]
        : []),
    ),
  );
  return { components: [c], flags: V2 };
}

export function buildDeleteConfirm(p: Playlist, settings: Settings) {
  const c = container(settings)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`### Удалить «${escapeMd(p.name)}»?\nВ нём ${tracksWord(p.tracks.length)}. Отменить удаление будет нельзя.`))
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        btn(PL.delConfirm + p.id, "trash", "Удалить", { style: ButtonStyle.Danger }),
        btn(PL.view + p.id, "back", "Отмена"),
      ),
    );
  return { components: [c], flags: V2 };
}

/** «Добавить в плейлист» для текущего трека. */
export function buildAddToPlaylist(playlists: Playlist[], track: StoredTrack, settings: Settings, note?: string) {
  const c = container(settings);
  const lines = ["### Добавить в плейлист", `**${escapeMd(truncate(`${track.info.author} — ${track.info.title}`, 120))}**`];
  if (note) lines.push(note);
  c.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")));
  if (playlists.length > 0) {
    c.addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(PL.addTo)
          .setPlaceholder("Выбери плейлист…")
          .addOptions(
            playlists.slice(0, 25).map((p) => ({ label: truncate(p.name, 100), value: p.id, description: tracksWord(p.tracks.length), emoji: icon(plIcon(p)) })),
          ),
      ),
    );
  }
  c.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(btn(PL.createWith, "add", "Новый плейлист с этим треком")));
  return { components: [c], flags: V2 };
}
