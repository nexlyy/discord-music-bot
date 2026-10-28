import { rmSync } from "node:fs";
import { join } from "node:path";
import type { RepeatMode, Track, UnresolvedTrack } from "lavalink-client";
import { fromStored, toStored, type StoredTrack } from "../library/stored-track.js";
import { createLogger } from "../logger.js";
import { JsonFile } from "../store.js";
import { playlistMeta } from "./playlist-meta.js";
import type { PlayerMessage } from "../ui/player-message.js";
import type { EffectKey, MusicService } from "./service.js";
import { requesterOf, type Requester } from "./types.js";

const log = createLogger("session");
const MAX_AGE_MS = 15 * 60_000;

interface SavedEntry {
  track: StoredTrack;
  requester: Requester | null;
  playlistName: string | null;
  playlistUrl: string | null;
}

export interface SavedSession {
  voiceChannelId: string;
  textChannelId: string | null;
  current: SavedEntry | null;
  position: number;
  paused: boolean;
  volume: number;
  repeatMode: RepeatMode;
  autoplay?: boolean;
  shuffle?: boolean;
  effects?: EffectKey[];
  /** Сообщение плеера — после перезапуска редактируем его, а не шлём новое */
  message?: { channelId: string; messageId: string } | null;
  queue: SavedEntry[];
  savedAt: number;
}

function toEntry(t: Track | UnresolvedTrack): SavedEntry | null {
  const track = toStored(t);
  if (!track) return null;
  const meta = playlistMeta.get(t);
  const ud = t.userData ?? {};
  return {
    track,
    requester: requesterOf(t),
    playlistName: typeof ud.playlistName === "string" ? ud.playlistName : (meta?.playlistName ?? null),
    playlistUrl: typeof ud.playlistUrl === "string" ? ud.playlistUrl : (meta?.playlistUrl ?? null),
  };
}

/**
 * Бесшовный перезапуск: что играло, сохраняется каждые 30 с и при остановке, а после старта бот
 * возвращается в канал и продолжает с того же места. Так обновления не обрывают музыку.
 */
export class SessionKeeper {
  private file: JsonFile<SavedSession | null>;
  private path: string;
  /** После сохранения при остановке файл больше не трогаем (иначе событие «плеер уничтожен» сотрёт его). */
  private frozen = false;

  constructor(
    private readonly music: MusicService,
    dataDir: string,
    fileName = "session.json",
    private readonly playerMessage: PlayerMessage | null = null,
  ) {
    this.path = join(dataDir, fileName);
    this.file = new JsonFile<SavedSession | null>(this.path, () => null);
  }

  start() {
    setInterval(() => this.save(), 30_000);
    this.music.on("update", (reason) => {
      if (reason === "destroy") this.clear();
    });
  }

  save() {
    if (this.frozen) return;
    const p = this.music.player;
    if (!p?.voiceChannelId) return this.clear();
    // Во время «Угадай трек» сохраняем то, что играло до игры: после перезапуска вернётся музыка.
    const backup = this.music.quietMode ? this.music.quietBackup : null;
    if (this.music.quietMode && !backup) return;
    const current = backup ? backup.current : p.queue.current;
    const queue = backup ? backup.queue : p.queue.tracks;
    if (!current && queue.length === 0) return this.clear();
    const effects = Object.entries(this.music.effectsState())
      .filter(([, on]) => on)
      .map(([k]) => k as EffectKey);
    const session: SavedSession = {
      voiceChannelId: p.voiceChannelId,
      textChannelId: p.textChannelId,
      current: current ? toEntry(current) : null,
      position: backup ? backup.position : p.position,
      paused: backup ? backup.paused : p.paused,
      volume: p.volume,
      repeatMode: backup ? backup.repeat : p.repeatMode,
      autoplay: this.music.autoplayEnabled,
      shuffle: this.music.shuffleEnabled,
      effects: backup ? [] : effects,
      message: this.playerMessage?.ref() ?? null,
      queue: queue.map(toEntry).filter((e): e is SavedEntry => e !== null),
      savedAt: Date.now(),
    };
    try {
      this.file.write(session);
    } catch (e) {
      log.warn("Не удалось сохранить сессию:", e);
    }
  }

  clear() {
    if (this.frozen) return;
    rmSync(this.path, { force: true });
  }

  /** Сохранить перед остановкой и заморозить файл до выхода. */
  saveAndFreeze() {
    this.save();
    this.frozen = true;
  }

  /** Сессия, оставшаяся с прошлого запуска (если свежая). Файл после чтения удаляется. */
  takePending(): SavedSession | null {
    const s = this.file.read();
    this.clear();
    if (!s?.voiceChannelId || Date.now() - s.savedAt > MAX_AGE_MS) return null;
    return s;
  }

  async restore(s: SavedSession) {
    const lavalink = this.music.lavalink;
    const build = (e: SavedEntry) => {
      const t = fromStored(e.track, lavalink, e.requester ?? undefined) as Track;
      if (e.requester) t.requester = e.requester;
      if (e.playlistName) {
        t.userData = { ...(t.userData ?? {}), playlistName: e.playlistName, playlistUrl: e.playlistUrl };
        playlistMeta.set(t, { playlistName: e.playlistName, playlistUrl: e.playlistUrl });
      }
      return t;
    };
    try {
      // Сначала подхватываем старое сообщение плеера, чтобы не появилось второе.
      if (s.message) await this.playerMessage?.adopt(s.message);
      else await this.playerMessage?.adoptLatest(s.voiceChannelId);
      const player = await this.music.ensurePlayer(s.voiceChannelId, s.textChannelId);
      await player.setVolume(s.volume);
      if (s.repeatMode !== "off") await player.setRepeatMode(s.repeatMode);
      if (typeof s.autoplay === "boolean") this.music.setAutoplayEnabled(s.autoplay);
      if (s.queue.length) await player.queue.add(s.queue.map(build));
      if (s.current) await player.play({ clientTrack: build(s.current), position: s.position, paused: s.paused });
      else if (player.queue.tracks.length) await player.play({ paused: false });
      if (s.shuffle) this.music.restoreShuffleFlag();
      for (const fx of s.effects ?? []) await this.music.toggleEffect(fx).catch(() => undefined);
      // Пока бот перезапускался, все могли выйти — тогда пауза и обычный таймер выхода.
      await this.music.reevaluateChannel();
      log.info(`Сессия восстановлена: ${s.current ? `${s.current.track.info.author} — ${s.current.track.info.title}` : "очередь"}, в очереди ${s.queue.length}`);
    } catch (e) {
      log.warn("Не удалось восстановить сессию:", e);
    }
  }
}
