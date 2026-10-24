import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { Track } from "lavalink-client";
import { escapeMd, truncate } from "../format.js";
import { createLogger } from "../logger.js";
import { currentLineIndex, getLyrics, type Lyrics } from "../music/lyrics.js";
import type { MusicService } from "../music/service.js";
import { MusicError } from "../music/types.js";
import type { SettingsStore } from "../settings.js";
import { hexToInt } from "./player-view.js";

const log = createLogger("lyrics-view");
export const LYRICS_IDS = { close: "ly:close", full: "ly:full" } as const;

type LyricsInteraction = ButtonInteraction | StringSelectMenuInteraction | ChatInputCommandInteraction;

const BEFORE = 2;
const AFTER = 5;
/** Токен ответа на взаимодействие живёт 15 минут — обновляем чуть меньше. */
const SESSION_MS = 14 * 60_000;

function header(track: Track, lyrics: Lyrics | null) {
  const src = lyrics ? ` · ${lyrics.source}${lyrics.synced ? " · синхронно" : ""}` : "";
  return `-# Текст песни${src}\n### ${escapeMd(truncate(`${track.info.author} — ${track.info.title}`, 100))}`;
}

function body(lyrics: Lyrics | null, position: number): string {
  if (!lyrics) return "Текст для этого трека не нашёлся.";
  if (!lyrics.synced) return truncate(lyrics.text || "Текст пустой.", 3400);
  const idx = currentLineIndex(lyrics, position);
  const from = Math.max(0, idx - BEFORE);
  const to = Math.min(lyrics.lines.length, Math.max(idx, 0) + AFTER + 1);
  const out: string[] = [];
  if (idx < 0) out.push("-# ♪ вступление ♪");
  for (let i = from; i < to; i++) {
    const text = lyrics.lines[i]!.text || "♪";
    if (i === idx) out.push(`## ${escapeMd(text)}`);
    else if (i < idx) out.push(`-# ${escapeMd(text)}`);
    else out.push(escapeMd(text));
  }
  return out.join("\n");
}

function view(track: Track, lyrics: Lyrics | null, position: number, accent: string, note?: string) {
  const content = `${header(track, lyrics)}\n${body(lyrics, position)}${note ? `\n-# ${note}` : ""}`;
  const container = new ContainerBuilder()
    .setAccentColor(hexToInt(accent))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(content))
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(LYRICS_IDS.full).setLabel("Весь текст").setEmoji("📄").setStyle(ButtonStyle.Secondary).setDisabled(!lyrics),
        new ButtonBuilder().setCustomId(LYRICS_IDS.close).setLabel("Закрыть").setEmoji("✖️").setStyle(ButtonStyle.Secondary),
      ),
    );
  return { components: [container], flags: MessageFlags.IsComponentsV2 as const };
}

interface Session {
  interaction: LyricsInteraction;
  startedAt: number;
  trackId: string;
  lyrics: Lyrics | null;
  lastIdx: number;
  busy: boolean;
}

/**
 * Живой текст песни, который видит только тот, кто его открыл (эфемерное сообщение).
 * Строка подсвечивается по ходу трека, на следующем треке текст переключается сам.
 */
export class LiveLyrics {
  private sessions = new Map<string, Session>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly music: MusicService,
    private readonly settings: SettingsStore,
  ) {
    music.on("update", (reason) => {
      if (reason === "trackStart") void this.switchTrack();
      if (reason === "destroy") void this.closeAll("Воспроизведение остановлено");
    });
    music.on("quiet", (on) => {
      if (on) void this.closeAll("Началась «Угадай трек» — текст откроешь после игры");
    });
  }

  /** Открыть текст для нажавшего. Повторное открытие заменяет его прошлую сессию. */
  async open(i: LyricsInteraction) {
    const player = this.music.player;
    const track = player?.queue.current;
    if (this.music.quietMode) throw new MusicError("Во время «Угадай трек» текст недоступен 😉");
    if (!player || !track) throw new MusicError("Сейчас ничего не играет.");
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const lyrics = await getLyrics(player, track);
    await i.editReply(view(track, lyrics, player.position, this.settings.get().accentColor));
    this.sessions.set(i.user.id, { interaction: i, startedAt: Date.now(), trackId: track.info.identifier, lyrics, lastIdx: -2, busy: false });
    this.ensureTimer();
  }

  close(userId: string) {
    this.sessions.delete(userId);
    this.stopTimerIfIdle();
  }

  lyricsFor(userId: string): Lyrics | null {
    return this.sessions.get(userId)?.lyrics ?? null;
  }

  private ensureTimer() {
    if (!this.timer) this.timer = setInterval(() => void this.tick(), 1500);
  }

  private stopTimerIfIdle() {
    if (this.sessions.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async edit(userId: string, s: Session, note?: string) {
    const player = this.music.player;
    const track = player?.queue.current;
    if (!player || !track) return;
    try {
      await s.interaction.editReply(view(track, s.lyrics, player.position, this.settings.get().accentColor, note));
    } catch (e) {
      log.debug("Сессия текста закрыта:", e instanceof Error ? e.message : e);
      this.sessions.delete(userId);
    }
  }

  private async tick() {
    const player = this.music.player;
    if (!player?.queue.current) return;
    for (const [userId, s] of this.sessions) {
      if (s.busy) continue;
      if (Date.now() - s.startedAt > SESSION_MS) {
        this.sessions.delete(userId);
        await this.edit(userId, s, "Живое обновление остановлено — нажми «Текст» ещё раз.");
        continue;
      }
      if (!s.lyrics?.synced) continue;
      const idx = currentLineIndex(s.lyrics, player.position);
      if (idx === s.lastIdx) continue;
      s.lastIdx = idx;
      s.busy = true;
      await this.edit(userId, s);
      s.busy = false;
    }
    this.stopTimerIfIdle();
  }

  private async switchTrack() {
    const player = this.music.player;
    const track = player?.queue.current;
    if (!player || !track || this.sessions.size === 0) return;
    const lyrics = await getLyrics(player, track).catch(() => null);
    for (const [userId, s] of this.sessions) {
      if (s.trackId === track.info.identifier) continue;
      s.trackId = track.info.identifier;
      s.lyrics = lyrics;
      s.lastIdx = -2;
      await this.edit(userId, s);
    }
  }

  async closeAll(note: string) {
    const player = this.music.player;
    for (const [userId, s] of this.sessions) {
      this.sessions.delete(userId);
      // Плеер уже уничтожен — показываем короткую заметку вместо текста.
      if (!player?.queue.current || this.music.quietMode) {
        await s.interaction.editReply({ components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${note}`))], flags: MessageFlags.IsComponentsV2 }).catch(() => undefined);
      }
    }
    this.stopTimerIfIdle();
  }
}
