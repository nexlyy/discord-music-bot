import { randomBytes } from "node:crypto";
import type { SearchResult, Track } from "lavalink-client";

const TTL = 15 * 60_000;
const SEARCH_TTL = 2 * 60_000;

/**
 * Значение варианта автодополнения ограничено 100 символами, поэтому туда кладём короткий ключ,
 * а сам найденный трек держим здесь. /play берёт трек по ключу без повторного поиска.
 */
export class TrackCache {
  private tracks = new Map<string, { value: Track | string; expires: number }>();
  private searches = new Map<string, { value: SearchResult; expires: number }>();

  putTrack(track: Track): string {
    return this.put("t:", track);
  }

  putText(text: string): string {
    return this.put("u:", text);
  }

  getTrack(key: string): Track | null {
    const v = this.get(key);
    return v && typeof v !== "string" ? v : null;
  }

  getText(key: string): string | null {
    const v = this.get(key);
    return typeof v === "string" ? v : null;
  }

  getSearch(key: string): SearchResult | null {
    const e = this.searches.get(key);
    if (!e || e.expires < Date.now()) return null;
    return e.value;
  }

  putSearch(key: string, value: SearchResult) {
    this.searches.set(key, { value, expires: Date.now() + SEARCH_TTL });
    this.prune();
  }

  private put(prefix: string, value: Track | string): string {
    const key = prefix + randomBytes(6).toString("base64url");
    this.tracks.set(key, { value, expires: Date.now() + TTL });
    this.prune();
    return key;
  }

  private get(key: string) {
    const e = this.tracks.get(key);
    if (!e || e.expires < Date.now()) return null;
    return e.value;
  }

  private prune() {
    const now = Date.now();
    if (this.tracks.size > 2000) for (const [k, e] of this.tracks) if (e.expires < now) this.tracks.delete(k);
    if (this.searches.size > 300) for (const [k, e] of this.searches) if (e.expires < now) this.searches.delete(k);
  }
}
