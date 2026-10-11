import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
} from "discord.js";
import { truncate } from "../format.js";
import { CHARTS } from "../library/charts.js";
import type { TopEntry } from "../library/history.js";
import type { StoredTrack } from "../library/stored-track.js";
import type { Settings } from "../settings.js";
import { EFFECTS, type EffectKey } from "../music/service.js";
import { icon, type IconKey } from "./emoji.js";
import { trackRow } from "./library-view.js";
import { hexToInt } from "./player-view.js";

export const BR = {
  home: "br:home",
  chart: "br:chart",
  top: "br:top:",
  recent: "br:recent",
  radio: "br:radio:",
  playTop: "br:playtop:",
  playRecent: "br:playrecent",
  wrapped: "br:wrapped",
} as const;

export const FX = { set: "fx:set" } as const;

const V2 = MessageFlags.IsComponentsV2 as const;

function btn(id: string, key: IconKey, label?: string, style = ButtonStyle.Secondary, disabled = false) {
  const b = new ButtonBuilder().setCustomId(id).setEmoji(icon(key)).setStyle(style).setDisabled(disabled);
  if (label) b.setLabel(label);
  return b;
}

const container = (settings: Settings) => new ContainerBuilder().setAccentColor(hexToInt(settings.accentColor));

export function buildBrowseHome(settings: Settings, historySize: number, note?: string) {
  const lines = ["### Обзор", "Чарты и подборки, топ сервера и радио по истории прослушиваний."];
  if (note) lines.push(note);
  if (historySize === 0) lines.push("-# История пока пуста: топы и радио появятся, когда послушаете что-нибудь.");
  const c = container(settings)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")))
    .addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(BR.chart)
          .setPlaceholder("Чарты и подборки…")
          .addOptions(CHARTS.map((ch, i) => ({ label: ch.label, description: ch.description, value: String(i), emoji: icon(i < 3 ? "top" : "playlist") }))),
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        btn(`${BR.top}server`, "top", "Топ сервера"),
        btn(`${BR.top}me`, "heart", "Мой топ"),
        btn(BR.recent, "recent", "Недавние"),
        btn(BR.wrapped, "top", "Итоги месяца"),
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        btn(`${BR.radio}server`, "radio", "Радио сервера", ButtonStyle.Primary, historySize === 0),
        btn(`${BR.radio}me`, "radio", "Моё радио", ButtonStyle.Primary, historySize === 0),
      ),
    );
  return { components: [c], flags: V2 };
}

export function buildTopView(scope: "server" | "me", entries: TopEntry[], settings: Settings) {
  const title = scope === "server" ? "### Топ сервера" : "### Мой топ";
  const body = entries.length
    ? entries.map((e, i) => `${trackRow(e.track, i + 1, 60)} · ${e.plays} ${e.plays === 1 ? "раз" : e.plays < 5 ? "раза" : "раз"}`).join("\n")
    : "Пока ничего: топ собирается из того, что включали на сервере.";
  const c = container(settings)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${title}\n${body}`.slice(0, 3900)))
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        btn(`${BR.playTop}${scope}`, "play", "Слушать топ", ButtonStyle.Primary, entries.length === 0),
        btn(BR.home, "back", "Назад"),
      ),
    );
  return { components: [c], flags: V2 };
}

export function buildRecentView(tracks: StoredTrack[], settings: Settings) {
  const body = tracks.length ? tracks.slice(0, 15).map((t, i) => trackRow(t, i + 1, 60)).join("\n") : "Ты ещё ничего не включал.";
  const c = container(settings).addTextDisplayComponents(new TextDisplayBuilder().setContent(`### Недавние\n${body}`.slice(0, 3900)));
  if (tracks.length) {
    c.addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(BR.playRecent)
          .setPlaceholder("Включить снова…")
          .addOptions(tracks.slice(0, 25).map((t, i) => ({ label: truncate(t.info.title, 100), description: truncate(t.info.author, 100), value: String(i) }))),
      ),
    );
  }
  c.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(btn(BR.home, "back", "Назад")));
  return { components: [c], flags: V2 };
}

export function buildEffectsCard(state: Record<EffectKey, boolean>, settings: Settings, note?: string) {
  const keys = Object.keys(EFFECTS) as EffectKey[];
  const active = keys.filter((k) => state[k]);
  const lines = ["### Эффекты", active.length ? `Включено: **${active.map((k) => EFFECTS[k]).join(", ")}**` : "Эффекты выключены."];
  if (note) lines.push(note);
  lines.push("-# Эффекты действуют на весь плеер, пока их не выключить.");
  const c = container(settings)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")))
    .addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(FX.set)
          .setPlaceholder("Включить или выключить эффект…")
          .addOptions(
            ...keys.map((k) => ({ label: EFFECTS[k], value: k, description: state[k] ? "Сейчас: включён" : "Сейчас: выключен", emoji: icon("effects") })),
            { label: "Выключить все", value: "off", description: "Обычный звук", emoji: icon("clear") },
          ),
      ),
    );
  return { components: [c], flags: V2 };
}
