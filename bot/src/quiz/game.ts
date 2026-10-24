import { randomBytes } from "node:crypto";
import {
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type GuildMember,
  type Message,
  type SendableChannels,
} from "discord.js";
import type { Player, RepeatMode, Track, UnresolvedTrack } from "lavalink-client";
import type { HistoryStore } from "../library/history.js";
import { createLogger } from "../logger.js";
import type { MusicService } from "../music/service.js";
import { MusicError } from "../music/types.js";
import type { SettingsStore } from "../settings.js";
import { startPosition, type QuizMode } from "./drop.js";
import { buildPool, options, type QuizItem } from "./pool.js";
import type { QuizStore } from "./store.js";
import { toTrackView } from "../music/types.js";
import { finalView, lobbyView, noticeView, revealView, roundView, topView, type Leader } from "./view.js";

const log = createLogger("quiz");
const REVEAL_MS = 5_000;
const LOBBY_MS = 8_000;

interface SavedPlayback {
  current: Track | null;
  position: number;
  paused: boolean;
  queue: (Track | UnresolvedTrack)[];
  repeat: RepeatMode;
}

interface PartAnswer {
  correct: boolean;
  points: number;
}

interface Round {
  item: QuizItem;
  artists: string[];
  titles: string[];
  correctArtist: number;
  correctTitle: number;
  startedAt: number;
  endsAt: number;
  answers: Map<string, { a?: PartAnswer; t?: PartAnswer }>;
  finish: () => void;
}

class QuizGame {
  readonly id = randomBytes(3).toString("hex");
  private message!: Message;
  private player!: Player;
  private saved!: SavedPlayback;
  private voiceChannelId = "";
  private startsAt = 0;
  private scores = new Map<string, Leader>();
  private round: Round | null = null;
  private phase: "lobby" | "round" | "reveal" | "ended" = "lobby";
  private stoppedBy: string | null = null;
  private aborted = false;
  private wake: (() => void) | null = null;
  private played = 0;
  private editChain: Promise<unknown> = Promise.resolve();
  private counterTimer: NodeJS.Timeout | null = null;
  private failure: string | null = null;

  constructor(
    private readonly music: MusicService,
    private readonly history: HistoryStore,
    private readonly settings: SettingsStore,
    private readonly store: QuizStore,
    readonly mode: QuizMode,
    readonly rounds: number,
    /** Сколько звучит фрагмент, мс */
    readonly roundMs: number,
  ) {}

  /** После старта фрагмента трек должен доиграть раунд и показ ответа. */
  private get tailMs() {
    return this.roundMs + REVEAL_MS + 3_000;
  }

  private get accent() {
    return this.settings.get().accentColor;
  }

  private leaders(): Leader[] {
    return [...this.scores.values()].sort((a, b) => b.points - a.points);
  }

  private edit(payload: object) {
    this.editChain = this.editChain
      .then(() => this.message.edit({ ...payload, allowedMentions: { parse: [] } }))
      .catch((e) => log.debug("edit:", e instanceof Error ? e.message : e));
    return this.editChain;
  }

  /** Пауза, которую можно прервать кнопкой «Остановить». */
  private wait(ms: number) {
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }

  async prepare(voiceChannelId: string, hostId: string, channel: SendableChannels) {
    this.voiceChannelId = voiceChannelId;
    this.player = await this.music.ensurePlayer(voiceChannelId, channel.id);
    const p = this.player;
    this.saved = { current: p.queue.current, position: p.position, paused: p.paused, queue: [...p.queue.tracks], repeat: p.repeatMode };

    // Очередь откладываем в сторону: иначе при ошибке трека Lavalink перескочил бы на чужой трек посреди игры.
    this.music.beginQuiet();
    if (p.queue.tracks.length) await p.queue.splice(0, p.queue.tracks.length);
    if (p.repeatMode !== "off") await p.setRepeatMode("off");
    if (p.queue.current && !p.paused) await p.pause();

    this.startsAt = Date.now() + LOBBY_MS;
    this.message = await channel.send({
      ...lobbyView({ game: this.id, accent: this.accent, mode: this.mode, rounds: this.rounds, seconds: this.roundMs / 1000, voiceChannelId, startsAt: this.startsAt, hostId }),
      allowedMentions: { parse: [] },
    });
  }

  async run() {
    try {
      const participants = this.music.channelListeners();
      const [{ answers, pool }] = await Promise.all([buildPool(this.player, this.history, participants, this.rounds), this.wait(LOBBY_MS)]);
      if (this.aborted) return;
      if (answers.length < Math.min(3, this.rounds)) {
        this.failure = "Не удалось подобрать треки — послушайте что-нибудь, чтобы появилась история, и попробуйте снова.";
        return;
      }

      let idx = 0;
      let nextStart = startPosition(this.player, answers[0]!.track, this.mode, this.tailMs);
      for (let r = 1; r <= this.rounds && !this.aborted; ) {
        if (this.music.channelListeners().length === 0) {
          this.failure = this.played ? null : "Все вышли из голосового канала — игра остановлена.";
          break;
        }
        const item = answers[idx++];
        if (!item) break;
        const position = await nextStart.catch(() => 0);
        const following = answers[idx];
        nextStart = following ? startPosition(this.player, following.track, this.mode, this.tailMs) : Promise.resolve(0);

        if (!(await this.playItem(item, position))) {
          log.info(`Трек не запустился, беру запасной: ${item.artist} — ${item.title}`);
          continue;
        }
        await this.playRound(r, item, pool);
        this.played = r;
        r++;
      }
    } catch (e) {
      log.error("Ошибка игры:", e);
      this.failure = "Что-то пошло не так, игра остановлена.";
    } finally {
      await this.finish();
    }
  }

  /** Запустить трек с нужного места и дождаться, что он реально заиграл. */
  private async playItem(item: QuizItem, position: number): Promise<boolean> {
    const lm = this.music.lavalink;
    const started = new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => {
        lm.off("trackStart", onStart);
        lm.off("trackError", onError);
        lm.off("trackStuck", onError);
        clearTimeout(timer);
        resolve(ok);
      };
      const onStart = () => done(true);
      const onError = () => done(false);
      const timer = setTimeout(() => done(false), 12_000);
      lm.on("trackStart", onStart);
      lm.on("trackError", onError);
      lm.on("trackStuck", onError);
    });
    try {
      await this.player.play({ clientTrack: item.track, position, paused: false });
      if (this.player.paused) await this.player.resume();
    } catch (e) {
      log.debug("play:", e);
      return false;
    }
    return started;
  }

  private async playRound(n: number, item: QuizItem, pool: QuizItem[]) {
    const a = options(item, pool, "artist");
    const t = options(item, pool, "title");
    const startedAt = Date.now() + 300;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const round: Round = {
      item,
      artists: a.labels,
      titles: t.labels,
      correctArtist: a.correctIndex,
      correctTitle: t.correctIndex,
      startedAt,
      endsAt: startedAt + this.roundMs,
      answers: new Map(),
      finish,
    };
    this.round = round;
    this.phase = "round";
    this.wake = finish;
    await this.edit(roundView(this.roundState(round)));
    const timer = setTimeout(finish, round.endsAt - Date.now());
    await done;
    clearTimeout(timer);
    if (this.counterTimer) clearTimeout(this.counterTimer);

    this.phase = "reveal";
    const winners = (part: "a" | "t") =>
      [...round.answers.entries()]
        .filter(([, e]) => e[part]?.correct)
        .map(([userId, e]) => ({ userId, points: e[part]!.points }))
        .sort((x, y) => y.points - x.points);
    const last = n >= this.rounds || this.aborted;
    await this.edit(
      revealView({
        game: this.id,
        accent: this.accent,
        mode: this.mode,
        round: n,
        rounds: this.rounds,
        artists: round.artists,
        titles: round.titles,
        leaders: this.leaders(),
        artist: item.artist,
        title: item.title,
        uri: toTrackView(item.track).uri,
        artworkUrl: item.track.info.artworkUrl ?? null,
        correctArtist: round.correctArtist,
        correctTitle: round.correctTitle,
        artistWinners: winners("a"),
        titleWinners: winners("t"),
        nextAt: last ? null : Date.now() + REVEAL_MS,
      }),
    );
    // Пока показываем ответ, трек играет дальше.
    if (!this.aborted) await this.wait(REVEAL_MS);
    this.round = null;
  }

  private roundState(round: Round) {
    const listeners = this.music.channelListeners();
    const answered = listeners.filter((id) => {
      const e = round.answers.get(id);
      return e?.a && e?.t;
    }).length;
    return {
      game: this.id,
      accent: this.accent,
      mode: this.mode,
      round: this.played + 1,
      rounds: this.rounds,
      endsAt: round.endsAt,
      artists: round.artists,
      titles: round.titles,
      answered,
      listeners: listeners.length,
      leaders: this.leaders(),
    };
  }

  async answer(i: ButtonInteraction, part: "a" | "t", index: number) {
    const member = i.member as GuildMember | null;
    if (member?.voice?.channelId !== this.voiceChannelId) {
      await i.reply({ content: `Играют только те, кто в <#${this.voiceChannelId}> 🎧`, flags: MessageFlags.Ephemeral });
      return;
    }
    const round = this.round;
    if (this.phase !== "round" || !round || Date.now() > round.endsAt) {
      await i.reply({ content: "⏱ Раунд уже закончился", flags: MessageFlags.Ephemeral });
      return;
    }
    const entry = round.answers.get(i.user.id) ?? {};
    const what = part === "a" ? "Исполнитель" : "Название";
    if (entry[part]) {
      await i.reply({ content: `${what}: ответ уже принят`, flags: MessageFlags.Ephemeral });
      return;
    }
    const correct = index === (part === "a" ? round.correctArtist : round.correctTitle);
    const elapsed = Math.max(0, Date.now() - round.startedAt);
    const points = correct ? Math.max(100, Math.round(1000 - 900 * Math.min(1, elapsed / this.roundMs))) : 0;
    entry[part] = { correct, points };
    round.answers.set(i.user.id, entry);

    const score = this.scores.get(i.user.id) ?? { userId: i.user.id, points: 0, artist: 0, title: 0 };
    score.points += points;
    if (correct && part === "a") score.artist++;
    if (correct && part === "t") score.title++;
    this.scores.set(i.user.id, score);

    await i.reply({ content: correct ? `✅ ${what} — верно! **+${points}**` : `❌ ${what} — мимо`, flags: MessageFlags.Ephemeral });

    const listeners = this.music.channelListeners();
    const everyone = listeners.length > 0 && listeners.every((id) => round.answers.get(id)?.a && round.answers.get(id)?.t);
    if (everyone) round.finish();
    else if (!this.counterTimer) {
      this.counterTimer = setTimeout(() => {
        this.counterTimer = null;
        if (this.round === round && this.phase === "round") void this.edit(roundView(this.roundState(round)));
      }, 1500);
    }
  }

  stop(byUserId: string | null) {
    if (this.aborted) return;
    this.aborted = true;
    this.stoppedBy = byUserId;
    this.wake?.();
    this.round?.finish();
  }

  isVoiceMember(i: ButtonInteraction | ChatInputCommandInteraction) {
    return (i.member as GuildMember | null)?.voice?.channelId === this.voiceChannelId;
  }

  private async finish() {
    if (this.phase === "ended") return;
    this.phase = "ended";
    if (this.counterTimer) clearTimeout(this.counterTimer);

    const leaders = this.leaders();
    if (this.failure && this.played === 0) {
      await this.edit(noticeView(this.accent, this.failure));
    } else if (this.played === 0) {
      await this.edit(noticeView(this.accent, this.stoppedBy ? `Игру остановил(а) <@${this.stoppedBy}> до первого раунда.` : "Игра остановлена."));
    } else {
      await this.edit(finalView({ accent: this.accent, mode: this.mode, played: this.played, leaders, stoppedBy: this.stoppedBy }));
      this.store.record(leaders, this.played);
    }
    await this.restore();
  }

  /** Вернуть музыку, как была до игры: очередь, трек и позицию, режим повтора. */
  private async restore() {
    const p = this.music.player;
    try {
      if (!p) return;
      if (this.saved.repeat !== "off") await p.setRepeatMode(this.saved.repeat);
      if (this.saved.queue.length) await p.queue.add(this.saved.queue, 0);
      if (this.saved.current) {
        await p.play({ clientTrack: this.saved.current, position: this.saved.position, paused: this.saved.paused });
      } else if (p.queue.tracks.length) {
        const next = p.queue.tracks[0]!;
        await p.queue.splice(0, 1);
        await p.play({ clientTrack: next, paused: false });
      } else if (p.queue.current) {
        // Трек игры не должен попасть в «предыдущие».
        const cur = p.queue.current;
        cur.pluginInfo = { ...cur.pluginInfo, clientData: { ...(cur.pluginInfo?.clientData ?? {}), previousTrack: true } };
        await p.stopPlaying(false, false);
      }
      await new Promise((r) => setTimeout(r, 800));
    } catch (e) {
      log.warn("Не удалось восстановить музыку после игры:", e);
    } finally {
      this.music.endQuiet();
      if (!this.music.player?.queue.current) this.music.idleAfterQuiet();
    }
  }
}

/** Одна игра «Угадай трек» на сервер. */
export class QuizManager {
  private game: QuizGame | null = null;

  constructor(
    private readonly client: Client,
    private readonly music: MusicService,
    private readonly history: HistoryStore,
    private readonly settings: SettingsStore,
    private readonly store: QuizStore,
  ) {
    music.on("update", (reason) => {
      if (reason === "destroy") this.game?.stop(null);
    });
  }

  get active() {
    return this.game !== null;
  }

  async start(i: ChatInputCommandInteraction, mode: QuizMode, rounds: number, seconds: number) {
    if (this.game) throw new MusicError("Игра уже идёт — присоединяйся! 🎧");
    const voice = (i.member as GuildMember | null)?.voice?.channelId;
    if (!voice) throw new MusicError("Зайди в голосовой канал — играют те, кто в войсе.");
    if (!this.music.ready) throw new MusicError("Аудиосервер ещё запускается, попробуй через несколько секунд.");
    await i.deferReply({ flags: MessageFlags.Ephemeral });

    const channelId = this.settings.get().musicTextChannelId ?? i.channelId;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isSendable()) throw new MusicError("Не могу писать в канал для игры.");

    const game = new QuizGame(this.music, this.history, this.settings, this.store, mode, rounds, Math.min(Math.max(seconds, 5), 25) * 1000);
    this.game = game;
    try {
      await game.prepare(voice, i.user.id, channel);
    } catch (e) {
      this.game = null;
      if (this.music.quietMode) this.music.endQuiet();
      throw e;
    }
    await i.editReply(`🎧 Игра началась в <#${channelId}>, удачи!`);
    log.info(`Игра ${game.id}: ${rounds} раундов по ${seconds} с, режим ${mode}`);
    void game.run().finally(() => {
      if (this.game === game) this.game = null;
    });
  }

  async stop(i: ChatInputCommandInteraction | ButtonInteraction) {
    const game = this.game;
    if (!game) throw new MusicError("Сейчас игра не идёт.");
    if (!game.isVoiceMember(i)) throw new MusicError("Остановить игру могут те, кто в голосовом канале.");
    game.stop(i.user.id);
  }

  async top(i: ChatInputCommandInteraction) {
    await i.reply({ ...topView(this.settings.get().accentColor, this.store.top(10)), flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }

  /** Кнопки игры: qz:<игра>:a|t:<вариант> и qz:<игра>:stop. */
  async handleButton(i: ButtonInteraction) {
    const [, gameId, part, index] = i.customId.split(":");
    const game = this.game;
    if (!game || game.id !== gameId) {
      await i.reply({ content: "Эта игра уже закончилась. Новая — `/quiz start`", flags: MessageFlags.Ephemeral });
      return;
    }
    if (part === "stop") {
      await this.stop(i);
      await i.deferUpdate();
      return;
    }
    if (part === "a" || part === "t") await game.answer(i, part, Number(index));
  }
}
