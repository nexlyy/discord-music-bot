import type { Config } from "./config.js";
import { createLogger } from "./logger.js";
import { isYoutubeAuthError } from "./music/errors.js";
import type { MusicService } from "./music/service.js";
import type { SettingsStore } from "./settings.js";

const log = createLogger("monitor");
const COLORS = { info: 0x22c55e, warn: 0xf59e0b, error: 0xef4444 } as const;

/** Уведомления о сбоях в Discord через вебхук (адрес — в веб-панели или ALERT_WEBHOOK_URL). */
export class Alerts {
  private sentAt = new Map<string, number>();
  private nodeDownTimer: NodeJS.Timeout | null = null;
  private nodeDownAlerted = false;

  constructor(
    private readonly config: Config,
    private readonly settings: SettingsStore,
  ) {}

  private url(): string | null {
    return this.settings.get().alertWebhookUrl ?? this.config.ALERT_WEBHOOK_URL ?? null;
  }

  async send(key: string, level: keyof typeof COLORS, title: string, description: string, cooldownMs = 10 * 60_000) {
    const url = this.url();
    if (!url) return;
    const last = this.sentAt.get(key) ?? 0;
    if (Date.now() - last < cooldownMs) return;
    this.sentAt.set(key, Date.now());
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "Music Bot · мониторинг",
          embeds: [{ title, description: description.slice(0, 3900), color: COLORS[level], timestamp: new Date().toISOString() }],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) log.warn(`Вебхук ответил ${res.status}`);
    } catch (e) {
      log.warn("Не удалось отправить уведомление:", e);
    }
  }

  async test() {
    this.sentAt.delete("test");
    await this.send("test", "info", "🔔 Тестовое уведомление", "Если ты это видишь — мониторинг настроен.", 0);
  }

  attach(music: MusicService) {
    music.on("nodeDown", (_node, reason) => {
      if (this.nodeDownTimer) return;
      // Короткие обрывы (перезапуск, обновление плагина) не тревожат — ждём 45 с.
      this.nodeDownTimer = setTimeout(() => {
        this.nodeDownAlerted = true;
        void this.send("node-down", "error", "🔴 Lavalink недоступен", `Аудиосервер не отвечает больше 45 секунд.\nПричина: ${reason || "неизвестна"}`, 30 * 60_000);
      }, 45_000);
    });
    music.on("nodeUp", () => {
      if (this.nodeDownTimer) clearTimeout(this.nodeDownTimer);
      this.nodeDownTimer = null;
      if (this.nodeDownAlerted) {
        this.nodeDownAlerted = false;
        this.sentAt.delete("node-down");
        void this.send("node-up", "info", "🟢 Lavalink снова работает", "Связь с аудиосервером восстановлена.", 0);
      }
    });
    music.on("trackError", (message) => {
      if (isYoutubeAuthError(message)) {
        void this.send(
          "yt-auth",
          "warn",
          "🟠 YouTube просит вход",
          "Треки с YouTube перестали воспроизводиться: OAuth-токен недействителен или аккаунт ограничен.\nПереподключи аккаунт: `scripts/youtube-login.sh` на сервере (см. README).",
          60 * 60_000,
        );
      }
    });
  }
}
