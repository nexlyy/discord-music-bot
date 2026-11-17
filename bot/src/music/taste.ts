import { join } from "node:path";
import { splitArtists } from "../library/history.js";
import { JsonFile } from "../store.js";
import { fold } from "./fallback.js";

/**
 * Что сервер не хочет слышать в автоплее. Артиста можно убрать вручную (пункт меню плеера), а можно
 * просто скипать: два быстрых скипа автоплейного трека одного артиста — и он больше не подбирается,
 * пока кто-нибудь сам не включит его трек. Здесь же память, какой трек как называется в Spotify.
 */

/** Скип в первые 30 секунд считается «не то». */
export const QUICK_SKIP_MS = 30_000;
/** После скольких быстрых скипов артист пропадает из автоплея. */
const SKIPS_TO_BLOCK = 2;
/** Старые скипы забываются. */
const SKIP_MEMORY_MS = 45 * 86_400_000;
/** «Не нашёлся в Spotify» перепроверяем через неделю: каталог пополняется. */
const MISS_TTL_MS = 7 * 86_400_000;
const MAX_SPOTIFY_IDS = 3000;

interface Ban {
  name: string;
  at: number;
  by: string;
}

interface Skips {
  name: string;
  n: number;
  at: number;
}

interface SpotifyRef {
  id: string | null;
  at: number;
}

interface TasteFile {
  banned: Record<string, Ban>;
  skips: Record<string, Skips>;
  spotify: Record<string, SpotifyRef>;
}

export interface BlockReason {
  name: string;
  why: "ban" | "skips";
}

type InfoLike = { author?: string; title?: string; sourceName?: string };

/** "MiyaGi & Эндшпиль - Тамада (Official Video)" → "MiyaGi & Эндшпиль"; без исполнителя в названии — null. */
function titleArtist(title: string): string | null {
  const m = /^(.+?)\s+[-–—]\s+\S/.exec(title);
  return m && m[1]!.length < 80 ? m[1]! : null;
}

/** Все исполнители трека: из поля автора и, для заливок с YouTube/SoundCloud, из «Исполнитель - Название». */
export function trackArtists(info: InfoLike): string[] {
  const names = splitArtists(info.author ?? "");
  if (info.sourceName !== "spotify" && info.sourceName !== "applemusic") {
    const fromTitle = titleArtist(info.title ?? "");
    if (fromTitle) names.push(...splitArtists(fromTitle));
  }
  return names;
}

/**
 * Главный исполнитель — тот, кого убираем по кнопке. У заливок вроде «Rap Hits — MiyaGi - Тамада»
 * автор — канал, поэтому исполнителя из названия берём первым.
 */
export function mainArtist(info: InfoLike): string {
  if (info.sourceName !== "spotify" && info.sourceName !== "applemusic") {
    const fromTitle = titleArtist(info.title ?? "");
    const first = fromTitle ? splitArtists(fromTitle)[0] : undefined;
    if (first) return first;
  }
  return splitArtists(info.author ?? "")[0] ?? (info.author ?? "").trim();
}

export const artistKey = (name: string) => fold(name);

export class AutoplayTaste {
  private file: JsonFile<TasteFile>;
  private data: TasteFile;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    this.file = new JsonFile(join(dataDir, "autoplay.json"), () => ({ banned: {}, skips: {}, spotify: {} }));
    const d = this.file.read();
    this.data = { banned: d.banned ?? {}, skips: d.skips ?? {}, spotify: d.spotify ?? {} };
    const old = Date.now() - SKIP_MEMORY_MS;
    for (const [k, s] of Object.entries(this.data.skips)) if (s.at < old) delete this.data.skips[k];
  }

  private save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 5_000);
    this.saveTimer.unref();
  }

  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.file.write(this.data);
  }

  /* ------------------------------ бан вручную ----------------------------- */

  ban(name: string, by: string): string {
    const key = artistKey(name);
    this.data.banned[key] = { name, at: Date.now(), by };
    this.save();
    return key;
  }

  unban(key: string): string | null {
    // Ключ мог быть обрезан до лимита customId в Discord.
    if (!(key in this.data.banned) && !(key in this.data.skips)) {
      key = [...Object.keys(this.data.banned), ...Object.keys(this.data.skips)].find((k) => k.startsWith(key)) ?? key;
    }
    const name = this.data.banned[key]?.name ?? this.data.skips[key]?.name ?? null;
    const had = key in this.data.banned || key in this.data.skips;
    delete this.data.banned[key];
    delete this.data.skips[key];
    if (had) this.save();
    return name;
  }

  /** Кого автоплей сейчас не ставит: убранные вручную и проскипанные. */
  blockedList(): { key: string; name: string; why: BlockReason["why"]; at: number }[] {
    const out: { key: string; name: string; why: BlockReason["why"]; at: number }[] = Object.entries(this.data.banned).map(([key, b]) => ({ key, name: b.name, why: "ban", at: b.at }));
    for (const [key, s] of Object.entries(this.data.skips)) {
      if (s.n >= SKIPS_TO_BLOCK && !(key in this.data.banned)) out.push({ key, name: s.name, why: "skips", at: s.at });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /* -------------------------------- скипы -------------------------------- */

  /** Человек пропустил автоплейный трек в первые секунды. true — артист только что выпал из автоплея. */
  quickSkip(info: InfoLike): { name: string; blocked: boolean } {
    const name = mainArtist(info);
    const key = artistKey(name);
    if (!key || key in this.data.banned) return { name, blocked: false };
    const now = Date.now();
    const prev = this.data.skips[key];
    const n = prev && now - prev.at < SKIP_MEMORY_MS ? prev.n + 1 : 1;
    this.data.skips[key] = { name, n, at: now };
    this.save();
    return { name, blocked: n === SKIPS_TO_BLOCK };
  }

  /** Человек сам включил трек артиста — значит, артист нужен: забываем его скипы (но не ручной бан). */
  humanPlayed(info: InfoLike) {
    let changed = false;
    for (const a of trackArtists(info)) {
      const key = artistKey(a);
      if (key in this.data.skips) {
        delete this.data.skips[key];
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /** Сколько раз артиста быстро скипали (для штрафа в подборе), 0 — ни разу. */
  skipCount(name: string): number {
    return this.data.skips[artistKey(name)]?.n ?? 0;
  }

  /** Почему трек нельзя ставить в автоплей; null — можно. */
  blocked(info: InfoLike): BlockReason | null {
    for (const a of trackArtists(info)) {
      const key = artistKey(a);
      const ban = this.data.banned[key];
      if (ban) return { name: ban.name, why: "ban" };
      const s = this.data.skips[key];
      if (s && s.n >= SKIPS_TO_BLOCK) return { name: s.name, why: "skips" };
    }
    return null;
  }

  /* ------------------------- соответствия в Spotify ------------------------ */

  /** undefined — ещё не искали; null — не нашёлся (недавно). */
  spotifyId(key: string): string | null | undefined {
    const ref = this.data.spotify[key];
    if (!ref) return undefined;
    if (ref.id === null && Date.now() - ref.at > MISS_TTL_MS) return undefined;
    return ref.id;
  }

  setSpotifyId(key: string, id: string | null) {
    this.data.spotify[key] = { id, at: Date.now() };
    const keys = Object.keys(this.data.spotify);
    if (keys.length > MAX_SPOTIFY_IDS) {
      keys.sort((a, b) => this.data.spotify[a]!.at - this.data.spotify[b]!.at);
      for (const k of keys.slice(0, keys.length - MAX_SPOTIFY_IDS)) delete this.data.spotify[k];
    }
    this.save();
  }
}
