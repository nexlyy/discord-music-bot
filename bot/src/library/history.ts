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
  /** Что заказывал каждый (для /stats); в старых месяцах восстановлено по подробной истории */
  users?: Record<string, UserMonth>;
}

export interface UserMonth {
  tracks: Record<string, number>;
  artists: Record<string, number>;
}

/** Личная статистика для /stats. */
export interface UserStats {
  /** Секунд в войсе под музыку */
  listened: number;
  listenRank: number;
  listenersTotal: number;
  /** Сколько треков заказал */
  requested: number;
  djRank: number;
  djsTotal: number;
  topTracks: { title: string; author: string; uri: string | null; plays: number }[];
  topArtists: { name: string; plays: number }[];
  /** Сколько треков включено в каждый час (0–23, Москва); null — мало данных */
  hours: number[] | null;
}

interface HistoryFile {
  plays: PlayRecord[];
  months?: Record<string, MonthStats>;
}

const MAX_RECORDS = 5000;
const TIMEZONE = "Europe/Moscow";
const monthFormat = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit" });
const hourFormat = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, hour: "2-digit", hourCycle: "h23" });
/** «На повторе»: за какой срок смотрим и как быстро «остывают» старые прослушивания. */
const REPEAT_DAYS = 21;
const REPEAT_HALF_LIFE_DAYS = 5;

const isUserId = (user: string) => /^\d+$/.test(user);
const bump = (map: Record<string, number>, key: string, n = 1) => (map[key] = (map[key] ?? 0) + n);

function rank(table: Record<string, number>, id: string): { rank: number; total: number } {
  const sorted = Object.entries(table)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const idx = sorted.findIndex(([u]) => u === id);
  return { rank: idx === -1 ? 0 : idx + 1, total: sorted.length };
}

/** Нормализованное «исполнитель|название» — чтобы узнавать один трек с разных площадок. */
export function looseKey(author: string, title: string): string {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/ё/g, "е")
      .replace(/\(.*?\)|\[.*?\]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  return `${clean(splitArtists(author)[0] ?? author)}|${clean(title)}`;
}

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
    this.backfillUsers();
  }

  /** Личные сводки появились позже итогов: для старых месяцев собираем их из подробной истории (что в ней осталось). */
  private backfillUsers() {
    const missing = new Set(Object.keys(this.months).filter((k) => !this.months[k]!.users));
    if (missing.size === 0) return;
    for (const k of missing) this.months[k]!.users = {};
    for (const r of this.plays) {
      const k = monthKey(new Date(r.t));
      if (!missing.has(k) || !isUserId(r.user)) continue;
      this.countUser(this.months[k]!, r.user, r.track);
    }
    this.save();
  }

  private countUser(m: MonthStats, user: string, track: StoredTrack) {
    const u = ((m.users ??= {})[user] ??= { tracks: {}, artists: {} });
    bump(u.tracks, trackKey(track));
    for (const a of splitArtists(track.info.author)) bump(u.artists, a);
  }

  private month(key = monthKey()): MonthStats {
    return (this.months[key] ??= { plays: 0, ms: 0, tracks: {}, artists: {}, djs: {}, listeners: {}, users: {} });
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
    if (isUserId(user)) {
      m.djs[user] = (m.djs[user] ?? 0) + 1;
      this.countUser(m, user, track);
    }
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
    const total: MonthStats = { plays: 0, ms: 0, tracks: {}, artists: {}, djs: {}, listeners: {}, users: {} };
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
      for (const [u, um] of Object.entries(m.users ?? {})) {
        const t = (total.users![u] ??= { tracks: {}, artists: {} });
        for (const [k, n] of Object.entries(um.tracks)) bump(t.tracks, k, n);
        for (const [a, n] of Object.entries(um.artists)) bump(t.artists, a, n);
      }
    }
    return total;
  }

  /** Личная статистика за месяц или за всё время (key = null). null — человек ничего не слушал и не включал. */
  userStats(userId: string, key: string | null): UserStats | null {
    const m = this.stats(key);
    if (!m) return null;
    const listened = m.listeners[userId] ?? 0;
    const requested = m.djs[userId] ?? 0;
    if (listened === 0 && requested === 0) return null;
    const own = m.users?.[userId] ?? { tracks: {}, artists: {} };
    const topTracks = Object.entries(own.tracks)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, plays]) => {
        const t = m.tracks[k];
        return { title: t?.title ?? "?", author: t?.author ?? "?", uri: t?.uri ?? null, plays };
      });
    const topArtists = Object.entries(own.artists)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, plays]) => ({ name, plays }));

    // Время суток — по подробной истории (последние недели).
    const counts = new Array<number>(24).fill(0);
    let n = 0;
    for (const r of this.plays) {
      if (r.user !== userId || (key && monthKey(new Date(r.t)) !== key)) continue;
      counts[Number(hourFormat.format(new Date(r.t))) % 24]!++;
      n++;
    }
    const l = rank(m.listeners, userId);
    const d = rank(m.djs, userId);
    return {
      listened,
      listenRank: l.rank,
      listenersTotal: l.total,
      requested,
      djRank: d.rank,
      djsTotal: d.total,
      topTracks,
      topArtists,
      hours: n >= 10 ? counts : null,
    };
  }

  /**
   * «На повторе»: что человек крутит в последние дни. В отличие от «Моего топа» свежие прослушивания
   * весят больше старых (вес половинится каждые 5 дней), и трек должен прозвучать хотя бы дважды.
   */
  onRepeat(userId: string, limit = 30): TopEntry[] {
    const now = Date.now();
    const since = now - REPEAT_DAYS * 86_400_000;
    const halfLife = REPEAT_HALF_LIFE_DAYS * 86_400_000;
    const map = new Map<string, TopEntry & { score: number }>();
    for (const r of this.plays) {
      if (r.t < since || r.user !== userId) continue;
      const key = trackKey(r.track);
      const w = 0.5 ** ((now - r.t) / halfLife);
      const e = map.get(key);
      if (e) {
        e.plays++;
        e.score += w;
        e.lastPlayed = Math.max(e.lastPlayed, r.t);
        e.track = r.track;
      } else {
        map.set(key, { track: r.track, plays: 1, lastPlayed: r.t, score: w });
      }
    }
    return [...map.values()]
      .filter((e) => e.plays >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ score: _s, ...e }) => e);
  }

  /**
   * «Микс войса»: любимое каждого из тех, кто сейчас в войсе, по очереди — чтобы всем досталось поровну.
   * members — у кого нашлась история.
   */
  blend(userIds: string[], count = 30): { tracks: StoredTrack[]; members: string[] } {
    const pools = userIds.map((id) => ({ id, picks: this.radio(id, count) })).filter((p) => p.picks.length > 0);
    const seen = new Set<string>();
    const tracks: StoredTrack[] = [];
    while (tracks.length < count && pools.some((p) => p.picks.length > 0)) {
      for (const p of pools) {
        const t = p.picks.shift();
        if (!t) continue;
        const key = looseKey(t.info.author, t.info.title);
        if (seen.has(key)) continue;
        seen.add(key);
        tracks.push(t);
        if (tracks.length >= count) break;
      }
    }
    return { tracks, members: pools.map((p) => p.id) };
  }

  /** Всё, что когда-либо играло на сервере (чтобы в микс добавлять только то, чего здесь ещё не слышали). */
  heardKeys(): Set<string> {
    const keys = new Set<string>();
    for (const r of this.plays) keys.add(looseKey(r.track.info.author, r.track.info.title));
    for (const m of Object.values(this.months)) for (const t of Object.values(m.tracks)) keys.add(looseKey(t.author, t.title));
    return keys;
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
