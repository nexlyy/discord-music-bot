import { EmbedBuilder, Team, User, type Client } from "discord.js";
import type { Config } from "./config.js";
import { createLogger } from "./logger.js";
import { isYoutubeAuthError } from "./music/errors.js";
import type { MusicService } from "./music/service.js";
import type { SettingsStore } from "./settings.js";

const log = createLogger("monitor");
const COLORS = { info: 0x22c55e, warn: 0xf59e0b, error: 0xef4444 } as const;
type Level = keyof typeof COLORS;

/** Сколько пропущенных треков за полчаса считаем поломкой, о которой надо сообщить. */
const FAILURES_ALERT = 6;
const FAILURES_WINDOW = 30 * 60_000;

/**
 * Уведомления о сбоях: в личку владельцу бота (владелец приложения в Discord Developer Portal
 * или ALERT_USER_IDS) и, если задан, на вебхук. В личку идут только проблемы и их исправление,
 * обычные запуски после обновлений — нет.
 */
export class Alerts {
  private sentAt = new Map<string, number>();
  private nodeDownTimer: NodeJS.Timeout | null = null;
  private nodeDownAlerted = false;
  private failures: number[] = [];
  private client: Client | null = null;
  private recipients: string[] = [];

  constructor(
    private readonly config: Config,
    private readonly settings: SettingsStore,
  ) {}

  /** Подключить личные сообщения: получатели — из ALERT_USER_IDS или владелец приложения. */
  async useDiscord(client: Client) {
    this.client = client;
    if (this.config.ALERT_USER_IDS.length > 0) {
      this.recipients = this.config.ALERT_USER_IDS;
    } else {
      const app = await client.application?.fetch().catch(() => null);
      const owner = app?.owner;
      if (owner instanceof User) this.recipients = [owner.id];
      else if (owner instanceof Team && owner.ownerId) this.recipients = [owner.ownerId];
    }
    log.info(this.recipients.length ? `Уведомления в личку: ${this.recipients.join(", ")}` : "Не нашёл, кому слать уведомления в личку");
  }

  private url(): string | null {
    return this.settings.get().alertWebhookUrl ?? this.config.ALERT_WEBHOOK_URL ?? null;
  }

  /**
   * dm: слать ли в личку. По умолчанию — для предупреждений и ошибок; информационные (запуск, тест) — только на вебхук,
   * если не сказано иначе.
   */
  async send(key: string, level: Level, title: string, description: string, cooldownMs = 10 * 60_000, dm = level !== "info") {
    const last = this.sentAt.get(key) ?? 0;
    if (Date.now() - last < cooldownMs) return;
    this.sentAt.set(key, Date.now());
    const text = description.slice(0, 3900);
    await Promise.all([dm ? this.sendDm(level, title, text) : Promise.resolve(), this.sendWebhook(level, title, text)]);
  }

  private async sendDm(level: Level, title: string, description: string) {
    if (!this.client?.isReady()) return;
    const embed = new EmbedBuilder().setTitle(title).setDescription(description).setColor(COLORS[level]).setTimestamp(new Date());
    for (const id of this.recipients) {
      try {
        const user = await this.client.users.fetch(id);
        await user.send({ embeds: [embed] });
      } catch (e) {
        log.warn(`Не удалось написать в личку ${id}:`, e instanceof Error ? e.message : e);
      }
    }
  }

  private async sendWebhook(level: Level, title: string, description: string) {
    const url = this.url();
    if (!url) return;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "Music Bot · мониторинг",
          embeds: [{ title, description, color: COLORS[level], timestamp: new Date().toISOString() }],
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
    await this.send("test", "info", "🔔 Тестовое уведомление", "Если ты это видишь — мониторинг настроен.", 0, true);
  }

  attach(music: MusicService) {
    music.on("nodeDown", (_node, reason) => {
      if (this.nodeDownTimer) return;
      // Короткие обрывы (перезапуск, обновление плагина) не тревожат — ждём 45 с.
      this.nodeDownTimer = setTimeout(() => {
        this.nodeDownAlerted = true;
        void this.send(
          "node-down",
          "error",
          "🔴 Музыка не играет: аудиосервер недоступен",
          `Lavalink не отвечает больше 45 секунд, Артуры молчат.\nПричина: ${reason || "неизвестна"}\n\nОбычно он поднимается сам за минуту-две. Если не поднялся — напиши Claude.`,
          30 * 60_000,
        );
      }, 45_000);
    });
    music.on("nodeUp", () => {
      if (this.nodeDownTimer) clearTimeout(this.nodeDownTimer);
      this.nodeDownTimer = null;
      if (this.nodeDownAlerted) {
        this.nodeDownAlerted = false;
        this.sentAt.delete("node-down");
        void this.send("node-up", "info", "🟢 Музыка снова работает", "Связь с аудиосервером восстановлена.", 0, true);
      }
    });
    music.on("trackError", (message, track) => {
      if (isYoutubeAuthError(message)) {
        void this.send(
          "yt-auth",
          "warn",
          "🟠 YouTube просит вход",
          "Треки с YouTube перестали воспроизводиться: вход в аккаунт YouTube на сервере слетел или аккаунт ограничен.\nНужно заново привязать аккаунт (`scripts/youtube-login.sh`, см. README) — попроси Claude.",
          60 * 60_000,
        );
        return;
      }
      // Сюда попадают только треки, для которых не нашлось и замены, — значит, что-то сломалось всерьёз.
      const now = Date.now();
      this.failures = this.failures.filter((t) => now - t < FAILURES_WINDOW);
      this.failures.push(now);
      if (this.failures.length >= FAILURES_ALERT) {
        const name = track ? `${track.info.author} — ${track.info.title}` : "неизвестно";
        void this.send(
          "track-failures",
          "warn",
          "🟠 Треки часто не включаются",
          `За последние 30 минут не удалось включить ${this.failures.length} треков — даже через запасной источник.\nПоследний: ${name}\nОшибка: ${message}`,
          3 * 60 * 60_000,
        );
      }
    });
  }
}
