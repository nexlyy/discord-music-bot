import type { LavalinkManager, Track, TrackInfo, UnresolvedTrack } from "lavalink-client";

/** Трек в том виде, в каком он лежит в плейлистах и истории (без requester и служебных полей). */
export interface StoredTrack {
  /** Нет у отложенных треков (SoundCloud через мост до первой загрузки) */
  encoded?: string;
  info: TrackInfo;
  pluginInfo?: Record<string, unknown>;
}

export function toStored(track: Track | UnresolvedTrack): StoredTrack | null {
  const i = track.info as TrackInfo;
  if (!track.encoded && !i.uri && !i.title) return null;
  return {
    encoded: track.encoded,
    info: {
      identifier: i.identifier,
      title: i.title,
      author: i.author,
      duration: i.duration,
      artworkUrl: i.artworkUrl ?? null,
      uri: i.uri,
      sourceName: i.sourceName,
      isSeekable: i.isSeekable,
      isStream: i.isStream,
      isrc: i.isrc ?? null,
    },
    pluginInfo: track.pluginInfo ? { ...track.pluginInfo, clientData: undefined } : undefined,
  };
}

export function fromStored(s: StoredTrack, lavalink: LavalinkManager, requester: unknown): Track {
  if (!s.encoded) {
    // Отложенный трек: подгрузится по uri (мост SoundCloud) или поиском по названию.
    const info = { ...s.info, sourceName: s.info.uri ? s.info.sourceName : ("ytmsearch" as never) };
    return lavalink.utils.buildUnresolvedTrack(info, requester) as unknown as Track;
  }
  return lavalink.utils.buildTrack({ encoded: s.encoded, info: { ...s.info }, pluginInfo: { ...(s.pluginInfo ?? {}) } } as Track, requester);
}

/** Копия трека с другим заказчиком (для отложенных треков нельзя просто распаковать объект — потеряется пометка). */
export function withRequester(track: Track, lavalink: LavalinkManager, requester: unknown): Track {
  if (lavalink.utils.isUnresolvedTrack(track)) return lavalink.utils.buildUnresolvedTrack({ ...track.info }, requester) as unknown as Track;
  return { ...track, requester } as Track;
}

export function trackKey(t: { info: Pick<TrackInfo, "sourceName" | "identifier"> }): string {
  return `${t.info.sourceName}:${t.info.identifier}`;
}
