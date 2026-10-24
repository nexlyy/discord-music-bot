import { rmSync } from "node:fs";
import { join } from "node:path";
import type { RepeatMode, Track, UnresolvedTrack } from "lavalink-client";
import { fromStored, toStored, type StoredTrack } from "../library/stored-track.js";
import { createLogger } from "../logger.js";
import { JsonFile } from "../store.js";
import { playlistMeta } from "./playlist-meta.js";
import type { MusicService } from "./service.js";
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
  ) {
    this.path = join(dataDir, "session.json");
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
    // Во время «Угадай трек» состояние хранит сама игра — файл не трогаем.
    if (this.music.quietMode) return;
    if (!p?.voiceChannelId || (!p.queue.current && p.queue.tracks.length === 0)) return this.clear();
    const session: SavedSession = {
      voiceChannelId: p.voiceChannelId,
      textChannelId: p.textChannelId,
      current: p.queue.current ? toEntry(p.queue.current) : null,
      position: p.position,
      paused: p.paused,
      volume: p.volume,
      repeatMode: p.repeatMode,
      queue: p.queue.tracks.map(toEntry).filter((e): e is SavedEntry => e !== null),
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
      const player = await this.music.ensurePlayer(s.voiceChannelId, s.textChannelId);
      await player.setVolume(s.volume);
      if (s.repeatMode !== "off") await player.setRepeatMode(s.repeatMode);
      if (s.queue.length) await player.queue.add(s.queue.map(build));
      if (s.current) await player.play({ clientTrack: build(s.current), position: s.position, paused: s.paused });
      else if (player.queue.tracks.length) await player.play({ paused: false });
      log.info(`Сессия восстановлена: ${s.current ? `${s.current.track.info.author} — ${s.current.track.info.title}` : "очередь"}, в очереди ${s.queue.length}`);
    } catch (e) {
      log.warn("Не удалось восстановить сессию:", e);
    }
  }
}
