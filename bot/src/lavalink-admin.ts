import type { Config } from "./config.js";
import type { MusicService } from "./music/service.js";
import { PANEL_REQUESTER } from "./music/types.js";
import { SEARCH_SOURCES, SEARCH_SOURCE_KEYS } from "./sources.js";

/** Прямые запросы к REST Lavalink для веб-панели: статус, OAuth YouTube, проверка площадок. */
export class LavalinkAdmin {
  private readonly base: string;

  constructor(
    private readonly config: Config,
    private readonly music: MusicService,
  ) {
    this.base = `http://${config.LAVALINK_HOST}:${config.LAVALINK_PORT}`;
  }

  private async get<T>(path: string, timeoutMs = 8000): Promise<T> {
    const res = await fetch(this.base + path, {
      headers: { Authorization: this.config.LAVALINK_PASSWORD },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async status() {
    const node = this.music.node;
    const [info, stats, yt] = await Promise.all([
      this.get<{ version: { semver: string }; sourceManagers: string[]; plugins: { name: string; version: string }[] }>("/v4/info").catch(() => null),
      this.get<{ players: number; playingPlayers: number; uptime: number; memory: { used: number; allocated: number }; cpu: { lavalinkLoad: number; systemLoad: number } }>("/v4/stats").catch(() => null),
      this.get<{ refreshToken: string | null }>("/youtube").catch(() => null),
    ]);
    return {
      connected: Boolean(node?.connected),
      sessionId: node?.sessionId ?? null,
      version: info?.version.semver ?? null,
      sourceManagers: info?.sourceManagers ?? [],
      plugins: info?.plugins ?? [],
      stats,
      youtubeOauth: yt ? Boolean(yt.refreshToken) : null,
    };
  }

  /** Поиск на каждой подключённой площадке + реальное получение аудиопотока YouTube. */
  async diagnostics() {
    const managers = this.music.availableManagers();
    const probes: Record<string, string> = {
      ytm: "Кино Группа крови",
      yt: "Rick Astley Never Gonna Give You Up",
      sc: "Daft Punk Get Lucky",
      sp: "The Weeknd Blinding Lights",
      am: "Dua Lipa Levitating",
      ym: "Земфира Искала",
      vk: "Сплин Выхода нет",
    };
    const results = [];
    for (const key of SEARCH_SOURCE_KEYS) {
      const src = SEARCH_SOURCES[key];
      if (!managers.has(src.manager)) {
        results.push({ key, label: src.label, ok: false, skipped: true, ms: 0, detail: "Не подключена" });
        continue;
      }
      const started = Date.now();
      try {
        const res = await this.music.search(probes[key]!, key, PANEL_REQUESTER);
        const t = res.tracks[0]!;
        results.push({ key, label: src.label, ok: true, skipped: false, ms: Date.now() - started, detail: `${t.info.author} — ${t.info.title}` });
      } catch (e) {
        results.push({ key, label: src.label, ok: false, skipped: false, ms: Date.now() - started, detail: e instanceof Error ? e.message : String(e) });
      }
    }
    results.push(await this.youtubePlayback());
    return results;
  }

  /** Читает первые байты аудио популярного клипа — на нём YouTube чаще всего просит вход. */
  private async youtubePlayback() {
    const started = Date.now();
    const base = { key: "ytplay", label: "YouTube: воспроизведение", skipped: false };
    try {
      const res = await fetch(`${this.base}/youtube/stream/kJQP7kiw5Fk`, {
        headers: { Authorization: this.config.LAVALINK_PASSWORD, Range: "bytes=0-65535" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        return { ...base, ok: false, ms: Date.now() - started, detail: body.message ?? `HTTP ${res.status}` };
      }
      const reader = res.body?.getReader();
      const chunk = await reader?.read();
      await reader?.cancel().catch(() => undefined);
      const bytes = chunk?.value?.length ?? 0;
      return { ...base, ok: bytes > 0, ms: Date.now() - started, detail: bytes > 0 ? `Поток идёт (${res.headers.get("content-type")})` : "Пустой ответ" };
    } catch (e) {
      return { ...base, ok: false, ms: Date.now() - started, detail: e instanceof Error ? e.message : String(e) };
    }
  }
}
