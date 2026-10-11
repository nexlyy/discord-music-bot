import type { RepeatMode, Track, UnresolvedTrack } from "lavalink-client";

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
  current: TrackView | null;
  queue: TrackView[];
  queueDuration: number;
  previousCount: number;
  updatedAt: number;
}

export function toTrackView(track: Track | UnresolvedTrack): TrackView {
  const info = track.info;
  return {
    title: info.title ?? "Без названия",
    author: info.author ?? "Неизвестно",
    uri: info.uri ?? null,
    duration: info.duration ?? 0,
    isStream: Boolean(info.isStream),
    artworkUrl: info.artworkUrl ?? track.pluginInfo?.artworkUrl ?? track.pluginInfo?.albumArtUrl ?? null,
    sourceName: info.sourceName ?? "unknown",
    requester: requesterOf(track),
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
