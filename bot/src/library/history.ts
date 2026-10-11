import { join } from "node:path";
import { JsonFile } from "../store.js";
import { trackKey, type StoredTrack } from "./stored-track.js";

interface PlayRecord {
  t: number;
  /** id пользователя Discord, "autoplay" или "panel" */
  user: string;
  track: StoredTrack;
}

export interface TopEntry {
  track: StoredTrack;
  plays: number;
  lastPlayed: number;
}

/** Сводка за месяц: копится всегда, поэтому итоги не зависят от лимита подробной истории. */
export interface MonthStats {
  plays: number;
  /** Сколько музыки реально прозвучало, мс */
  ms: number;
  tracks: Record<string, { title: string; author: string; uri: string | null; artworkUrl: string | null; plays: number }>;
  artists: Record<string, number>;
  /** Заказы треков по пользователям (без автоплея) */
  djs: Record<string, number>;
  /** Секунды в голосовом канале под играющую музыку */
  listeners: Record<string, number>;
}

interface HistoryFile {
  plays: PlayRecord[];
  months?: Record<string, MonthStats>;
}

const MAX_RECORDS = 5000;
const TIMEZONE = "Europe/Moscow";
const monthFormat = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit" });

/** Ключ месяца "2026-10" по московскому времени. */
export function monthKey(date = new Date()): string {
  return monthFormat.format(date).slice(0, 7);
}

/** "Pitbull, AFROJACK & Ne-Yo feat. Nayer" → ["Pitbull", "AFROJACK", "Ne-Yo", "Nayer"] */
export function splitArtists(author: string): string[] {
  return author
    .replace(/\s*-\s*Topic$/i, "")
    .replace(/VEVO$/i, "")
    .split(/\s*,\s*|\s+&\s+|\s+(?:feat\.?|ft\.?|при уч\.)\s+/i)
    .map((a) => a.trim())
    .filter((a) => a.length > 0 && a.length < 80);
}

/** История прослушиваний сервера: топы, недавние, радио и помесячные итоги. Хранится в data/history.json. */
export class HistoryStore {
  private file: JsonFile<HistoryFile>;
  private plays: PlayRecord[];
  private months: Record<string, MonthStats>;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    this.file = new JsonFile(join(dataDir, "history.json"), () => ({ plays: [] }));
    const data = this.file.read();
    this.plays = data.plays ?? [];
    this.months = data.months ?? {};
  }

  private month(key = monthKey()): MonthStats {
    return (this.months[key] ??= { plays: 0, ms: 0, tracks: {}, artists: {}, djs: {}, listeners: {} });
  }

  private save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.file.write({ plays: this.plays, months: this.months });
    }, 5000);
  }

  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.file.write({ plays: this.plays, months: this.months });
  }

  add(user: string, track: StoredTrack) {
    this.plays.push({ t: Date.now(), user, track });
    if (this.plays.length > MAX_RECORDS) this.plays.splice(0, this.plays.length - MAX_RECORDS);

    const m = this.month();
    m.plays++;
    const key = trackKey(track);
    const entry = (m.tracks[key] ??= { title: track.info.title, author: track.info.author, uri: track.info.uri ?? null, artworkUrl: track.info.artworkUrl ?? null, plays: 0 });
    entry.plays++;
    for (const a of splitArtists(track.info.author)) m.artists[a] = (m.artists[a] ?? 0) + 1;
    if (/^\d+$/.test(user)) m.djs[user] = (m.djs[user] ?? 0) + 1;
    this.save();
  }

  /** Сколько реально прозвучало (вызывается, когда трек закончился или его пропустили). */
  addListenedMs(ms: number) {
    if (ms <= 0) return;
    this.month().ms += ms;
    this.save();
  }

  /** Начислить слушателям в канале время прослушивания. */
  addListeners(userIds: string[], seconds: number) {
    if (userIds.length === 0) return;
    const m = this.month();
    for (const id of userIds) m.listeners[id] = (m.listeners[id] ?? 0) + seconds;
    this.save();
  }

  /** Сводка за месяц или за всё время (key = null). */
  stats(key: string | null): MonthStats | null {
    if (key) return this.months[key] ?? null;
    const keys = Object.keys(this.months);
    if (keys.length === 0) return null;
    const total: MonthStats = { plays: 0, ms: 0, tracks: {}, artists: {}, djs: {}, listeners: {} };
    for (const k of keys) {
      const m = this.months[k]!;
      total.plays += m.plays;
      total.ms += m.ms;
      for (const [id, t] of Object.entries(m.tracks)) {
        const e = (total.tracks[id] ??= { ...t, plays: 0 });
        e.plays += t.plays;
      }
      for (const [a, n] of Object.entries(m.artists)) total.artists[a] = (total.artists[a] ?? 0) + n;
      for (const [u, n] of Object.entries(m.djs)) total.djs[u] = (total.djs[u] ?? 0) + n;
      for (const [u, n] of Object.entries(m.listeners)) total.listeners[u] = (total.listeners[u] ?? 0) + n;
    }
    return total;
  }

  /** Самые частые треки. Автоплей не считается: в топ попадает только то, что включали люди. */
  top(opts: { userId?: string; days?: number; limit?: number } = {}): TopEntry[] {
    const since = opts.days ? Date.now() - opts.days * 86_400_000 : 0;
    const map = new Map<string, TopEntry>();
    for (const r of this.plays) {
      if (r.t < since || r.user === "autoplay") continue;
      if (opts.userId && r.user !== opts.userId) continue;
      const key = trackKey(r.track);
      const e = map.get(key);
      if (e) {
        e.plays++;
        e.lastPlayed = Math.max(e.lastPlayed, r.t);
        e.track = r.track;
      } else {
        map.set(key, { track: r.track, plays: 1, lastPlayed: r.t });
      }
    }
    return [...map.values()].sort((a, b) => b.plays - a.plays || b.lastPlayed - a.lastPlayed).slice(0, opts.limit ?? 10);
  }

  /** Недавние уникальные треки пользователя (или сервера). */
  recent(userId?: string, limit = 20): StoredTrack[] {
    const seen = new Set<string>();
    const out: StoredTrack[] = [];
    for (let i = this.plays.length - 1; i >= 0 && out.length < limit; i--) {
      const r = this.plays[i]!;
      if (r.user === "autoplay" || (userId && r.user !== userId)) continue;
      const key = trackKey(r.track);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r.track);
    }
    return out;
  }

  /** Подборка для радио: случайные треки из топа, частые — с большей вероятностью. */
  radio(userId: string | undefined, count: number): StoredTrack[] {
    const items = this.top({ userId, limit: 200 });
    const picked: StoredTrack[] = [];
    while (picked.length < count && items.length > 0) {
      const total = items.reduce((s, e) => s + Math.sqrt(e.plays), 0);
      let r = Math.random() * total;
      let idx = 0;
      for (; idx < items.length - 1; idx++) {
        r -= Math.sqrt(items[idx]!.plays);
        if (r <= 0) break;
      }
      picked.push(items.splice(idx, 1)[0]!.track);
    }
    return picked;
  }

  get size() {
    return this.plays.length;
  }
}
