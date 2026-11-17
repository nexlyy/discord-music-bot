import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from "discord.js";
import { escapeMd, plural, truncate } from "../format.js";
import type { UserStats } from "../library/history.js";
import type { QuizUserStats } from "../quiz/store.js";
import type { Settings } from "../settings.js";
import { BR } from "./browse-view.js";
import { icon } from "./emoji.js";
import { hexToInt } from "./player-view.js";

const num = (n: number) => n.toLocaleString("ru-RU");

/** 148 230 с → «41 ч 10 мин», 900 с → «15 мин». */
export function formatListened(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m} мин`;
  return m ? `${num(h)} ч ${m} мин` : `${num(h)} ч`;
}

const PARTS = [
  { from: 0, to: 5, name: "ночью" },
  { from: 6, to: 11, name: "утром" },
  { from: 12, to: 17, name: "днём" },
  { from: 18, to: 23, name: "вечером" },
];

function timeOfDay(hours: number[]): string {
  const part = PARTS.map((p) => ({ ...p, n: hours.slice(p.from, p.to + 1).reduce((s, x) => s + x, 0) })).sort((a, b) => b.n - a.n)[0]!;
  const peak = hours.indexOf(Math.max(...hours));
  return `Чаще всего музыка включается **${part.name}**, пик — около **${peak}:00**`;
}

const timesWord = (n: number) => `${num(n)} ${plural(n, "раз", "раза", "раз")}`;

export function buildStatsView(
  opts: { name: string; avatar: string; period: string; stats: UserStats; quiz: QuizUserStats | null; self: boolean },
  settings: Settings,
) {
  const { stats: s, quiz } = opts;
  const head = [`### Статистика · ${escapeMd(truncate(opts.name, 60))}`, `-# ${opts.period}`];

  const lines: string[] = [];
  if (s.listened > 0) lines.push(`🎧 В войсе под музыку: **${formatListened(s.listened)}** · #${s.listenRank} из ${s.listenersTotal}`);
  if (s.requested > 0) lines.push(`🎛️ Включено треков: **${num(s.requested)}** · #${s.djRank} из ${s.djsTotal} диджеев`);
  if (s.hours) lines.push(`🕐 ${timeOfDay(s.hours)}`);
  if (quiz && quiz.games > 0) {
    lines.push(`🎮 «Угадай трек»: **${num(quiz.points)}** ${plural(quiz.points, "очко", "очка", "очков")} · побед: ${quiz.wins} из ${quiz.games}`);
  }

  const section = new SectionBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent([...head, "", ...lines].join("\n")))
    .setThumbnailAccessory(new ThumbnailBuilder().setURL(opts.avatar));

  const c = new ContainerBuilder().setAccentColor(hexToInt(settings.accentColor)).addSectionComponents(section);

  const lists: string[] = [];
  if (s.topArtists.length) {
    lists.push("**Любимые артисты**", ...s.topArtists.map((a, i) => `\`${i + 1}.\` ${escapeMd(truncate(a.name, 50))} · ${timesWord(a.plays)}`));
  }
  if (s.topTracks.length) {
    if (lists.length) lists.push("");
    lists.push(
      "**Любимые треки**",
      ...s.topTracks.map((t, i) => {
        const author = t.author.replace(/\s*-\s*Topic$/i, "");
        const name = escapeMd(truncate(`${author} — ${t.title}`, 70));
        return `\`${i + 1}.\` ${t.uri ? `[${name}](${t.uri})` : name} · ${timesWord(t.plays)}`;
      }),
    );
  }
  if (lists.length) {
    c.addSeparatorComponents(new SeparatorBuilder());
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(lists.join("\n").slice(0, 3800)));
  }
  c.addTextDisplayComponents(new TextDisplayBuilder().setContent("-# Артисты и треки — из того, что человек включал сам; время — сколько музыка играла, пока он был в войсе."));

  if (opts.self) {
    c.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(BR.repeat).setEmoji(icon("repeat")).setLabel("На повторе").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(BR.home).setEmoji(icon("browse")).setLabel("Обзор").setStyle(ButtonStyle.Secondary),
      ),
    );
  }
  return { components: [c], flags: MessageFlags.IsComponentsV2 as const };
}
