import type { RepeatMode, Track, UnresolvedTrack } from "lavalink-client";
import { playlistMeta } from "./playlist-meta.js";
import { isBridgeUri, permalinkOf } from "./soundcloud.js";

export interface Requester {
  id: string;
  username: string;
  avatar: string | null;
}

export const AUTOPLAY_REQUESTER: Requester = { id: "autoplay", username: "Автоплей", avatar: null };
export const PANEL_REQUESTER: Requester = { id: "panel", username: "Веб-панель", avatar: null };

/** Ошибка, текст которой можно показать пользователю как есть. */
export class MusicError extends Error {}

export function requesterOf(track: Track | UnresolvedTrack | null | undefined): Requester | null {
  const r = track?.requester as Partial<Requester> | undefined;
  if (!r || typeof r.id !== "string") return null;
  return { id: r.id, username: r.username ?? "?", avatar: r.avatar ?? null };
}

export interface TrackView {
  title: string;
  author: string;
  uri: string | null;
  duration: number;
  isStream: boolean;
  artworkUrl: string | null;
  sourceName: string;
  requester: Requester | null;
  /** Плейлист/альбом, из которого добавлен трек */
  playlistName: string | null;
  playlistUrl: string | null;
}

export interface PlayerSnapshot {
  active: boolean;
  connected: boolean;
  voiceChannelId: string | null;
  textChannelId: string | null;
  playing: boolean;
  paused: boolean;
  position: number;
  volume: number;
  repeatMode: RepeatMode;
  autoplay: boolean;
  stay247: boolean;
  /** Этот Артур умеет 24/7 (только главный) */
  canStay247: boolean;
  current: TrackView | null;
  queue: TrackView[];
  queueDuration: number;
  previousCount: number;
  /** Порядковый номер текущего трека в сессии (1, 2, …) */
  trackNumber: number;
  /** Режим перемешивания */
  shuffle: boolean;
  /** Включённые эффекты */
  effects: string[];
  updatedAt: number;
}

export function toTrackView(track: Track | UnresolvedTrack): TrackView {
  const info = track.info;
  const fromBridge = isBridgeUri(info.uri);
  const scDrm = typeof info.identifier === "string" && info.identifier.startsWith("sc-") && !info.uri;
  const meta = playlistMeta.get(track);
  const playlistName = typeof track.userData?.playlistName === "string" ? track.userData.playlistName : (meta?.playlistName ?? null);
  const playlistUrl = typeof track.userData?.playlistUrl === "string" ? track.userData.playlistUrl : (meta?.playlistUrl ?? null);
  return {
    title: info.title ?? "Без названия",
    author: info.author ?? "Неизвестно",
    uri: fromBridge ? permalinkOf(info.uri!) : (info.uri ?? null),
    duration: info.duration ?? 0,
    isStream: Boolean(info.isStream),
    artworkUrl: info.artworkUrl ?? track.pluginInfo?.artworkUrl ?? track.pluginInfo?.albumArtUrl ?? null,
    sourceName: fromBridge || scDrm ? "soundcloud" : (info.sourceName ?? "unknown"),
    requester: requesterOf(track),
    playlistName,
    playlistUrl,
  };
}

export type UpdateReason =
  | "trackStart"
  | "trackEnd"
  | "queue"
  | "pause"
  | "volume"
  | "repeat"
  | "seek"
  | "autoplay"
  | "settings"
  | "connect"
  | "destroy"
  | "tick";
