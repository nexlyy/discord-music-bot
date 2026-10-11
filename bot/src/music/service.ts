import { EventEmitter } from "node:events";
import type { Client, VoiceState } from "discord.js";
import {
  LavalinkManager,
  type LavalinkNode,
  type Player,
  type RepeatMode,
  type SearchResult,
  type Track,
  type UnresolvedTrack,
} from "lavalink-client";
import type { Config } from "../config.js";
import { createLogger } from "../logger.js";
import type { SettingsStore } from "../settings.js";
import {
  MANAGER_LABELS,
  SEARCH_SOURCES,
  isUrl,
  managerForUrl,
  type SearchSourceKey,
} from "../sources.js";
import { humanizeLoadError, isYoutubeAuthError } from "./errors.js";
import {
  MusicError,
  toTrackView,
  type PlayerSnapshot,
  type Requester,
  type UpdateReason,
} from "./types.js";

const log = createLogger("music");

export const EFFECTS = {
  bass: "Усиление басов",
  nightcore: "Nightcore",
  vaporwave: "Vaporwave",
  rotation: "8D-звук",
  karaoke: "Караоке (без вокала)",
  tremolo: "Тремоло",
  lowPass: "Приглушённый звук",
} as const;
export type EffectKey = keyof typeof EFFECTS;

function shuffleInPlace<T>(arr: T[]) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
}

export interface PlayRequest {
  query: string;
  source?: SearchSourceKey;
  /** Готовый трек из кэша автодополнения — без повторного поиска */
  track?: Track;
  /** Готовый список (плейлист, чарт, радио) — без поиска */
  tracks?: Track[];
  playlistName?: string | null;
  playlistUrl?: string | null;
  /** Перемешать добавляемые треки */
  shuffle?: boolean;
  voiceChannelId: string;
  textChannelId: string | null;
  requester: Requester;
  next?: boolean;
}

export interface PlayResult {
  added: Track[];
  skipped: number;
  playlistName: string | null;
  startedNow: boolean;
  /** Позиция первого добавленного трека в очереди (1 — следующий), 0 — играет сразу */
  position: number;
}

type AutoplayFn = (player: Player, lastTrack: Track) => Promise<void>;

interface ServiceEvents {
  update: [reason: UpdateReason];
  trackError: [message: string, track: Track | UnresolvedTrack | null];
  nodeDown: [node: LavalinkNode, reason: string];
  nodeUp: [node: LavalinkNode];
}

export class MusicService extends EventEmitter<ServiceEvents> {
  readonly lavalink: LavalinkManager;
  readonly guildId: string;
  private leaveTimer: NodeJS.Timeout | null = null;
  private leaveReason: "queue" | "empty" | null = null;
  private autoPausedForEmpty = false;
  private autoplayFn: AutoplayFn | null = null;
  private trackNumber = 0;
  private shuffleOn = false;
  private originalOrder: (Track | UnresolvedTrack)[] = [];

  constructor(
    private readonly client: Client,
    config: Config,
    private readonly settings: SettingsStore,
  ) {
    super();
    this.guildId = config.DISCORD_GUILD_ID;
    this.lavalink = new LavalinkManager({
      nodes: [
        {
          id: "main",
          host: config.LAVALINK_HOST,
          port: config.LAVALINK_PORT,
          authorization: config.LAVALINK_PASSWORD,
          secure: false,
          retryAmount: Number.MAX_SAFE_INTEGER,
          retryDelay: 5_000,
          requestSignalTimeoutMS: 15_000,
        },
      ],
      sendToShard: (guildId, payload) => this.client.guilds.cache.get(guildId)?.shard?.send(payload),
      client: { id: "0", username: "music-bot" },
      autoSkip: true,
      autoSkipOnResolveError: true,
      emitNewSongsOnly: false,
      playerOptions: {
        defaultSearchPlatform: "ytmsearch",
        allowCustomSources: true,
        applyVolumeAsFilter: false,
        clientBasedPositionUpdateInterval: 250,
        volumeDecrementer: 1,
        useUnresolvedData: true,
        minAutoPlayMs: 5_000,
        maxErrorsPerTime: { threshold: 35_000, maxAmount: 5 },
        onDisconnect: { autoReconnect: false, destroyPlayer: true },
        onEmptyQueue: {
          autoPlayFunction: async (player, lastTrack) => {
            if (this.settings.get().autoplay && this.autoplayFn && lastTrack) {
              await this.autoplayFn(player, lastTrack).catch((e) => log.warn("Автоплей не сработал:", e));
            }
          },
        },
        requesterTransformer: (requester) => {
          const r = requester as Partial<Requester> & { displayAvatarURL?: () => string; globalName?: string };
          if (r && typeof r.displayAvatarURL === "function") {
            return { id: String(r.id), username: r.globalName ?? r.username ?? "?", avatar: r.displayAvatarURL() };
          }
          return r;
        },
      },
      queueOptions: { maxPreviousTracks: 50 },
    });
    this.bindEvents();
  }

  setAutoplay(fn: AutoplayFn) {
    this.autoplayFn = fn;
  }

  async init() {
    const user = this.client.user;
    if (!user) throw new Error("Клиент Discord ещё не готов");
    await this.lavalink.init({ id: user.id, username: user.username });
  }

  /* ---------------------------- состояние ---------------------------- */

  get node(): LavalinkNode | null {
    return this.lavalink.nodeManager.leastUsedNodes("playingPlayers")[0] ?? null;
  }

  get ready(): boolean {
    return this.lavalink.useable;
  }

  get player(): Player | undefined {
    return this.lavalink.getPlayer(this.guildId);
  }

  /** Подключённые в Lavalink площадки (youtube, spotify, …). */
  availableManagers(): Set<string> {
    return new Set(this.node?.info?.sourceManagers ?? []);
  }

  snapshot(): PlayerSnapshot {
    const p = this.player;
    const s = this.settings.get();
    const queue = p?.queue.tracks ?? [];
    return {
      active: Boolean(p),
      connected: Boolean(p?.connected),
      voiceChannelId: p?.voiceChannelId ?? null,
      textChannelId: p?.textChannelId ?? null,
      playing: Boolean(p?.playing),
      paused: Boolean(p?.paused),
      position: p?.queue.current ? p.position : 0,
      volume: p?.volume ?? s.defaultVolume,
      repeatMode: p?.repeatMode ?? "off",
      autoplay: s.autoplay,
      stay247: s.stay247,
      current: p?.queue.current ? toTrackView(p.queue.current) : null,
      queue: queue.map(toTrackView),
      queueDuration: queue.reduce((sum, t) => sum + (t.info.duration ?? 0), 0),
      previousCount: p?.queue.previous.length ?? 0,
      trackNumber: p?.queue.current ? this.trackNumber : 0,
      shuffle: this.shuffleOn,
      effects: Object.entries(this.effectsState()).filter(([, on]) => on).map(([k]) => k as EffectKey),
      updatedAt: Date.now(),
    };
  }

  /* ----------------------------- поиск ----------------------------- */

  async search(query: string, source: SearchSourceKey | undefined, requester: Requester): Promise<SearchResult> {
    const node = this.node;
    if (!node || !this.ready) throw new MusicError("Аудиосервер ещё запускается, попробуй через несколько секунд.");
    const trimmed = query.trim();
    if (!trimmed) throw new MusicError("Пустой запрос.");
    const managers = this.availableManagers();

    let result: SearchResult;
    if (isUrl(trimmed)) {
      const manager = managerForUrl(trimmed);
      if (manager && managers.size > 0 && !managers.has(manager)) {
        throw new MusicError(`${MANAGER_LABELS[manager] ?? manager} не подключена. Добавь токен в .env (см. README).`);
      }
      result = await node.search({ query: trimmed }, requester);
    } else {
      const key = source ?? (this.settings.get().defaultSource as SearchSourceKey);
      const src = SEARCH_SOURCES[key];
      if (managers.size > 0 && !managers.has(src.manager)) {
        throw new MusicError(`${src.label} не подключена. Выбери другую площадку или добавь токен (см. README).`);
      }
      result = await node.search({ query: trimmed, source: src.prefix }, requester);
    }

    if (result.loadType === "error") throw new MusicError(humanizeLoadError(result.exception?.message));
    if (result.loadType === "empty" || result.tracks.length === 0) throw new MusicError("Ничего не нашлось.");
    return result;
  }

  /* --------------------------- воспроизведение --------------------------- */

  async play(req: PlayRequest): Promise<PlayResult> {
    const s = this.settings.get();
    let tracks: Track[];
    let playlistName: string | null = null;

    if (req.tracks) {
      if (req.tracks.length === 0) throw new MusicError("Список треков пуст.");
      tracks = req.tracks.slice(0, s.maxPlaylistTracks);
      playlistName = req.playlistName ?? null;
      if (playlistName) {
        for (const t of tracks) t.userData = { ...(t.userData ?? {}), playlistName, playlistUrl: req.playlistUrl ?? null };
      }
    } else if (req.track) {
      tracks = [req.track];
    } else {
      const result = await this.search(req.query, req.source, req.requester);
      if (result.loadType === "playlist") {
        tracks = result.tracks.slice(0, s.maxPlaylistTracks);
        playlistName = result.playlist?.name ?? result.playlist?.title ?? "Плейлист";
        const playlistUrl = isUrl(req.query) ? req.query.trim() : null;
        for (const t of tracks) t.userData = { ...(t.userData ?? {}), playlistName, playlistUrl };
      } else {
        tracks = result.tracks.slice(0, 1);
      }
    }

    const maxMs = s.maxTrackMinutes > 0 ? s.maxTrackMinutes * 60_000 : Infinity;
    const allowed = tracks.filter((t) => t.info.isStream || (t.info.duration ?? 0) <= maxMs);
    let skipped = tracks.length - allowed.length;
    if (allowed.length === 0) {
      throw new MusicError(`Трек длиннее лимита (${s.maxTrackMinutes} мин). Лимит меняется в веб-панели.`);
    }

    const player = await this.ensurePlayer(req.voiceChannelId, req.textChannelId);
    const room = Math.max(0, s.maxQueueSize - player.queue.tracks.length);
    if (room === 0) throw new MusicError(`Очередь заполнена (${s.maxQueueSize}). Очисти её или увеличь лимит в панели.`);
    const toAdd = allowed.slice(0, room);
    skipped += allowed.length - toAdd.length;

    if (req.shuffle) shuffleInPlace(toAdd);
    const idle = !player.queue.current && !player.playing;
    const position = idle ? 0 : req.next ? 1 : player.queue.tracks.length + 1;
    if (req.next) {
      await player.queue.add(toAdd, 0);
    } else if (this.shuffleOn) {
      // Режим перемешивания: новые треки встают в случайные места очереди.
      for (const t of toAdd) await player.queue.add(t, Math.floor(Math.random() * (player.queue.tracks.length + 1)));
    } else {
      await player.queue.add(toAdd);
    }
    if (this.shuffleOn) this.originalOrder.push(...toAdd);

    if (idle) await player.play({ paused: false });
    else this.emit("update", "queue");

    return { added: toAdd, skipped, playlistName, startedNow: idle, position };
  }

  async ensurePlayer(voiceChannelId: string, textChannelId: string | null): Promise<Player> {
    if (!this.ready) throw new MusicError("Аудиосервер ещё запускается, попробуй через несколько секунд.");
    const s = this.settings.get();
    let player = this.player;

    if (player && player.voiceChannelId && player.voiceChannelId !== voiceChannelId) {
      const listeners = this.humansIn(player.voiceChannelId);
      if (player.queue.current && listeners > 0) {
        throw new MusicError(`Я уже играю в <#${player.voiceChannelId}>. Зайди туда или останови музыку командой /stop.`);
      }
      await player.changeVoiceState({ voiceChannelId, selfDeaf: true });
    }

    if (!player) {
      player = this.lavalink.createPlayer({
        guildId: this.guildId,
        voiceChannelId,
        textChannelId: s.musicTextChannelId ?? textChannelId ?? undefined,
        selfDeaf: true,
        selfMute: false,
        volume: s.defaultVolume,
        instaUpdateFiltersFix: true,
      });
    } else if (textChannelId && !s.musicTextChannelId) {
      player.textChannelId = textChannelId;
    }

    if (!player.connected) await player.connect();
    this.cancelLeave();
    return player;
  }

  private requirePlayer(): Player {
    const p = this.player;
    if (!p) throw new MusicError("Сейчас ничего не играет.");
    return p;
  }

  private requireCurrent(): Player {
    const p = this.requirePlayer();
    if (!p.queue.current) throw new MusicError("Сейчас ничего не играет.");
    return p;
  }

  async togglePause(): Promise<boolean> {
    const p = this.requireCurrent();
    if (p.paused) await p.resume();
    else await p.pause();
    this.autoPausedForEmpty = false;
    this.emit("update", "pause");
    return p.paused;
  }

  async setPaused(paused: boolean) {
    const p = this.requireCurrent();
    if (paused && !p.paused) await p.pause();
    if (!paused && p.paused) await p.resume();
    this.emit("update", "pause");
  }

  async skip(count = 1): Promise<void> {
    const p = this.requireCurrent();
    if (count > 1) {
      if (count > p.queue.tracks.length) throw new MusicError(`В очереди только ${p.queue.tracks.length}.`);
      await p.skip(count, false);
    } else if (p.queue.tracks.length > 0) {
      await p.skip(0, false);
    } else {
      // Очередь пуста: останавливаем трек, а автоплей (если включён) подхватит похожие.
      await p.stopPlaying(false, this.settings.get().autoplay);
    }
    this.emit("update", "queue");
  }

  async previous(): Promise<Track> {
    const p = this.requirePlayer();
    const prev = await p.queue.shiftPrevious();
    if (!prev) throw new MusicError("Предыдущих треков нет.");
    if (p.queue.current) await p.queue.add(p.queue.current, 0);
    await p.play({ clientTrack: prev, paused: false });
    this.emit("update", "queue");
    return prev;
  }

  /** Остановить и очистить очередь. Бот выходит из канала, если не включён 24/7. */
  async stop(): Promise<void> {
    const p = this.requirePlayer();
    if (this.settings.get().stay247) {
      await p.stopPlaying(true, false);
      await p.queue.splice(0, p.queue.tracks.length);
      this.emit("update", "queue");
    } else {
      await p.destroy("Остановлено пользователем");
    }
  }

  async leave(): Promise<void> {
    const p = this.requirePlayer();
    await p.destroy("Выход по команде");
  }

  get shuffleEnabled(): boolean {
    return this.shuffleOn;
  }

  /**
   * Режим перемешивания, как в Spotify: при включении очередь перемешивается, новые треки встают
   * в случайные места; при выключении возвращается исходный порядок.
   */
  async toggleShuffle(): Promise<boolean> {
    const p = this.requirePlayer();
    if (!this.shuffleOn) {
      this.originalOrder = [...p.queue.tracks];
      if (p.queue.tracks.length > 1) await p.queue.shuffle();
      this.shuffleOn = true;
    } else {
      const order = new Map(this.originalOrder.map((t, i) => [t, i]));
      const restored = [...p.queue.tracks].sort((a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity));
      await p.queue.splice(0, p.queue.tracks.length, restored);
      this.shuffleOn = false;
      this.originalOrder = [];
    }
    this.emit("update", "queue");
    return this.shuffleOn;
  }

  /* ------------------------------- эффекты ------------------------------- */

  effectsState(): Record<EffectKey, boolean> {
    const f = this.player?.filterManager;
    return {
      bass: Boolean(f && f.equalizerBands.length > 0),
      nightcore: Boolean(f?.filters.nightcore),
      vaporwave: Boolean(f?.filters.vaporwave),
      rotation: Boolean(f?.filters.rotation),
      karaoke: Boolean(f?.filters.karaoke),
      tremolo: Boolean(f?.filters.tremolo),
      lowPass: Boolean(f?.filters.lowPass),
    };
  }

  /** Переключить эффект. "off" — снять все. Возвращает новое состояние эффекта. */
  async toggleEffect(key: EffectKey | "off"): Promise<boolean> {
    const f = this.requireCurrent().filterManager;
    if (key === "off") {
      await f.resetFilters();
      if (f.equalizerBands.length) await f.clearEQ();
      this.emit("update", "settings");
      return false;
    }
    const before = this.effectsState()[key];
    switch (key) {
      case "bass":
        if (before) await f.clearEQ();
        else await f.setEQPreset("BassboostMedium");
        break;
      case "nightcore":
        await f.toggleNightcore();
        break;
      case "vaporwave":
        await f.toggleVaporwave();
        break;
      case "rotation":
        await f.toggleRotation(0.2);
        break;
      case "karaoke":
        await f.toggleKaraoke();
        break;
      case "tremolo":
        await f.toggleTremolo(4, 0.6);
        break;
      case "lowPass":
        await f.toggleLowPass(20);
        break;
    }
    this.emit("update", "settings");
    return !before;
  }

  async setRepeat(mode: RepeatMode): Promise<RepeatMode> {
    const p = this.requirePlayer();
    await p.setRepeatMode(mode);
    this.emit("update", "repeat");
    return mode;
  }

  /** Кнопка-переключатель: повторное нажатие выключает режим. */
  async toggleRepeat(mode: "queue" | "track"): Promise<RepeatMode> {
    const p = this.requirePlayer();
    return this.setRepeat(p.repeatMode === mode ? "off" : mode);
  }

  async setVolume(value: number): Promise<number> {
    const p = this.requirePlayer();
    const max = this.settings.get().maxVolume;
    const v = Math.round(Math.min(Math.max(value, 0), max));
    await p.setVolume(v);
    this.emit("update", "volume");
    return v;
  }

  async changeVolume(delta: number): Promise<number> {
    const p = this.requirePlayer();
    return this.setVolume(p.volume + delta);
  }

  async seek(ms: number): Promise<void> {
    const p = this.requireCurrent();
    const cur = p.queue.current!;
    if (!cur.info.isSeekable || cur.info.isStream) throw new MusicError("Этот трек нельзя перемотать.");
    const target = Math.min(Math.max(ms, 0), Math.max(cur.info.duration - 1000, 0));
    await p.seek(target);
    this.emit("update", "seek");
  }

  /** index — 1-based позиция в очереди. */
  async remove(index: number): Promise<Track | UnresolvedTrack> {
    const p = this.requirePlayer();
    const t = p.queue.tracks[index - 1];
    if (!t) throw new MusicError(`В очереди нет позиции ${index}.`);
    await p.queue.splice(index - 1, 1);
    this.emit("update", "queue");
    return t;
  }

  async move(from: number, to: number): Promise<Track | UnresolvedTrack> {
    const p = this.requirePlayer();
    const len = p.queue.tracks.length;
    if (from < 1 || from > len || to < 1 || to > len) throw new MusicError(`Позиции должны быть от 1 до ${len}.`);
    const t = p.queue.tracks[from - 1]!;
    await p.queue.splice(from - 1, 1);
    await p.queue.add(t, to - 1);
    this.emit("update", "queue");
    return t;
  }

  /** Перейти к треку из очереди (всё до него пропускается). */
  async jump(index: number): Promise<Track | UnresolvedTrack> {
    const p = this.requirePlayer();
    const t = p.queue.tracks[index - 1];
    if (!t) throw new MusicError(`В очереди нет позиции ${index}.`);
    if (!p.queue.current) {
      await p.queue.splice(0, index - 1);
      await p.play({ paused: false });
    } else {
      await p.skip(index, false);
    }
    this.emit("update", "queue");
    return t;
  }

  async clear(): Promise<number> {
    const p = this.requirePlayer();
    const n = p.queue.tracks.length;
    await p.queue.splice(0, n);
    this.emit("update", "queue");
    return n;
  }

  setAutoplayEnabled(enabled: boolean) {
    this.settings.update({ autoplay: enabled });
    this.emit("update", "autoplay");
  }

  /* --------------------------- выход из канала --------------------------- */

  private humansIn(channelId: string | null): number {
    if (!channelId) return 0;
    const channel = this.client.guilds.cache.get(this.guildId)?.channels.cache.get(channelId);
    if (!channel || !channel.isVoiceBased()) return 0;
    return channel.members.filter((m) => !m.user.bot).size;
  }

  private scheduleLeave(reason: "queue" | "empty", seconds: number) {
    if (this.settings.get().stay247) return;
    this.cancelLeave();
    this.leaveReason = reason;
    this.leaveTimer = setTimeout(() => {
      this.leaveTimer = null;
      const p = this.player;
      if (!p) return;
      if (reason === "queue" && p.queue.current) return;
      if (reason === "empty" && this.humansIn(p.voiceChannelId) > 0) return;
      log.info(`Выхожу из канала: ${reason === "queue" ? "очередь закончилась" : "в канале никого"}`);
      p.destroy(reason === "queue" ? "Очередь закончилась" : "В канале никого").catch((e) => log.warn(e));
    }, seconds * 1000);
  }

  private cancelLeave(reason?: "queue" | "empty") {
    if (!this.leaveTimer) return;
    if (reason && this.leaveReason !== reason) return;
    clearTimeout(this.leaveTimer);
    this.leaveTimer = null;
    this.leaveReason = null;
  }

  /** Вызывается из voiceStateUpdate Discord. */
  async handleVoiceState(oldState: VoiceState, newState: VoiceState) {
    const p = this.player;
    if (!p || newState.guild.id !== this.guildId) return;
    const botChannel = p.voiceChannelId;
    if (!botChannel) return;
    if (oldState.channelId !== botChannel && newState.channelId !== botChannel) return;

    const s = this.settings.get();
    const humans = this.humansIn(botChannel);
    if (humans === 0) {
      if (s.pauseOnEmptyChannel && p.queue.current && !p.paused) {
        await p.pause().catch(() => undefined);
        this.autoPausedForEmpty = true;
        this.emit("update", "pause");
      }
      this.scheduleLeave("empty", s.leaveOnEmptyChannelSec);
    } else {
      this.cancelLeave("empty");
      if (this.autoPausedForEmpty && p.paused) {
        await p.resume().catch(() => undefined);
        this.emit("update", "pause");
      }
      this.autoPausedForEmpty = false;
    }
  }

  /** 24/7: зайти в сохранённый канал после старта/перезапуска. */
  async ensureStay247() {
    const s = this.settings.get();
    if (!s.stay247 || !s.stay247ChannelId || !this.ready) return;
    const p = this.player;
    if (p?.connected && p.voiceChannelId === s.stay247ChannelId) return;
    if (p?.queue.current) return; // не дёргаем играющий плеер
    try {
      await this.ensurePlayer(s.stay247ChannelId, s.musicTextChannelId);
      log.info("24/7: подключился к каналу", s.stay247ChannelId);
      this.emit("update", "connect");
    } catch (e) {
      log.warn("24/7: не удалось зайти в канал:", e);
    }
  }

  /* ------------------------------- события ------------------------------- */

  private bindEvents() {
    const lm = this.lavalink;

    lm.on("trackStart", (player) => {
      this.trackNumber++;
      this.cancelLeave("queue");
      log.info(`▶ ${player.queue.current?.info.author} — ${player.queue.current?.info.title}`);
      this.emit("update", "trackStart");
    });
    lm.on("trackEnd", () => this.emit("update", "trackEnd"));
    lm.on("queueEnd", () => {
      this.emit("update", "queue");
      this.scheduleLeave("queue", this.settings.get().leaveOnQueueEndSec);
    });
    lm.on("trackError", (_player, track, payload) => {
      const raw = payload?.exception?.message ?? payload?.exception?.cause ?? "";
      const text = humanizeLoadError(raw);
      log.warn(`Ошибка трека "${track?.info?.title}": ${raw}`);
      this.emit("trackError", isYoutubeAuthError(raw) ? raw : text, track);
    });
    lm.on("trackStuck", (_player, track) => {
      log.warn(`Трек завис: ${track?.info?.title}`);
      this.emit("trackError", "Трек завис и был пропущен.", track);
    });
    lm.on("playerDestroy", (_player, reason) => {
      log.info("Плеер уничтожен:", reason ?? "");
      this.cancelLeave();
      this.autoPausedForEmpty = false;
      this.trackNumber = 0;
      this.shuffleOn = false;
      this.originalOrder = [];
      this.emit("update", "destroy");
      // В режиме 24/7 возвращаемся в канал (если нас не выгнали вручную — тогда канал сменится через настройки).
      if (this.settings.get().stay247) setTimeout(() => void this.ensureStay247(), 3_000);
    });
    lm.on("playerMove", (_player, _old, newChannel) => {
      log.info("Плеер перемещён в канал", newChannel);
      this.emit("update", "connect");
    });

    const nm = lm.nodeManager;
    nm.on("connect", (node) => log.info(`Lavalink "${node.id}" подключён`));
    nm.on("disconnect", (node, reason) => {
      log.warn(`Lavalink "${node.id}" отключился:`, reason);
      this.emit("nodeDown", node, `${reason?.code ?? ""} ${reason?.reason ?? ""}`.trim());
    });
    nm.on("error", (node, error) => log.warn(`Lavalink "${node.id}" ошибка:`, error?.message ?? error));
    nm.on("raw", (node, payload) => {
      const p = payload as { op?: string; resumed?: boolean };
      if (p?.op !== "ready") return;
      // raw приходит до того, как библиотека запишет sessionId, — откладываем на следующий тик.
      setImmediate(() => void this.onNodeReady(node, Boolean(p.resumed)));
    });
  }

  private async onNodeReady(node: LavalinkNode, resumed: boolean) {
    // Сессия переживёт короткий обрыв связи бота с Lavalink (до 60 с).
    await node.updateSession(true, 60_000).catch((e) => log.warn("updateSession:", e));
    await node.fetchInfo().then((info) => (node.info = info)).catch(() => undefined);
    log.info(`Lavalink готов (${resumed ? "сессия восстановлена" : "новая сессия"}), площадки: ${[...this.availableManagers()].join(", ")}`);
    this.emit("nodeUp", node);
    if (!resumed) await this.recoverPlayers(node);
    await this.ensureStay247();
    this.emit("update", "connect");
  }

  /** Lavalink перезапустился: плееры в памяти бота есть, на сервере их нет — пересоздаём. */
  private async recoverPlayers(node: LavalinkNode) {
    for (const player of this.lavalink.players.values()) {
      if (player.node.id !== node.id || !player.voice?.token) continue;
      const current = player.queue.current;
      const position = player.lastPosition || 0;
      try {
        await node.updatePlayer({
          guildId: player.guildId,
          playerOptions: { voice: player.voice, volume: player.lavalinkVolume },
        });
        if (current) await player.play({ clientTrack: current, position, paused: player.paused, voice: player.voice });
        log.info("Плеер восстановлен после перезапуска Lavalink");
      } catch (e) {
        log.warn("Не удалось восстановить плеер, пересоздаю:", e);
        await player.destroy("Восстановление после перезапуска Lavalink").catch(() => undefined);
      }
    }
  }
}
