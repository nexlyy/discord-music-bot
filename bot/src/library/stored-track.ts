import type { LavalinkManager, Track, TrackInfo } from "lavalink-client";

/** Трек в том виде, в каком он лежит в плейлистах и истории (без requester и служебных полей). */
export interface StoredTrack {
  encoded: string;
  info: TrackInfo;
  pluginInfo?: Record<string, unknown>;
}

export function toStored(track: Track): StoredTrack | null {
  if (!track.encoded) return null;
  const i = track.info;
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
  return lavalink.utils.buildTrack({ encoded: s.encoded, info: { ...s.info }, pluginInfo: { ...(s.pluginInfo ?? {}) } } as Track, requester);
}

export function trackKey(t: { info: Pick<TrackInfo, "sourceName" | "identifier"> }): string {
  return `${t.info.sourceName}:${t.info.identifier}`;
}
