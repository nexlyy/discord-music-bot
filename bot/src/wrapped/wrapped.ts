import { join } from "node:path";
import {
  AttachmentBuilder,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  TextDisplayBuilder,
  type Client,
} from "discord.js";
import type { Config } from "../config.js";
import { escapeMd, truncate } from "../format.js";
import { monthKey, type HistoryStore, type MonthStats } from "../library/history.js";
import { createLogger } from "../logger.js";
import type { SettingsStore } from "../settings.js";
import { JsonFile } from "../store.js";
import { hexToInt } from "../ui/player-view.js";
import { renderWrapped, type WrappedData } from "./render.js";

const log = createLogger("wrapped");
const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

export type WrappedPeriod = "month" | "last" | "all";

function previousMonthKey(key = monthKey()): string {
  const [y, m] = key.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

function periodKey(period: WrappedPeriod): string | null {
  return period === "all" ? null : period === "last" ? previousMonthKey() : monthKey();
}

function periodLabel(key: string | null): { title: string; subtitle: string; inline: string } {
  if (!key) return { title: "Всё время", subtitle: "Итоги сервера", inline: "за всё время" };
  const [y, m] = key.split("-").map(Number) as [number, number];
  return { title: `${MONTHS[m - 1]} ${y}`, subtitle: "Итоги месяца", inline: `за ${MONTHS_GEN[m - 1]} ${y}` };
}

const top = (rec: Record<string, number>, n: number) => Object.entries(rec).sort((a, b) => b[1] - a[1]).slice(0, n);

/** Итоги сервера в стиле Spotify Wrapped: картинка + короткий текст. */
export class Wrapped {
  private state: JsonFile<{ lastPosted: string | null }>;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly client: Client,
    private readonly config: Config,
    private readonly settings: SettingsStore,
    private readonly history: HistoryStore,
  ) {
    this.state = new JsonFile(join(config.DATA_DIR, "wrapped-state.json"), () => ({ lastPosted: null }));
  }

  private async person(userId: string | undefined) {
    if (!userId) return null;
    const guild = this.client.guilds.cache.get(this.config.DISCORD_GUILD_ID);
    const member = await guild?.members.fetch(userId).catch(() => null);
    if (member) return { name: member.displayName, avatar: member.displayAvatarURL({ extension: "png", size: 256 }) };
    const user = await this.client.users.fetch(userId).catch(() => null);
    return user ? { name: user.globalName ?? user.username, avatar: user.displayAvatarURL({ extension: "png", size: 256 }) } : null;
  }

  /** Собрать сообщение с итогами. null — за период нечего показать. */
  async build(period: WrappedPeriod) {
    const key = periodKey(period);
    const stats: MonthStats | null = this.history.stats(key);
    if (!stats || stats.plays === 0) return null;
    const label = periodLabel(key);
    const guild = this.client.guilds.cache.get(this.config.DISCORD_GUILD_ID);
    const accent = this.settings.get().accentColor;

    const tracks = Object.values(stats.tracks).sort((a, b) => b.plays - a.plays);
    const [listenerId, listenerSec] = top(stats.listeners, 1)[0] ?? [];
    const [djId, djPlays] = top(stats.djs, 1)[0] ?? [];
    const [listener, dj] = await Promise.all([this.person(listenerId), this.person(djId)]);

    const data: WrappedData = {
      title: label.title,
      subtitle: label.subtitle,
      guildName: guild?.name ?? "Сервер",
      guildIcon: guild?.iconURL({ extension: "png", size: 128 }) ?? null,
      accent,
      totals: {
        hours: stats.ms / 3_600_000,
        plays: stats.plays,
        tracks: tracks.length,
        artists: Object.keys(stats.artists).length,
      },
      topTracks: tracks.slice(0, 5).map((t) => ({ title: t.title, author: t.author, artworkUrl: t.artworkUrl, plays: t.plays })),
      topArtists: top(stats.artists, 6).map(([name, plays]) => ({ name, plays })),
      topListener: listener && listenerSec ? { ...listener, hours: listenerSec / 3600 } : null,
      topDj: dj && djPlays ? { ...dj, plays: djPlays } : null,
    };

    const png = await renderWrapped(data);
    const file = new AttachmentBuilder(png, { name: "wrapped.png", description: `Итоги сервера ${label.inline}` });

    const first = tracks[0];
    const lines = [
      `### 🎧 Музыкальные итоги ${label.inline}`,
      first ? `Трек периода — **${escapeMd(truncate(`${first.author} — ${first.title}`, 90))}**, ${first.plays} раз.` : "",
      listenerId ? `Больше всех слушал(а) <@${listenerId}>, а чаще всех заказывал(а) музыку <@${djId ?? listenerId}>.` : "",
      "-# Полная статистика — командой `/wrapped`.",
    ].filter(Boolean);

    const container = new ContainerBuilder()
      .setAccentColor(hexToInt(accent))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")))
      .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL("attachment://wrapped.png")));
    return { components: [container], files: [file], flags: MessageFlags.IsComponentsV2 as const };
  }

  /** Раз в 10 минут проверяем: если наступило 1-е число (после 12:00 МСК) — публикуем итоги прошлого месяца. */
  start() {
    this.timer = setInterval(() => void this.tick(), 10 * 60_000);
    setTimeout(() => void this.tick(), 60_000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    const s = this.settings.get();
    if (!s.wrappedAuto) return;
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Moscow", day: "numeric", hour: "numeric", hourCycle: "h23" }).formatToParts(now);
    const day = Number(parts.find((p) => p.type === "day")?.value);
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    if (day !== 1 || hour < 12) return;
    const target = previousMonthKey();
    if (this.state.read().lastPosted === target) return;

    const channelId = s.wrappedChannelId ?? s.musicTextChannelId;
    if (!channelId) {
      log.warn("Итоги месяца не опубликованы: не выбран канал (веб-панель → Настройки → Итоги)");
      this.state.write({ lastPosted: target });
      return;
    }
    try {
      const message = await this.build("last");
      if (message) {
        const channel = await this.client.channels.fetch(channelId);
        if (channel?.isSendable()) {
          const sent = await channel.send({ ...message, allowedMentions: { parse: [] } });
          await sent.pin().catch((e) => log.warn("Итоги опубликованы, но не закреплены — нужно право «Закреплять сообщения»:", e instanceof Error ? e.message : e));
        }
        log.info(`Итоги за ${target} опубликованы`);
      }
      this.state.write({ lastPosted: target });
    } catch (e) {
      log.warn("Не удалось опубликовать итоги месяца:", e);
    }
  }
}
