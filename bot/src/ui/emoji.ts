import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Client } from "discord.js";
import { createLogger } from "../logger.js";

const log = createLogger("emoji");

/** Одноцветные иконки (Lucide, ISC) из assets/icons. Загружаются как эмодзи приложения. */
const FALLBACK = {
  shuffle: "🔀",
  prev: "⏮️",
  next: "⏭️",
  play: "▶️",
  pause: "⏸️",
  queue: "📜",
  playlist: "🎶",
  repeat: "🔁",
  repeat1: "🔂",
  autoplay: "♾️",
  voldown: "🔉",
  volup: "🔊",
  stop: "⏹️",
  moon: "🌙",
  lyrics: "🎤",
  search: "🔎",
  settings: "⚙️",
  add: "➕",
} as const;

export type IconKey = keyof typeof FALLBACK;
type Emoji = { id: string; name: string };

// Версия в префиксе: если поменять картинки, новые загрузятся под другими именами.
const PREFIX = "mb1_";
const registry = new Map<IconKey, Emoji>();

/** Для setEmoji() кнопок и пунктов меню. */
export function icon(key: IconKey): Emoji | string {
  return registry.get(key) ?? FALLBACK[key];
}

/** Для текста сообщений. */
export function iconText(key: IconKey): string {
  const e = registry.get(key);
  return e ? `<:${e.name}:${e.id}>` : FALLBACK[key];
}

export async function syncEmojis(client: Client<true>) {
  const dir = fileURLToPath(new URL("../../assets/icons/", import.meta.url));
  let existing;
  try {
    existing = await client.application.emojis.fetch();
  } catch (e) {
    log.warn("Не удалось получить эмодзи приложения, будут обычные эмодзи:", e);
    return;
  }
  let created = 0;
  for (const key of Object.keys(FALLBACK) as IconKey[]) {
    const name = PREFIX + key;
    let emoji = existing.find((e) => e.name === name);
    if (!emoji) {
      try {
        emoji = await client.application.emojis.create({ attachment: readFileSync(`${dir}${key}.png`), name });
        created++;
      } catch (e) {
        log.warn(`Не удалось загрузить иконку ${key}:`, e);
        continue;
      }
    }
    registry.set(key, { id: emoji.id, name });
  }
  log.info(`Иконки плеера: ${registry.size}/${Object.keys(FALLBACK).length}${created ? `, загружено новых: ${created}` : ""}`);
}
