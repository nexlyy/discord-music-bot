import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
  type Message,
  type SendableChannels,
} from "discord.js";
import type { Track } from "lavalink-client";
import { escapeMd, truncate } from "../format.js";
import { createLogger } from "../logger.js";
import { currentLineIndex, getLyrics, type Lyrics } from "../music/lyrics.js";
import type { MusicService } from "../music/service.js";
import type { SettingsStore } from "../settings.js";
import { hexToInt } from "./player-view.js";

const log = createLogger("lyrics-view");
export const LYRICS_IDS = { close: "ly:close", full: "ly:full" } as const;

const BEFORE = 2;
const AFTER = 5;

function header(track: Track, lyrics: Lyrics | null) {
  const src = lyrics ? ` · ${lyrics.source}${lyrics.synced ? " · синхронно" : ""}` : "";
  return `-# 🎤 Текст песни${src}\n### ${escapeMd(truncate(`${track.info.author} — ${track.info.title}`, 100))}`;
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

function view(track: Track, lyrics: Lyrics | null, position: number, accent: string) {
  const container = new ContainerBuilder()
    .setAccentColor(hexToInt(accent))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${header(track, lyrics)}\n${body(lyrics, position)}`))
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(LYRICS_IDS.full).setLabel("Весь текст").setEmoji("📄").setStyle(ButtonStyle.Secondary).setDisabled(!lyrics),
        new ButtonBuilder().setCustomId(LYRICS_IDS.close).setLabel("Закрыть").setEmoji("✖️").setStyle(ButtonStyle.Secondary),
      ),
    );
  return { components: [container], flags: MessageFlags.IsComponentsV2 as const };
}

/** Живой текст: сообщение подсвечивает текущую строку и само переключается на следующий трек. */
export class LiveLyrics {
  private message: Message | null = null;
  private trackId: string | null = null;
  private lyrics: Lyrics | null = null;
  private lastIdx = -2;
  private timer: NodeJS.Timeout | null = null;
  private loading = false;

  constructor(
    private readonly music: MusicService,
    private readonly settings: SettingsStore,
  ) {
    music.on("update", (reason) => {
      if (reason === "trackStart") void this.switchTrack();
      if (reason === "destroy") void this.close();
    });
  }

  get active() {
    return this.message !== null;
  }

  currentLyrics(): Lyrics | null {
    return this.lyrics;
  }

  async open(channel: SendableChannels) {
    await this.close();
    const player = this.music.player;
    const track = player?.queue.current;
    if (!player || !track) throw new Error("Сейчас ничего не играет.");
    this.trackId = track.info.identifier;
    this.lyrics = await getLyrics(player, track);
    this.lastIdx = -2;
    this.message = await channel.send(view(track, this.lyrics, player.position, this.settings.get().accentColor));
    this.startTimer();
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const msg = this.message;
    this.message = null;
    this.trackId = null;
    if (msg) await msg.delete().catch(() => undefined);
  }

  isLyricsMessage(id: string) {
    return this.message?.id === id;
  }

  private startTimer() {
    if (this.timer) clearInterval(this.timer);
    if (!this.lyrics?.synced) return;
    this.timer = setInterval(() => void this.tick(), 1500);
  }

  private async tick() {
    const player = this.music.player;
    const track = player?.queue.current;
    if (!this.message || !player || !track || !this.lyrics?.synced || this.loading) return;
    const idx = currentLineIndex(this.lyrics, player.position);
    if (idx === this.lastIdx) return;
    this.lastIdx = idx;
    await this.message
      .edit(view(track, this.lyrics, player.position, this.settings.get().accentColor))
      .catch((e) => {
        log.debug("edit:", e);
        this.message = null;
      });
  }

  private async switchTrack() {
    if (!this.message) return;
    const player = this.music.player;
    const track = player?.queue.current;
    if (!player || !track || track.info.identifier === this.trackId) return;
    this.loading = true;
    try {
      this.trackId = track.info.identifier;
      this.lyrics = await getLyrics(player, track);
      this.lastIdx = -2;
      await this.message.edit(view(track, this.lyrics, player.position, this.settings.get().accentColor));
      this.startTimer();
    } catch (e) {
      log.debug("switchTrack:", e);
    } finally {
      this.loading = false;
    }
  }
}
