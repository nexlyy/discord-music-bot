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

const MAX_RECORDS = 5000;

/** История прослушиваний сервера: для топов, недавних треков и радио. Хранится в data/history.json. */
export class HistoryStore {
  private file: JsonFile<{ plays: PlayRecord[] }>;
  private plays: PlayRecord[];
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    this.file = new JsonFile(join(dataDir, "history.json"), () => ({ plays: [] }));
    this.plays = this.file.read().plays ?? [];
  }

  add(user: string, track: StoredTrack) {
    this.plays.push({ t: Date.now(), user, track });
    if (this.plays.length > MAX_RECORDS) this.plays.splice(0, this.plays.length - MAX_RECORDS);
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.file.write({ plays: this.plays });
      }, 5000);
    }
  }

  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.file.write({ plays: this.plays });
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
    const pool = this.top({ userId, limit: 200 });
    const picked: StoredTrack[] = [];
    const items = [...pool];
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
