import type { Client, Message, SendableChannels } from "discord.js";
import { createLogger } from "../logger.js";
import type { MusicService } from "../music/service.js";
import type { UpdateReason } from "../music/types.js";
import type { SettingsStore } from "../settings.js";
import { buildPlayerMessage } from "./player-view.js";

const log = createLogger("player-msg");

/** Держит одно живое сообщение мини-плеера и обновляет его по событиям и по таймеру. */
export class PlayerMessage {
  private message: Message | null = null;
  private lastJson = "";
  private debounce: NodeJS.Timeout | null = null;
  private ticker: NodeJS.Timeout | null = null;
  private busy: Promise<void> = Promise.resolve();
  private resendNext = false;

  constructor(
    private readonly client: Client,
    private readonly music: MusicService,
    private readonly settings: SettingsStore,
  ) {
    music.on("update", (reason) => this.onUpdate(reason));
    settings.on("change", (_s, patch) => {
      if ("playerRefreshSec" in patch) this.restartTicker();
      if ("musicTextChannelId" in patch) this.resendNext = true;
      this.onUpdate("settings");
    });
    this.restartTicker();
  }

  private restartTicker() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = setInterval(() => {
      const p = this.music.player;
      if (p?.queue.current && p.playing && !p.paused) this.enqueue(() => this.render(false));
    }, this.settings.get().playerRefreshSec * 1000);
  }

  private onUpdate(reason: UpdateReason) {
    if (reason === "destroy") {
      this.enqueue(() => this.remove());
      return;
    }
    if (reason === "trackStart") this.resendNext = true;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      const resend = this.resendNext;
      this.resendNext = false;
      this.enqueue(() => this.render(resend));
    }, reason === "trackStart" ? 150 : 400);
  }

  /** Все операции с сообщением последовательно, чтобы не плодить дубликаты. */
  private enqueue(task: () => Promise<void>) {
    this.busy = this.busy.then(task).catch((e) => log.warn("Ошибка обновления мини-плеера:", e));
  }

  /** Отправить плеер заново внизу канала (например, по команде /nowplaying). */
  bump() {
    this.resendNext = false;
    this.enqueue(() => this.render(true));
  }

  private async channel(): Promise<SendableChannels | null> {
    const id = this.settings.get().musicTextChannelId ?? this.music.player?.textChannelId;
    if (!id) return null;
    const ch = this.client.channels.cache.get(id) ?? (await this.client.channels.fetch(id).catch(() => null));
    return ch && ch.isSendable() ? ch : null;
  }

  private async render(resend: boolean) {
    const player = this.music.player;
    if (!player) return;
    const channel = await this.channel();
    if (!channel) return;

    const payload = buildPlayerMessage(this.music.snapshot(), this.settings.get());
    const json = JSON.stringify(payload.components.map((c) => c.toJSON()));

    if (this.message && this.message.channelId !== channel.id) resend = true;

    if (this.message && !resend) {
      if (json === this.lastJson) return;
      try {
        await this.message.edit({ components: payload.components, flags: payload.flags });
        this.lastJson = json;
        return;
      } catch {
        this.message = null; // сообщение удалили — отправим новое
      }
    }

    if (this.message) await this.message.delete().catch(() => undefined);
    this.message = await channel.send(payload);
    this.lastJson = json;
  }

  private async remove() {
    if (!this.message) return;
    await this.message.delete().catch(() => undefined);
    this.message = null;
    this.lastJson = "";
  }

  isPlayerMessage(messageId: string): boolean {
    return this.message?.id === messageId;
  }
}
