import { join } from "node:path";
import type { LavalinkManager, Player, Track, UnresolvedTrack } from "lavalink-client";
import { splitArtists } from "../library/history.js";
import { trackKey } from "../library/stored-track.js";
import { createLogger } from "../logger.js";
import { JsonFile } from "../store.js";
import { scFind, streamUrl } from "./soundcloud.js";

/**
 * Запасной источник. Треки из Spotify и Apple Music играют через копию с YouTube, и часть копий YouTube
 * не отдаёт серверу («нужен вход», ограничение по возрасту). Раньше такой трек просто пропускался.
 * Теперь на его место встаёт «отложенный» трек с тем же названием и обложкой: перед стартом он находит
 * рабочую копию (SoundCloud, обычный поиск YouTube), а найденная копия запоминается — в следующий раз
 * она подхватывается сразу, без поиска.
 */

const log = createLogger("fallback");

/** Сколько замен пробуем для одного трека, прежде чем сдаться и пропустить его. */
const MAX_ATTEMPTS = 3;
/** Через сколько забываем неудачные попытки (вдруг копия на YouTube снова заработает). */
const ATTEMPTS_TTL = 15 * 60_000;
const MAX_CACHE = 2000;

type Via = "sc" | "yt" | "ytm" | "cache";

/** Пометка на треке-замене: что он заменяет и откуда взят. */
export interface FallbackMark {
  key: string;
  via: Via;
  /** Кандидат, из которого сделана замена: "sc:123", "youtube:abc" */
  id: string;
  cached?: boolean;
}

interface Mirror {
  encoded: string;
  duration: number;
  seekable: boolean;
  via: Via;
  id: string;
  at: number;
}

interface Attempts {
  n: number;
  tried: Set<string>;
  at: number;
}

interface Candidate {
  id: string;
  title: string;
  author: string;
  duration: number;
  load: () => Promise<Track | null>;
}

type Info = Track["info"];

/** Версии трека, которые не подходят как замена оригиналу. */
const VARIANT =
  /\b(slowed|reverb|sped ?up|speed ?up|nightcore|remix|cover|instrumental|karaoke|8d|bass ?boost(ed)?|live|mashup|acapella|a cappella)\b|ремикс|кавер|минус|замедл|ускор|караоке/i;

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** "так похуй (prod. X)" → "так похуй"; "Song - Remastered 2011" → "song". */
function baseTitle(title: string): string {
  return norm(title.replace(/\s*[([][^)\]]*[)\]]/g, " ").replace(/\s+-\s+.*$/, "")) || norm(title);
}

const CYR: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "zh", з: "z", и: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p",
  р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "i", ь: "", э: "e", ю: "iu", я: "ia",
};

/**
 * Для сравнения: кириллица в латиницу и сглаживание разных транслитов — «Валентин Стрыкало» = «Valentin Strykalo»,
 * «Пошлая Молли» = «Poshlaya Molly». В Spotify исполнитель часто записан латиницей, а на SoundCloud и YouTube — кириллицей.
 */
function fold(s: string): string {
  return norm(s)
    .replace(/[а-я]/g, (c) => CYR[c] ?? c)
    .replace(/kh/g, "h")
    .replace(/y/g, "i")
    .replace(/(.)\1+/g, "$1");
}

/** Насколько кандидат похож на оригинал; null — точно не он. */
export function matchScore(orig: Pick<Info, "title" | "author" | "duration">, cand: Pick<Candidate, "title" | "author" | "duration">): number | null {
  const text = ` ${fold(`${cand.author} ${cand.title}`)} `;
  const words = fold(baseTitle(orig.title)).split(" ").filter(Boolean);
  if (words.length === 0) return null;
  const hits = words.filter((w) => text.includes(` ${w} `)).length;
  if (hits < words.length && !(words.length >= 4 && hits / words.length >= 0.75)) return null;
  if (VARIANT.test(cand.title) && !VARIANT.test(orig.title)) return null;

  // Исполнитель должен где-то встретиться: в имени автора или в названии залитого трека.
  const artists = splitArtists(orig.author).map(fold).filter(Boolean);
  if (artists.length > 0 && !artists.some((a) => text.includes(` ${a} `))) return null;

  let score = 1;
  if (orig.duration > 0 && cand.duration > 0) {
    const tolerance = Math.max(10_000, orig.duration * 0.1);
    const diff = Math.abs(cand.duration - orig.duration);
    if (diff > tolerance) return null;
    score += 1 - diff / tolerance;
  }
  const want = fold(baseTitle(orig.title));
  const got = fold(cand.title);
  if (got === want || got.endsWith(` ${want}`)) score += 0.5;
  return score;
}

export class TrackFallback {
  private file: JsonFile<Record<string, Mirror>>;
  private cache: Record<string, Mirror>;
  private attempts = new Map<string, Attempts>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    this.file = new JsonFile(join(dataDir, "mirrors.json"), () => ({}));
    this.cache = this.file.read();
  }

  get size() {
    return Object.keys(this.cache).length;
  }

  /**
   * Трек не загрузился: синхронно ставим на его место замену (найдётся перед стартом).
   * Вызывается из обработчика ошибки трека, до того как библиотека перейдёт к следующему.
   * false — замен больше не пробуем, трек будет пропущен.
   */
  plan(player: Player, failed: Track, lavalink: LavalinkManager): boolean {
    const key = trackKey(failed);
    const mark = failed.userData?.fallback as FallbackMark | undefined;
    let state = this.attempts.get(key);
    if (!state || Date.now() - state.at > ATTEMPTS_TTL) state = { n: 0, tried: new Set(), at: Date.now() };
    if (failed.info.sourceName === "youtube") state.tried.add(`youtube:${failed.info.identifier}`);
    if (mark) {
      state.tried.add(mark.id);
      if (mark.cached) this.forget(key);
    }
    if (state.n >= MAX_ATTEMPTS) {
      this.attempts.delete(key);
      log.warn(`Не нашёл рабочую копию: ${failed.info.author} — ${failed.info.title}`);
      return false;
    }
    state.n++;
    state.at = Date.now();
    this.attempts.set(key, state);

    player.queue.tracks.unshift(this.placeholder(failed, key, state, lavalink));
    void player.queue.utils.save();
    return true;
  }

  /** Замена доиграла (или её переключили уже после старта) — запоминаем её для этого трека. */
  confirm(track: Track | UnresolvedTrack | null | undefined) {
    const mark = track?.userData?.fallback as FallbackMark | undefined;
    if (!mark || mark.cached || !track?.encoded) return;
    this.attempts.delete(mark.key);
    this.cache[mark.key] = {
      encoded: track.encoded,
      duration: track.info.duration ?? 0,
      seekable: Boolean(track.info.isSeekable),
      via: mark.via,
      id: mark.id,
      at: Date.now(),
    };
    mark.cached = true;
    const keys = Object.keys(this.cache);
    if (keys.length > MAX_CACHE) {
      for (const k of keys.sort((a, b) => this.cache[a]!.at - this.cache[b]!.at).slice(0, keys.length - MAX_CACHE)) delete this.cache[k];
    }
    this.save();
  }

  private forget(key: string) {
    if (!(key in this.cache)) return;
    delete this.cache[key];
    this.save();
  }

  private save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 3000);
  }

  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.file.write(this.cache);
  }

  /** «Отложенный» трек с тем же видом, что и упавший: библиотека вызовет resolve() прямо перед стартом. */
  private placeholder(failed: Track, key: string, state: Attempts, lavalink: LavalinkManager): UnresolvedTrack {
    const ph = lavalink.utils.buildUnresolvedTrack({ ...failed.info }, failed.requester) as UnresolvedTrack;
    const { fallback: _old, ...userData } = (failed.userData ?? {}) as NonNullable<Track["userData"]>;
    ph.userData = userData;
    ph.pluginInfo = failed.pluginInfo;
    const self = this;
    ph.resolve = async function (this: UnresolvedTrack, player: Player) {
      const found = await self.resolveFor(player, failed, key, state, lavalink);
      if (!found) {
        // Без этого библиотека оставила бы текущим упавший оригинал и запустила его снова.
        // Пустой текущий трек — и она переходит к следующему в очереди (или к автоплею).
        player.queue.current = null;
        self.attempts.delete(key);
        throw new Error(`Нет рабочей копии: ${failed.info.author} — ${failed.info.title}`);
      }
      // Превращаем этот объект в готовый трек — так же, как это делает сама библиотека.
      const target = this as unknown as Record<PropertyKey, unknown>;
      for (const prop of Object.getOwnPropertyNames(target)) delete target[prop];
      for (const sym of Object.getOwnPropertySymbols(target)) delete target[sym];
      Object.assign(this, found);
    } as UnresolvedTrack["resolve"];
    return ph;
  }

  private async resolveFor(player: Player, failed: Track, key: string, state: Attempts, lavalink: LavalinkManager): Promise<Track | null> {
    const build = (encoded: string, duration: number, seekable: boolean, mark: FallbackMark) =>
      lavalink.utils.buildTrack(
        {
          encoded,
          info: { ...failed.info, duration: duration || failed.info.duration, isSeekable: seekable, isStream: false },
          pluginInfo: failed.pluginInfo ?? {},
          // retryStart: это тот же трек, что уже «начался», — в историю и счётчик треков второй раз не идёт.
          userData: { ...(failed.userData ?? {}), fallback: mark, retryStart: true },
        } as unknown as Track,
        failed.requester,
      );

    const cached = this.cache[key];
    if (cached && !state.tried.has(cached.id)) {
      log.info(`Замена из памяти: ${failed.info.author} — ${failed.info.title} (${cached.id})`);
      return build(cached.encoded, cached.duration, cached.seekable, { key, via: cached.via, id: cached.id, cached: true });
    }

    const started = Date.now();
    const found = await this.find(player, failed, state.tried).catch((e) => {
      log.warn("Поиск замены не удался:", e);
      return null;
    });
    if (!found) return null;
    log.info(`Замена за ${Date.now() - started} мс: ${failed.info.author} — ${failed.info.title} → ${found.via} ${found.id}`);
    return build(found.track.encoded!, found.track.info.duration, Boolean(found.track.info.isSeekable), { key, via: found.via, id: found.id });
  }

  private async find(player: Player, failed: Track, tried: Set<string>): Promise<{ track: Track; via: Via; id: string } | null> {
    const info = failed.info;
    const query = `${splitArtists(info.author)[0] ?? info.author} ${baseTitle(info.title)}`.trim();
    // Что упало с SoundCloud — ищем на YouTube Music; остальное (копии с YouTube) — сначала на SoundCloud.
    const source = info.sourceName as string;
    const order: Via[] = source === "http" || source === "soundcloud" ? ["ytm", "yt"] : ["sc", "yt"];
    for (const via of order) {
      const list = await this.candidates(player, via, query, failed.requester).catch(() => [] as Candidate[]);
      const ranked = list
        .filter((c) => !tried.has(c.id))
        .map((c) => ({ c, s: matchScore(info, c) }))
        .filter((x): x is { c: Candidate; s: number } => x.s !== null)
        .sort((a, b) => b.s - a.s);
      for (const { c } of ranked.slice(0, 2)) {
        const track = await c.load().catch(() => null);
        if (track?.encoded) return { track, via, id: c.id };
        tried.add(c.id);
      }
    }
    return null;
  }

  private async candidates(player: Player, via: Via, query: string, requester: unknown): Promise<Candidate[]> {
    if (via === "sc") {
      const list = await scFind(query);
      return list.map((t) => ({
        id: `sc:${t.id}`,
        title: t.title,
        author: t.artist,
        duration: t.duration,
        // Lavalink загружает трек с моста как обычный http-файл.
        load: async () => (await player.node.search({ query: streamUrl(t) }, requester)).tracks[0] ?? null,
      }));
    }
    const res = await player.node.search({ query, source: via === "ytm" ? "ytmsearch" : "ytsearch" }, requester);
    return res.tracks.slice(0, 10).map((t) => ({
      id: `${t.info.sourceName}:${t.info.identifier}`,
      title: t.info.title,
      author: t.info.author,
      duration: t.info.duration,
      load: async () => t,
    }));
  }
}
