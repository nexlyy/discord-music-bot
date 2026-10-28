import { MessageFlags, type ButtonInteraction, type ChatInputCommandInteraction, type GuildMember, type Interaction, type ModalSubmitInteraction, type StringSelectMenuInteraction, type User } from "discord.js";
import type { Track } from "lavalink-client";
import type { Config } from "../config.js";
import { escapeMd, formatDuration, tracksWord, truncate } from "../format.js";
import type { HistoryStore } from "../library/history.js";
import type { PlaylistStore } from "../library/playlists.js";
import { createLogger } from "../logger.js";
import type { MusicService, PlayResult } from "../music/service.js";
import { MusicError, type Requester } from "../music/types.js";
import type { SettingsStore } from "../settings.js";
import { sourceInfo } from "../sources.js";
import type { LiveLyrics } from "../ui/lyrics-view.js";
import type { PlayerMessage } from "../ui/player-message.js";
import type { Wrapped } from "../wrapped/wrapped.js";
import type { QuizManager } from "../quiz/game.js";
import type { TrackCache } from "./track-cache.js";

const log = createLogger("commands");

export interface Ctx {
  config: Config;
  playlists: PlaylistStore;
  history: HistoryStore;
  wrapped: Wrapped;
  quiz: QuizManager;
  /** Какой Артур обслуживает действие: 0 — главный, 1+ — помощники */
  instanceIndex: number;
  /** Выбранный Артур играет в войсе пользователя или свободен и может туда зайти */
  boundToVoice: boolean;
  /** Все Артуры (для /cleanup: каждый удаляет свои сообщения) */
  bots: { client: import("discord.js").Client; playerMessage: PlayerMessage }[];
  music: MusicService;
  settings: SettingsStore;
  playerMessage: PlayerMessage;
  lyrics: LiveLyrics;
  cache: TrackCache;
}

export type Replyable = ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

export function toRequester(user: User): Requester {
  return { id: user.id, username: user.globalName ?? user.username, avatar: user.displayAvatarURL() };
}

export function userVoiceChannel(i: Interaction): string | null {
  const member = i.member as GuildMember | null;
  return member?.voice?.channelId ?? null;
}

/** Управлять плеером можно только из того же голосового канала. */
/** Управлять Артуром можно только из того войса, где он играет. */
export function assertSameChannel(i: Interaction, music: MusicService) {
  const botChannel = music.player?.voiceChannelId;
  if (!botChannel) return;
  const voice = userVoiceChannel(i);
  if (voice !== botChannel) {
    throw new MusicError(voice ? `Этот Артур играет в <#${botChannel}> — управлять им могут только те, кто там.` : `Зайди в <#${botChannel}>, чтобы управлять музыкой.`);
  }
}

/** Команда для Артура из войса пользователя: войс обязателен, и в нём должен быть (или мочь появиться) свой Артур. */
export function assertVoiceBot(i: Interaction, ctx: Ctx, starting: boolean) {
  if (!userVoiceChannel(i)) throw new MusicError("Зайди в голосовой канал: музыкальные команды работают для Артура из твоего войса.");
  if (!ctx.boundToVoice) {
    throw new MusicError(
      starting
        ? "Все Артуры сейчас играют в других войсах. Подожди, пока кто-то освободится."
        : "В твоём войсе сейчас нет Артура. Включи музыку: `/play`",
    );
  }
}

export async function say(i: Replyable, content: string, ephemeral = true) {
  const payload = { content, allowedMentions: { parse: [] as never[] }, flags: (ephemeral ? MessageFlags.Ephemeral : 0) | MessageFlags.SuppressEmbeds };
  if (i.deferred || i.replied) await i.followUp(payload);
  else await i.reply(payload);
}

export async function fail(i: Replyable, error: unknown) {
  const text = error instanceof MusicError ? error.message : "Что-то пошло не так. Подробности в логах веб-панели.";
  if (!(error instanceof MusicError)) log.error("Ошибка обработки:", error);
  try {
    // У кнопок deferUpdate привязан к сообщению плеера — editReply переписал бы его, поэтому только followUp.
    if (i.isChatInputCommand() && i.deferred && !i.replied) await i.editReply({ content: `❌ ${text}`, allowedMentions: { parse: [] } });
    else await say(i, `❌ ${text}`);
  } catch (e) {
    log.warn("Не удалось ответить на взаимодействие:", e);
  }
}

export function trackLink(t: Track): string {
  const name = escapeMd(truncate(`${t.info.author} — ${t.info.title}`, 90));
  return t.info.uri ? `[${name}](<${t.info.uri}>)` : name;
}

export function describePlay(r: PlayResult): string {
  const first = r.added[0]!;
  const skipped = r.skipped > 0 ? `\n-# Пропущено: ${tracksWord(r.skipped)} (лимиты очереди/длительности)` : "";
  if (r.playlistName) {
    const total = r.added.reduce((s, t) => s + (t.info.duration ?? 0), 0);
    return `📃 Добавлен плейлист **${escapeMd(truncate(r.playlistName, 80))}** — ${tracksWord(r.added.length)}, ${formatDuration(total)}${r.startedNow ? "\n▶️ Начинаю воспроизведение" : ""}${skipped}`;
  }
  const src = sourceInfo(first.info.sourceName);
  if (r.startedNow) return `▶️ Включаю ${src.emoji} ${trackLink(first)} \`${formatDuration(first.info.duration)}\`${skipped}`;
  return `➕ В очереди под номером **${r.position}**: ${src.emoji} ${trackLink(first)} \`${formatDuration(first.info.duration)}\`${skipped}`;
}

