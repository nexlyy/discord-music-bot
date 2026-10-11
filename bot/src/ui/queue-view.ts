import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
} from "discord.js";
import { formatDuration, tracksWord } from "../format.js";
import type { PlayerSnapshot } from "../music/types.js";
import type { Settings } from "../settings.js";
import { hexToInt, trackLine } from "./player-view.js";

export const QUEUE_PAGE_SIZE = 10;
export const QUEUE_PAGE_PREFIX = "q:page:";

export function buildQueueMessage(snap: PlayerSnapshot, settings: Settings, page: number) {
  const pages = Math.max(1, Math.ceil(snap.queue.length / QUEUE_PAGE_SIZE));
  const p = Math.min(Math.max(page, 1), pages);
  const start = (p - 1) * QUEUE_PAGE_SIZE;
  const items = snap.queue.slice(start, start + QUEUE_PAGE_SIZE);

  const lines: string[] = ["### 📜 Очередь"];
  if (snap.current) lines.push(`**Сейчас:** ${trackLine(snap.current, 80)}`, "");
  if (items.length === 0) lines.push("Очередь пуста. Добавь треки командой `/play`.");
  else lines.push(...items.map((t, i) => `\`${start + i + 1}.\` ${trackLine(t, 70)}${t.requester && t.requester.id !== "autoplay" ? ` · <@${t.requester.id}>` : ""}`));
  lines.push("", `-# ${tracksWord(snap.queue.length)} · ${formatDuration(snap.queueDuration)} · страница ${p}/${pages}`);

  const container = new ContainerBuilder()
    .setAccentColor(hexToInt(settings.accentColor))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n").slice(0, 3900)));

  // customId: q:page:<страница>:<роль> — роль делает id уникальными внутри сообщения.
  const nav = (target: number, role: string, emoji: string, disabled = false) =>
    new ButtonBuilder()
      .setCustomId(`${QUEUE_PAGE_PREFIX}${target}:${role}`)
      .setEmoji(emoji)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled);
  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...(pages > 1 ? [nav(1, "first", "⏮", p === 1), nav(p - 1, "prev", "◀️", p === 1)] : []),
      nav(p, "refresh", "🔄"),
      ...(pages > 1 ? [nav(p + 1, "next", "▶️", p === pages), nav(pages, "last", "⏭", p === pages)] : []),
    ),
  );
  return { components: [container], flags: MessageFlags.IsComponentsV2 as const };
}
