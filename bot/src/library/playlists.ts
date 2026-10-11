import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { MusicError } from "../music/types.js";
import { JsonFile } from "../store.js";
import { trackKey, type StoredTrack } from "./stored-track.js";

export interface Playlist {
  id: string;
  ownerId: string;
  name: string;
  /** «Любимые»: создаётся сам, удалить и переименовать нельзя */
  liked: boolean;
  sourceUrl: string | null;
  createdAt: number;
  updatedAt: number;
  tracks: StoredTrack[];
}

export const LIKED_NAME = "Любимые";
const MAX_PLAYLISTS = 50;
const MAX_TRACKS = 1000;
const MAX_NAME = 60;

/** Личные плейлисты участников сервера. Хранятся в data/playlists.json. */
export class PlaylistStore {
  private file: JsonFile<{ playlists: Playlist[] }>;
  private playlists: Playlist[];
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    this.file = new JsonFile(join(dataDir, "playlists.json"), () => ({ playlists: [] }));
    this.playlists = this.file.read().playlists ?? [];
  }

  private save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.file.write({ playlists: this.playlists });
    }, 500);
  }

  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.file.write({ playlists: this.playlists });
  }

  /** Плейлисты пользователя: «Любимые» первыми, дальше недавно изменённые. */
  list(ownerId: string): Playlist[] {
    return this.playlists
      .filter((p) => p.ownerId === ownerId)
      .sort((a, b) => Number(b.liked) - Number(a.liked) || b.updatedAt - a.updatedAt);
  }

  get(id: string): Playlist | null {
    return this.playlists.find((p) => p.id === id) ?? null;
  }

  /** Плейлист, которым пользователь может управлять. */
  own(id: string, userId: string): Playlist {
    const p = this.get(id);
    if (!p || p.ownerId !== userId) throw new MusicError("Плейлист не найден.");
    return p;
  }

  search(ownerId: string, query: string): Playlist[] {
    const q = query.trim().toLowerCase();
    return this.list(ownerId).filter((p) => p.tracks.length > 0 && (!q || p.name.toLowerCase().includes(q)));
  }

  liked(ownerId: string): Playlist {
    let p = this.playlists.find((x) => x.ownerId === ownerId && x.liked);
    if (!p) {
      p = this.make(ownerId, LIKED_NAME, true);
      this.playlists.push(p);
      this.save();
    }
    return p;
  }

  create(ownerId: string, name: string, tracks: StoredTrack[] = [], sourceUrl: string | null = null): Playlist {
    const clean = name.trim().slice(0, MAX_NAME);
    if (!clean) throw new MusicError("Название плейлиста не может быть пустым.");
    const mine = this.list(ownerId);
    if (mine.length >= MAX_PLAYLISTS) throw new MusicError(`Можно хранить не больше ${MAX_PLAYLISTS} плейлистов.`);
    if (mine.some((p) => p.name.toLowerCase() === clean.toLowerCase())) throw new MusicError(`Плейлист «${clean}» уже есть.`);
    const p = this.make(ownerId, clean, false, sourceUrl);
    p.tracks = dedupe(tracks).slice(0, MAX_TRACKS);
    this.playlists.push(p);
    this.save();
    return p;
  }

  /** Возвращает, сколько треков реально добавлено (дубликаты пропускаются). */
  add(id: string, userId: string, tracks: StoredTrack[]): number {
    const p = this.own(id, userId);
    const have = new Set(p.tracks.map(trackKey));
    const fresh = dedupe(tracks).filter((t) => !have.has(trackKey(t)));
    const room = MAX_TRACKS - p.tracks.length;
    if (room <= 0) throw new MusicError(`В плейлисте уже ${MAX_TRACKS} треков.`);
    p.tracks.push(...fresh.slice(0, room));
    p.updatedAt = Date.now();
    this.save();
    return Math.min(fresh.length, room);
  }

  removeAt(id: string, userId: string, index: number): StoredTrack {
    const p = this.own(id, userId);
    const [removed] = p.tracks.splice(index, 1);
    if (!removed) throw new MusicError("Такого трека в плейлисте нет.");
    p.updatedAt = Date.now();
    this.save();
    return removed;
  }

  rename(id: string, userId: string, name: string): Playlist {
    const p = this.own(id, userId);
    if (p.liked) throw new MusicError("«Любимые» переименовать нельзя.");
    const clean = name.trim().slice(0, MAX_NAME);
    if (!clean) throw new MusicError("Название не может быть пустым.");
    if (this.list(userId).some((x) => x.id !== id && x.name.toLowerCase() === clean.toLowerCase())) throw new MusicError(`Плейлист «${clean}» уже есть.`);
    p.name = clean;
    p.updatedAt = Date.now();
    this.save();
    return p;
  }

  delete(id: string, userId: string): Playlist {
    const p = this.own(id, userId);
    if (p.liked) throw new MusicError("«Любимые» удалить нельзя, но можно убрать из них треки.");
    this.playlists = this.playlists.filter((x) => x.id !== id);
    this.save();
    return p;
  }

  isLiked(userId: string, track: StoredTrack): boolean {
    const p = this.playlists.find((x) => x.ownerId === userId && x.liked);
    return Boolean(p?.tracks.some((t) => trackKey(t) === trackKey(track)));
  }

  /** Переключить «Нравится». Возвращает новое состояние. */
  toggleLike(userId: string, track: StoredTrack): boolean {
    const p = this.liked(userId);
    const idx = p.tracks.findIndex((t) => trackKey(t) === trackKey(track));
    if (idx >= 0) p.tracks.splice(idx, 1);
    else p.tracks.unshift(track);
    p.updatedAt = Date.now();
    this.save();
    return idx < 0;
  }

  private make(ownerId: string, name: string, liked: boolean, sourceUrl: string | null = null): Playlist {
    const now = Date.now();
    return { id: randomBytes(5).toString("base64url"), ownerId, name, liked, sourceUrl, createdAt: now, updatedAt: now, tracks: [] };
  }
}

function dedupe(tracks: StoredTrack[]): StoredTrack[] {
  const seen = new Set<string>();
  return tracks.filter((t) => (seen.has(trackKey(t)) ? false : (seen.add(trackKey(t)), true)));
}
