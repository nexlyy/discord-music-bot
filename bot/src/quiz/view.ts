import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from "discord.js";
import { escapeMd, truncate } from "../format.js";
import { hexToInt } from "../ui/player-view.js";
import type { QuizMode } from "./drop.js";
import type { QuizUserStats } from "./store.js";

const V2 = MessageFlags.IsComponentsV2 as const;
const MODE_LABEL: Record<QuizMode, string> = { drop: "дроп", start: "с начала" };
const fmt = (n: number) => new Intl.NumberFormat("ru-RU").format(n);
const ts = (ms: number) => `<t:${Math.floor(ms / 1000)}:R>`;

export const quizId = (game: string, ...parts: (string | number)[]) => ["qz", game, ...parts].join(":");

function stopRow(game: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(quizId(game, "stop")).setLabel("Остановить игру").setEmoji("⏹️").setStyle(ButtonStyle.Danger),
  );
}

export interface Leader {
  userId: string;
  points: number;
  artist: number;
  title: number;
}

function leadersLine(leaders: Leader[]): string {
  const top = leaders.filter((l) => l.points > 0).slice(0, 3);
  return top.length ? `-# Лидеры: ${top.map((l) => `<@${l.userId}> ${fmt(l.points)}`).join(" · ")}` : "";
}

export function lobbyView(o: { game: string; accent: string; mode: QuizMode; rounds: number; voiceChannelId: string; startsAt: number; hostId: string }) {
  const c = new ContainerBuilder()
    .setAccentColor(hexToInt(o.accent))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          "## 🎧 Угадай трек",
          `Раундов: **${o.rounds}** · по **10 секунд** · режим **${MODE_LABEL[o.mode]}**`,
          `Играют все, кто в <#${o.voiceChannelId}>. В каждом раунде выбери **исполнителя** и **название**: за каждое до 1000 очков, чем быстрее, тем больше. Ответ один, передумать нельзя.`,
          "",
          `Подбираю треки по вашей истории… старт ${ts(o.startsAt)}`,
          `-# Запустил(а) <@${o.hostId}>`,
        ].join("\n"),
      ),
    )
    .addActionRowComponents(stopRow(o.game));
  return { components: [c], flags: V2 };
}

function optionRow(game: string, part: "a" | "t", labels: string[], reveal?: { correct: number }) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    labels.map((label, i) =>
      new ButtonBuilder()
        .setCustomId(quizId(game, part, i))
        .setLabel(truncate(label, 80))
        .setStyle(reveal ? (i === reveal.correct ? ButtonStyle.Success : ButtonStyle.Secondary) : ButtonStyle.Secondary)
        .setDisabled(Boolean(reveal)),
    ),
  );
}

export interface RoundState {
  game: string;
  accent: string;
  mode: QuizMode;
  round: number;
  rounds: number;
  endsAt: number;
  artists: string[];
  titles: string[];
  answered: number;
  listeners: number;
  leaders: Leader[];
}

export function roundView(s: RoundState) {
  const c = new ContainerBuilder()
    .setAccentColor(hexToInt(s.accent))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [`-# Раунд ${s.round}/${s.rounds} · режим «${MODE_LABEL[s.mode]}»`, "### 🎵 Что за трек?", `⏱ Время выйдет ${ts(s.endsAt)} · ответили ${s.answered}/${s.listeners}`, leadersLine(s.leaders)]
          .filter(Boolean)
          .join("\n"),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("**Исполнитель**"))
    .addActionRowComponents(optionRow(s.game, "a", s.artists))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("**Название**"))
    .addActionRowComponents(optionRow(s.game, "t", s.titles))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addActionRowComponents(stopRow(s.game));
  return { components: [c], flags: V2 };
}

export interface RevealState extends Omit<RoundState, "endsAt" | "answered" | "listeners"> {
  artist: string;
  title: string;
  uri: string | null;
  artworkUrl: string | null;
  correctArtist: number;
  correctTitle: number;
  artistWinners: { userId: string; points: number }[];
  titleWinners: { userId: string; points: number }[];
  nextAt: number | null;
}

export function revealView(s: RevealState) {
  const who = (list: { userId: string; points: number }[]) =>
    list.length ? list.map((w) => `<@${w.userId}> +${fmt(w.points)}`).join(", ") : "никто не угадал";
  const name = escapeMd(truncate(`${s.artist} — ${s.title}`, 120));
  const head = [`-# Раунд ${s.round}/${s.rounds} · ответ`, s.uri ? `### [${name}](${s.uri})` : `### ${name}`].join("\n");
  const c = new ContainerBuilder().setAccentColor(hexToInt(s.accent));
  if (s.artworkUrl) {
    c.addSectionComponents(
      new SectionBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(head)).setThumbnailAccessory(new ThumbnailBuilder().setURL(s.artworkUrl)),
    );
  } else {
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(head));
  }
  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      [`🎤 Исполнитель: ${who(s.artistWinners)}`, `🎵 Название: ${who(s.titleWinners)}`, leadersLine(s.leaders), s.nextAt ? `-# Следующий раунд ${ts(s.nextAt)}` : "-# Подсчитываю итоги…"]
        .filter(Boolean)
        .join("\n"),
    ),
  )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("**Исполнитель**"))
    .addActionRowComponents(optionRow(s.game, "a", s.artists, { correct: s.correctArtist }))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("**Название**"))
    .addActionRowComponents(optionRow(s.game, "t", s.titles, { correct: s.correctTitle }));
  return { components: [c], flags: V2 };
}

export function noticeView(accent: string, text: string) {
  const c = new ContainerBuilder().setAccentColor(hexToInt(accent)).addTextDisplayComponents(new TextDisplayBuilder().setContent(`### 🎧 Угадай трек\n${text}`));
  return { components: [c], flags: V2 };
}

const MEDALS = ["🥇", "🥈", "🥉"];

export function finalView(o: { accent: string; mode: QuizMode; played: number; leaders: Leader[]; stoppedBy?: string | null }) {
  const rows = o.leaders.length
    ? o.leaders.map(
        (l, i) => `${MEDALS[i] ?? `\`${i + 1}.\``} <@${l.userId}> — **${fmt(l.points)}** · исполнитель ${l.artist}/${o.played} · название ${l.title}/${o.played}`,
      )
    : ["Никто не ответил 🙈"];
  const winner = o.leaders[0] && o.leaders[0].points > 0 ? `\nПобедитель — <@${o.leaders[0].userId}>! 🎉` : "";
  const c = new ContainerBuilder()
    .setAccentColor(hexToInt(o.accent))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          "## 🏆 Итоги «Угадай трек»",
          `-# Раундов сыграно: ${o.played} · режим «${MODE_LABEL[o.mode]}»${o.stoppedBy ? ` · игру остановил(а) <@${o.stoppedBy}>` : ""}`,
          ...rows,
          winner,
          "-# Общий рейтинг — `/quiz top`, новая игра — `/quiz start`",
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    );
  return { components: [c], flags: V2 };
}

export function topView(accent: string, rows: [string, QuizUserStats][]) {
  const lines = rows.length
    ? rows.map(([id, u], i) => {
        const accuracy = u.rounds ? Math.round(((u.artist + u.title) / (u.rounds * 2)) * 100) : 0;
        return `${MEDALS[i] ?? `\`${i + 1}.\``} <@${id}> — **${fmt(u.points)}** · игр ${u.games} · побед ${u.wins} · точность ${accuracy}%`;
      })
    : ["Пока никто не играл. Начни: `/quiz start`"];
  const c = new ContainerBuilder()
    .setAccentColor(hexToInt(accent))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(["### 🏆 Рейтинг «Угадай трек»", ...lines].join("\n")));
  return { components: [c], flags: V2 };
}
