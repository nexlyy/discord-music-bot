import { Events, type Client, type Message, type SendableChannels } from "discord.js";
import { createLogger } from "../logger.js";
import type { MusicService } from "../music/service.js";
import type { UpdateReason } from "../music/types.js";
import type { SettingsStore } from "../settings.js";
import { withEmojiScope } from "./emoji.js";
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
  private stickyTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly client: Client,
    private readonly music: MusicService,
    private readonly settings: SettingsStore,
  ) {
    music.on("update", (reason) => this.onUpdate(reason));
    client.on(Events.MessageCreate, (m) => this.onChannelMessage(m));
    // «Угадай трек»: плеер выдал бы ответ — убираем его на время игры и возвращаем после.
    music.on("quiet", (on) => {
      if (on) this.enqueue(() => this.remove());
    });
    settings.on("change", (_s, patch) => {
      if ("playerRefreshSec" in patch) this.restartTicker();
      if ("musicTextChannelId" in patch) this.resendNext = true;
      this.onUpdate("settings");
    });
    this.restartTicker();
  }

  /**
   * Плеер «прилипает» к низу канала: когда в канале кто-то написал, через 4 с тишины плеер
   * переезжает под новые сообщения. Канал от этого не становится «непрочитанным» сильнее —
   * его уже пометило чужое сообщение. Сообщения ботов (в том числе свои) переезд не вызывают.
   */
  private onChannelMessage(m: Message) {
    if (!this.message || m.channelId !== this.message.channelId) return;
    // Только сообщения людей: иначе два бота с «прилипающими» плеерами перепрыгивали бы друг друга бесконечно.
    if (m.author.bot || m.system) return;
    if (!this.settings.get().stickyPlayer) return;
    if (this.stickyTimer) clearTimeout(this.stickyTimer);
    this.stickyTimer = setTimeout(() => {
      this.stickyTimer = null;
      this.enqueue(() => this.render(true));
    }, 4000);
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
    // На смену трека сообщение только редактируется: новое сообщение помечало бы канал непрочитанным.
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

  /** Перерисовать плеер, даже если состояние не поменялось (например, сбросить выбор в меню). */
  refresh() {
    this.lastJson = "";
    this.enqueue(() => this.render(false));
  }

  /** Отправить плеер заново внизу канала (например, по команде /nowplaying). */
  bump() {
    this.resendNext = false;
    this.enqueue(() => this.render(true));
  }

  private async channel(): Promise<SendableChannels | null> {
    // Плеер живёт в текстовом чате того голосового канала, где играет музыка.
    const id = this.music.player?.voiceChannelId;
    if (!id) return null;
    const ch = this.client.channels.cache.get(id) ?? (await this.client.channels.fetch(id).catch(() => null));
    return ch && ch.isSendable() ? ch : null;
  }

  private async render(resend: boolean) {
    if (this.music.quietMode) return;
    const player = this.music.player;
    if (!player) return;
    const channel = await this.channel();
    if (!channel) return;

    const payload = withEmojiScope(this.client.application?.id, () => buildPlayerMessage(this.music.snapshot(), this.settings.get()));
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
