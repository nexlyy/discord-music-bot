import type { LavalinkManager, SearchResult, Track, UnresolvedTrack } from "lavalink-client";
import { createLogger } from "../logger.js";
import { MusicError, type Requester } from "./types.js";

/**
 * SoundCloud через sc-bridge (см. sc-bridge/app.py): встроенный источник Lavalink не умеет новый формат
 * SoundCloud (AAC HLS), поэтому трек качает мост, а Lavalink играет его как обычный http-файл.
 * Треки с DRM скачать нельзя — их ищем по названию на YouTube Music.
 */

const log = createLogger("soundcloud");
const BRIDGE = (process.env.SC_BRIDGE_URL ?? "http://sc-bridge:8080").replace(/\/$/, "");

interface ScTrack {
  id: number;
  url: string | null;
  title: string;
  artist: string;
  duration: number;
  artwork: string | null;
  drm: boolean;
  playable: boolean;
}

interface ScResult {
  kind: "track" | "playlist" | "search";
  title: string | null;
  url: string | null;
  tracks: ScTrack[];
}

async function bridge(path: string): Promise<ScResult> {
  let res: Response;
  try {
    res = await fetch(`${BRIDGE}${path}`, { signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new MusicError("Сервис SoundCloud не отвечает, попробуй через минуту.");
  }
  const body = (await res.json().catch(() => ({}))) as ScResult & { error?: string };
  if (!res.ok) throw new MusicError(body.error ?? `SoundCloud: ошибка ${res.status}`);
  return body;
}

export function streamUrl(t: Pick<ScTrack, "id" | "url">): string {
  return `${BRIDGE}/stream/${t.id}${t.url ? `?u=${encodeURIComponent(t.url)}` : ""}`;
}

export function isBridgeUri(uri: string | null | undefined): uri is string {
  return typeof uri === "string" && uri.startsWith(`${BRIDGE}/stream/`);
}

/** Ссылка на трек на SoundCloud по адресу моста (для показа пользователю). */
export function permalinkOf(uri: string): string | null {
  try {
    return new URL(uri).searchParams.get("u");
  } catch {
    return null;
  }
}

export function bridgeTrackId(uri: string): string | null {
  return uri.match(/\/stream\/(\d+)/)?.[1] ?? null;
}

function toUnresolved(t: ScTrack, lavalink: LavalinkManager, requester: Requester): UnresolvedTrack {
  if (t.drm) {
    // Без uri библиотека найдёт трек поиском «название by исполнитель» на указанной площадке.
    return lavalink.utils.buildUnresolvedTrack(
      { title: t.title, author: t.artist, duration: t.duration, artworkUrl: t.artwork, sourceName: "ytmsearch" as never, identifier: `sc-${t.id}` },
      requester,
    );
  }
  const uri = streamUrl(t);
  return lavalink.utils.buildUnresolvedTrack(
    { title: t.title, author: t.artist, duration: t.duration, artworkUrl: t.artwork, uri, sourceName: "soundcloud", identifier: uri, isSeekable: true, isStream: false },
    requester,
  );
}

function toSearchResult(r: ScResult, lavalink: LavalinkManager, requester: Requester): SearchResult {
  const usable = r.tracks.filter((t) => t.playable);
  if (usable.length === 0) throw new MusicError(r.kind === "search" ? "На SoundCloud ничего не нашлось." : "В плейлисте нет доступных треков.");
  const tracks = usable.map((t) => toUnresolved(t, lavalink, requester)) as unknown as Track[];
  return {
    loadType: r.kind,
    exception: null,
    pluginInfo: {},
    playlist:
      r.kind === "playlist"
        ? { name: r.title ?? "Плейлист", title: r.title ?? "Плейлист", uri: r.url ?? undefined, selectedTrack: null, duration: usable.reduce((s, t) => s + t.duration, 0) }
        : null,
    tracks,
  };
}

export async function scLoad(url: string, lavalink: LavalinkManager, requester: Requester): Promise<SearchResult> {
  const r = await bridge(`/resolve?url=${encodeURIComponent(url)}`);
  log.info(`SoundCloud: ${r.kind} «${r.title ?? ""}», треков ${r.tracks.length}, с DRM ${r.tracks.filter((t) => t.drm).length}`);
  return toSearchResult(r, lavalink, requester);
}

export async function scSearch(query: string, lavalink: LavalinkManager, requester: Requester): Promise<SearchResult> {
  return toSearchResult(await bridge(`/search?q=${encodeURIComponent(query)}&limit=10`), lavalink, requester);
}

/** Заранее скачать трек, чтобы между треками не было паузы. */
export function prefetch(track: Track | UnresolvedTrack | undefined) {
  const uri = track?.info?.uri;
  if (!isBridgeUri(uri)) return;
  const id = bridgeTrackId(uri);
  if (id) fetch(`${BRIDGE}/prefetch/${id}`, { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
}
