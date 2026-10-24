import { PermissionFlagsBits, type Client } from "discord.js";
import { truncate } from "../format.js";
import { createLogger } from "../logger.js";
import type { MusicService } from "../music/service.js";
import type { SettingsStore } from "../settings.js";

const log = createLogger("voice-status");

/** Статус голосового канала «🎵 Исполнитель — Трек» (виден в списке каналов). */
export class VoiceStatus {
  private last = new Map<string, string | null>();
  private timer: NodeJS.Timeout | null = null;
  private warned = false;
  private busy: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: Client,
    private readonly music: MusicService,
    private readonly settings: SettingsStore,
  ) {
    music.on("update", () => this.schedule());
    music.on("quiet", () => this.schedule());
    settings.on("change", (_s, patch) => {
      if ("voiceStatus" in patch) this.schedule();
    });
    music.beforeLeave = (channelId) => this.enqueue(() => this.set(channelId, null));
  }

  /** Состояние: что должно быть в статусе прямо сейчас. */
  private desired(): { channelId: string; status: string | null } | null {
    const p = this.music.player;
    if (!p?.voiceChannelId) return null;
    if (this.music.quietMode) return { channelId: p.voiceChannelId, status: this.settings.get().voiceStatus ? "🎮 Угадай трек" : null };
    const cur = p.queue.current;
    if (!cur || !this.settings.get().voiceStatus) return { channelId: p.voiceChannelId, status: null };
    const text = `${p.paused ? "⏸" : "🎵"} ${cur.info.author} — ${cur.info.title}`;
    return { channelId: p.voiceChannelId, status: truncate(text, 120) };
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    // Дебаунс: статус меняется не чаще раза в 1.5 с, чтобы не упираться в лимиты Discord.
    this.timer = setTimeout(() => {
      this.timer = null;
      const want = this.desired();
      if (want) void this.enqueue(() => this.set(want.channelId, want.status));
    }, 1500);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.busy = this.busy.then(task).catch((e) => log.debug(e));
    return this.busy;
  }

  private async set(channelId: string, status: string | null) {
    if ((this.last.get(channelId) ?? null) === status) return;
    const channel = this.client.channels.cache.get(channelId);
    const me = channel && "guild" in channel ? channel.guild.members.me : null;
    if (!channel || !me || !channel.isVoiceBased() || !channel.permissionsFor(me)?.has(PermissionFlagsBits.SetVoiceChannelStatus)) {
      if (!this.warned) {
        log.warn("Нет права «Установить статус голосового канала» — статус с треком не показывается. Выдай право роли бота.");
        this.warned = true;
      }
      return;
    }
    try {
      await this.client.rest.put(`/channels/${channelId}/voice-status`, { body: { status } });
      this.last.set(channelId, status);
    } catch (e) {
      log.warn("Не удалось обновить статус канала:", e instanceof Error ? e.message : e);
    }
  }
}
