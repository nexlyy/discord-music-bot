import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from "discord.js";
import type { Settings } from "../settings.js";
import { escapeMd, formatDuration, progressBar, tracksWord, truncate } from "../format.js";
import type { PlayerSnapshot, TrackView } from "../music/types.js";
import { sourceInfo } from "../sources.js";

export const PLAYER_IDS = {
  prev: "mp:prev",
  toggle: "mp:toggle",
  skip: "mp:skip",
  shuffle: "mp:shuffle",
  stop: "mp:stop",
  loopQueue: "mp:loopq",
  loopTrack: "mp:loopt",
  autoplay: "mp:autoplay",
  volDown: "mp:voldown",
  volUp: "mp:volup",
  queue: "mp:queue",
  lyrics: "mp:lyrics",
  jump: "mp:jump",
} as const;

export function hexToInt(hex: string): number {
  return Number.parseInt(hex.replace("#", ""), 16);
}

export function trackLine(t: TrackView, maxLen = 70): string {
  const name = truncate(`${t.author} — ${t.title}`, maxLen);
  const dur = t.isStream ? "LIVE" : formatDuration(t.duration);
  return t.uri ? `[${escapeMd(name)}](${t.uri}) \`${dur}\`` : `${escapeMd(name)} \`${dur}\``;
}

function repeatLabel(mode: string): string | null {
  if (mode === "queue") return "🔁 Повтор очереди";
  if (mode === "track") return "🔂 Повтор трека";
  return null;
}

function btn(id: string, emoji: string, style = ButtonStyle.Secondary, disabled = false, label?: string) {
  const b = new ButtonBuilder().setCustomId(id).setEmoji(emoji).setStyle(style).setDisabled(disabled);
  if (label) b.setLabel(label);
  return b;
}

/** Мини-плеер (Components V2). */
export function buildPlayerMessage(snap: PlayerSnapshot, settings: Settings) {
  const container = new ContainerBuilder().setAccentColor(hexToInt(settings.accentColor));
  const cur = snap.current;

  if (!cur) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          "### ⏹ Очередь пуста",
          snap.autoplay ? "Автоплей включён, но похожих треков не нашлось." : "Добавь трек командой `/play`.",
          snap.stay247 ? "-# Режим 24/7: бот останется в канале." : `-# Бот выйдет из канала через ${settings.leaveOnQueueEndSec} с, если ничего не добавить.`,
        ].join("\n"),
      ),
    );
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        btn(PLAYER_IDS.prev, "⏮", ButtonStyle.Secondary, snap.previousCount === 0),
        btn(PLAYER_IDS.autoplay, "♾️", snap.autoplay ? ButtonStyle.Success : ButtonStyle.Secondary, false, "Автоплей"),
        btn(PLAYER_IDS.stop, "⏹", ButtonStyle.Danger, false, snap.stay247 ? "Стоп" : "Выйти"),
      ),
    );
    return { components: [container], flags: MessageFlags.IsComponentsV2 as const };
  }

  const src = sourceInfo(cur.sourceName);
  const title = truncate(cur.title, 120);
  const head = [
    `-# ${snap.paused ? "⏸ На паузе" : "🎶 Сейчас играет"} · ${src.emoji} ${src.label}`,
    cur.uri ? `### [${escapeMd(title)}](${cur.uri})` : `### ${escapeMd(title)}`,
    `**${escapeMd(truncate(cur.author, 80))}**`,
  ].join("\n");

  if (cur.artworkUrl) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(head))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(cur.artworkUrl).setDescription(truncate(cur.title, 100))),
    );
  } else {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(head));
  }

  const timeline = cur.isStream
    ? "`🔴 LIVE`"
    : `\`${formatDuration(snap.position)}\` ${progressBar(snap.position, cur.duration, 18)} \`${formatDuration(cur.duration)}\``;
  const status = [
    `🔊 ${snap.volume}%`,
    repeatLabel(snap.repeatMode),
    snap.autoplay ? "♾️ Автоплей" : null,
    snap.stay247 ? "🌙 24/7" : null,
    cur.requester && cur.requester.id !== "autoplay" ? `заказал <@${cur.requester.id}>` : cur.requester ? "из автоплея" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`${timeline}\n-# ${status}`));

  if (settings.showUpNext && snap.queue.length > 0) {
    const next = snap.queue.slice(0, 3).map((t, i) => `\`${i + 1}.\` ${trackLine(t, 60)}`);
    const more = snap.queue.length > 3 ? `\n-# и ещё ${snap.queue.length - 3} · всего ${tracksWord(snap.queue.length)}, ${formatDuration(snap.queueDuration)}` : "";
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**Дальше**\n${next.join("\n")}${more}`));
  }

  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));

  const noQueue = snap.queue.length === 0;
  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      btn(PLAYER_IDS.prev, "⏮", ButtonStyle.Secondary, snap.previousCount === 0),
      btn(PLAYER_IDS.toggle, snap.paused ? "▶️" : "⏸", snap.paused ? ButtonStyle.Success : ButtonStyle.Primary),
      btn(PLAYER_IDS.skip, "⏭"),
      btn(PLAYER_IDS.shuffle, "🔀", ButtonStyle.Secondary, snap.queue.length < 2),
      btn(PLAYER_IDS.stop, "⏹", ButtonStyle.Danger),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      btn(PLAYER_IDS.loopQueue, "🔁", snap.repeatMode === "queue" ? ButtonStyle.Success : ButtonStyle.Secondary),
      btn(PLAYER_IDS.loopTrack, "🔂", snap.repeatMode === "track" ? ButtonStyle.Success : ButtonStyle.Secondary),
      btn(PLAYER_IDS.autoplay, "♾️", snap.autoplay ? ButtonStyle.Success : ButtonStyle.Secondary),
      btn(PLAYER_IDS.volDown, "🔉", ButtonStyle.Secondary, snap.volume <= 0),
      btn(PLAYER_IDS.volUp, "🔊", ButtonStyle.Secondary, snap.volume >= settings.maxVolume),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      btn(PLAYER_IDS.queue, "📜", ButtonStyle.Secondary, false, `Очередь${noQueue ? "" : ` (${snap.queue.length})`}`),
      btn(PLAYER_IDS.lyrics, "🎤", ButtonStyle.Secondary, false, "Текст песни"),
    ),
  );

  if (!noQueue) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(PLAYER_IDS.jump)
      .setPlaceholder("⏩ Перейти к треку из очереди…")
      .addOptions(
        snap.queue.slice(0, 25).map((t, i) => ({
          label: truncate(`${i + 1}. ${t.title}`, 100),
          description: truncate(`${t.author} · ${t.isStream ? "LIVE" : formatDuration(t.duration)}`, 100),
          value: String(i + 1),
          emoji: sourceInfo(t.sourceName).emoji,
        })),
      );
    container.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  }

  return { components: [container], flags: MessageFlags.IsComponentsV2 as const };
}
