import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { ChannelType, type Client } from "discord.js";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { LavalinkAdmin } from "../lavalink-admin.js";
import { createLogger, recentLogs } from "../logger.js";
import type { Alerts } from "../monitor.js";
import type { MusicService } from "../music/service.js";
import { MusicError, PANEL_REQUESTER } from "../music/types.js";
import { settingsPatchSchema, type SettingsStore } from "../settings.js";
import { isSearchSourceKey, sourceInfo } from "../sources.js";

const log = createLogger("panel");
const COOKIE = "mb_session";
const SESSION_DAYS = 30;

interface Deps {
  config: Config;
  client: Client;
  music: MusicService;
  settings: SettingsStore;
  admin: LavalinkAdmin;
  alerts: Alerts;
  startedAt: number;
}

export async function startPanel(deps: Deps) {
  const { config, client, music, settings, admin, alerts } = deps;
  const key = createHash("sha256").update(`panel:${config.PANEL_PASSWORD}`).digest();
  const sign = (value: string) => createHmac("sha256", key).update(value).digest("base64url");

  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 64 * 1024 });
  await app.register(fastifyCookie);
  await app.register(fastifyStatic, {
    root: fileURLToPath(new URL("../../public", import.meta.url)),
    prefix: "/",
  });

  /* ------------------------------ сессии ------------------------------ */

  const validSession = (req: FastifyRequest) => {
    const raw = req.cookies[COOKIE];
    if (!raw) return false;
    const [exp, sig] = raw.split(".");
    if (!exp || !sig || Number(exp) < Date.now()) return false;
    const expected = Buffer.from(sign(exp));
    const got = Buffer.from(sig);
    return expected.length === got.length && timingSafeEqual(expected, got);
  };

  const attempts = new Map<string, { count: number; until: number }>();
  app.post("/api/login", async (req, reply) => {
    const ip = req.ip;
    const a = attempts.get(ip);
    if (a && a.until > Date.now() && a.count >= 8) return reply.code(429).send({ error: "Слишком много попыток, подожди минуту" });
    const body = z.object({ password: z.string() }).safeParse(req.body);
    const ok =
      body.success &&
      timingSafeEqual(createHash("sha256").update(body.data.password).digest(), createHash("sha256").update(config.PANEL_PASSWORD).digest());
    if (!ok) {
      attempts.set(ip, { count: (a && a.until > Date.now() ? a.count : 0) + 1, until: Date.now() + 60_000 });
      return reply.code(401).send({ error: "Неверный пароль" });
    }
    attempts.delete(ip);
    const exp = String(Date.now() + SESSION_DAYS * 86_400_000);
    reply.setCookie(COOKIE, `${exp}.${sign(exp)}`, { path: "/", httpOnly: true, sameSite: "strict", maxAge: SESSION_DAYS * 86_400 });
    return { ok: true };
  });

  app.post("/api/logout", async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/api/") || req.url === "/api/login") return;
    if (!validSession(req)) return reply.code(401).send({ error: "Нужно войти" });
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof MusicError) return reply.code(400).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    log.error("Ошибка API:", err);
    return reply.code(500).send({ error: err instanceof Error ? err.message : "Внутренняя ошибка" });
  });

  /* ------------------------------ состояние ------------------------------ */

  const guild = () => client.guilds.cache.get(config.DISCORD_GUILD_ID);

  app.get("/api/session", async () => ({ ok: true }));

  app.get("/api/state", async () => ({
    player: music.snapshot(),
    settings: settings.get(),
    sources: [...music.availableManagers()],
  }));

  app.get("/api/guild", async () => {
    const g = guild();
    if (!g) return { name: null, icon: null, voice: [], text: [] };
    const channels = [...g.channels.cache.values()].sort((a, b) => ("position" in a && "position" in b ? a.position - b.position : 0));
    return {
      name: g.name,
      icon: g.iconURL({ size: 64 }),
      voice: channels.filter((c) => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice).map((c) => ({ id: c.id, name: c.name })),
      text: channels.filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement).map((c) => ({ id: c.id, name: c.name })),
    };
  });

  app.get("/api/status", async () => ({
    bot: {
      online: client.isReady(),
      tag: client.user?.tag ?? null,
      avatar: client.user?.displayAvatarURL({ size: 64 }) ?? null,
      ping: client.ws.ping,
      uptime: Date.now() - deps.startedAt,
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      guild: guild()?.name ?? null,
    },
    lavalink: await admin.status(),
  }));

  app.post("/api/diagnostics", async () => ({ results: await admin.diagnostics() }));
  app.get("/api/logs", async () => ({ logs: recentLogs(300) }));
  app.post("/api/alerts/test", async () => {
    await alerts.test();
    return { ok: true };
  });

  /* ------------------------------ настройки ------------------------------ */

  app.get("/api/settings", async () => settings.get());
  app.put("/api/settings", async (req) => {
    const patch = settingsPatchSchema.parse(req.body);
    const next = settings.update(patch);
    if ("stay247" in patch || "stay247ChannelId" in patch) {
      if (next.stay247) await music.ensureStay247();
      music.emit("update", "settings");
    }
    return next;
  });

  /* ------------------------------ плеер ------------------------------ */

  app.get("/api/search", async (req) => {
    const q = z.object({ q: z.string().min(1).max(300), source: z.string().optional() }).parse(req.query);
    const res = await music.search(q.q, isSearchSourceKey(q.source) ? q.source : undefined, PANEL_REQUESTER);
    return {
      loadType: res.loadType,
      playlist: res.playlist?.name ?? null,
      tracks: res.tracks.slice(0, 12).map((t) => ({
        title: t.info.title,
        author: t.info.author,
        duration: t.info.duration,
        isStream: t.info.isStream,
        uri: t.info.uri,
        artworkUrl: t.info.artworkUrl,
        source: sourceInfo(t.info.sourceName),
      })),
    };
  });

  app.post("/api/player/play", async (req) => {
    const body = z
      .object({ query: z.string().min(1).max(500), source: z.string().optional(), next: z.boolean().optional(), voiceChannelId: z.string().optional() })
      .parse(req.body);
    const s = settings.get();
    const voice = music.player?.voiceChannelId ?? body.voiceChannelId ?? s.stay247ChannelId;
    if (!voice) throw new MusicError("Бот не в голосовом канале. Выбери канал в форме добавления.");
    const result = await music.play({
      query: body.query,
      source: isSearchSourceKey(body.source) ? body.source : undefined,
      voiceChannelId: voice,
      textChannelId: s.musicTextChannelId ?? music.player?.textChannelId ?? null,
      requester: PANEL_REQUESTER,
      next: body.next,
    });
    return { added: result.added.length, playlist: result.playlistName, startedNow: result.startedNow, skipped: result.skipped };
  });

  const actions: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
    toggle: () => music.togglePause(),
    pause: () => music.setPaused(true),
    resume: () => music.setPaused(false),
    skip: () => music.skip(),
    previous: () => music.previous(),
    stop: () => music.stop(),
    leave: () => music.leave(),
    shuffle: () => music.shuffle(),
    clear: () => music.clear(),
    repeat: (b) => music.setRepeat(z.enum(["off", "queue", "track"]).parse(b.mode)),
    volume: (b) => music.setVolume(z.number().parse(b.value)),
    seek: (b) => music.seek(z.number().min(0).parse(b.ms)),
    jump: (b) => music.jump(z.number().int().min(1).parse(b.index)),
    remove: (b) => music.remove(z.number().int().min(1).parse(b.index)),
    move: (b) => music.move(z.number().int().min(1).parse(b.from), z.number().int().min(1).parse(b.to)),
    autoplay: async (b) => music.setAutoplayEnabled(z.boolean().parse(b.enabled)),
  };

  app.post<{ Params: { action: string } }>("/api/player/:action", async (req) => {
    const fn = actions[req.params.action];
    if (!fn) throw new MusicError("Неизвестное действие");
    await fn((req.body as Record<string, unknown>) ?? {});
    return { ok: true, player: music.snapshot() };
  });

  /* ------------------------------ live-события ------------------------------ */

  app.get("/api/events", (req: FastifyRequest, reply: FastifyReply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let pending: NodeJS.Timeout | null = null;
    const push = () => {
      pending = null;
      res.write(`data: ${JSON.stringify({ player: music.snapshot(), settings: settings.get() })}\n\n`);
    };
    const onUpdate = () => {
      if (!pending) pending = setTimeout(push, 150);
    };
    music.on("update", onUpdate);
    settings.on("change", onUpdate);
    const heartbeat = setInterval(push, 5000);
    push();
    req.raw.on("close", () => {
      clearInterval(heartbeat);
      if (pending) clearTimeout(pending);
      music.off("update", onUpdate);
      settings.off("change", onUpdate);
    });
  });

  await app.listen({ host: "0.0.0.0", port: config.PANEL_PORT });
  log.info(`Веб-панель слушает порт ${config.PANEL_PORT}`);
  return app;
}
