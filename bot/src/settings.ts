import { EventEmitter } from "node:events";
import { join } from "node:path";
import { z } from "zod";
import { SEARCH_SOURCE_KEYS } from "./sources.js";
import { JsonFile } from "./store.js";

const snowflake = z.string().regex(/^\d{17,20}$/);

export const settingsSchema = z.object({
  /** Громкость нового плеера, % */
  defaultVolume: z.number().int().min(1).max(150).default(60),
  /** Шаг кнопок громкости в мини-плеере, % */
  volumeStep: z.number().int().min(1).max(50).default(10),
  /** Потолок громкости, % */
  maxVolume: z.number().int().min(10).max(200).default(150),
  /** Где искать, если ввели название */
  defaultSource: z.enum(SEARCH_SOURCE_KEYS as [string, ...string[]]).default("ytm"),
  /** Похожие треки, когда очередь закончилась */
  autoplay: z.boolean().default(true),
  /** Режим 24/7: не выходить из канала */
  stay247: z.boolean().default(false),
  /** Голосовой канал для 24/7 (бот зайдёт сам после перезапуска) */
  stay247ChannelId: snowflake.nullable().default(null),
  /** Текстовый канал для мини-плеера; null — где вызвали команду */
  musicTextChannelId: snowflake.nullable().default(null),
  /** Выходить через N секунд после конца очереди (0 — сразу) */
  leaveOnQueueEndSec: z.number().int().min(0).max(3600).default(180),
  /** Выходить через N секунд, если в канале никого (0 — сразу) */
  leaveOnEmptyChannelSec: z.number().int().min(0).max(3600).default(60),
  /** Пауза, когда все вышли из канала */
  pauseOnEmptyChannel: z.boolean().default(true),
  /** Лимит очереди */
  maxQueueSize: z.number().int().min(10).max(5000).default(1000),
  /** Сколько треков максимум брать из одного плейлиста */
  maxPlaylistTracks: z.number().int().min(1).max(2000).default(500),
  /** Максимальная длина трека в минутах (0 — без ограничений) */
  maxTrackMinutes: z.number().int().min(0).max(1440).default(0),
  /** Цвет полосы мини-плеера */
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#D4783A"),
  /** Как часто обновлять прогресс в мини-плеере, сек */
  playerRefreshSec: z.number().int().min(5).max(60).default(10),
  /** Показывать список «Дальше» в мини-плеере */
  showUpNext: z.boolean().default(false),
  /** Показывать играющий трек в статусе голосового канала */
  voiceStatus: z.boolean().default(true),
  /** Публиковать итоги месяца 1-го числа в 12:00 МСК */
  wrappedAuto: z.boolean().default(true),
  /** Канал для итогов месяца; null — канал мини-плеера */
  wrappedChannelId: snowflake.nullable().default(null),
  /** Вебхук Discord для уведомлений о сбоях */
  alertWebhookUrl: z.url().nullable().default(null),
});

export type Settings = z.infer<typeof settingsSchema>;
export const settingsPatchSchema = settingsSchema.partial();

export class SettingsStore extends EventEmitter<{ change: [Settings, Partial<Settings>] }> {
  private file: JsonFile<unknown>;
  private current: Settings;

  constructor(dataDir: string) {
    super();
    this.file = new JsonFile<unknown>(join(dataDir, "settings.json"), () => ({}));
    const raw = this.file.read();
    const parsed = settingsSchema.safeParse(raw);
    // Битый или старый файл не должен ронять бота: берём что можно, остальное по умолчанию.
    this.current = parsed.success ? parsed.data : settingsSchema.parse(this.salvage(raw));
    this.file.write(this.current);
  }

  get(): Settings {
    return this.current;
  }

  update(patch: Partial<Settings>): Settings {
    const next = settingsSchema.parse({ ...this.current, ...patch });
    this.current = next;
    this.file.write(next);
    this.emit("change", next, patch);
    return next;
  }

  private salvage(raw: unknown): Record<string, unknown> {
    if (!raw || typeof raw !== "object") return {};
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      const field = settingsSchema.shape[key as keyof Settings];
      if (field && field.safeParse(value).success) result[key] = value;
    }
    return result;
  }
}
