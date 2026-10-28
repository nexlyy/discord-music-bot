import { z } from "zod";

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN не задан"),
  DISCORD_GUILD_ID: z.string().regex(/^\d{17,20}$/, "DISCORD_GUILD_ID должен быть ID сервера"),
  /** Токены дополнительных Артуров через запятую: каждый играет в своём голосовом канале */
  DISCORD_HELPER_TOKENS: z.preprocess(
    (v) => (typeof v === "string" ? v.split(",").map((t) => t.trim()).filter(Boolean) : []),
    z.array(z.string()),
  ),
  LAVALINK_HOST: z.string().default("lavalink"),
  LAVALINK_PORT: z.coerce.number().int().default(2333),
  LAVALINK_PASSWORD: z.string().min(1, "LAVALINK_PASSWORD не задан"),
  PANEL_PORT: z.coerce.number().int().default(8090),
  PANEL_PASSWORD: z.string().min(6, "PANEL_PASSWORD должен быть не короче 6 символов"),
  DATA_DIR: z.string().default("./data"),
  ALERT_WEBHOOK_URL: z.preprocess(emptyToUndefined, z.url().optional()),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    console.error(`Ошибка конфигурации (.env):\n${problems}`);
    process.exit(1);
  }
  return parsed.data;
}
