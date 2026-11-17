import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from "discord.js";
import { escapeMd, truncate } from "../format.js";
import type { AutoplayTaste } from "../music/taste.js";
import { icon } from "./emoji.js";

/** Кнопка «Вернуть» (ap:unban:<ключ>) и меню со списком (ap:unban). */
export const AP_UNBAN = "ap:unban";

type Blocked = ReturnType<AutoplayTaste["blockedList"]>;

const whyText = (why: Blocked[number]["why"]) => (why === "ban" ? "убран вручную" : "дважды пропустили сразу");

/** Строка «Не ставлю: …» для сообщений. */
export function blockedLine(list: Blocked): string {
  if (list.length === 0) return "";
  const names = list.slice(0, 15).map((b) => escapeMd(b.name));
  return `\n-# 🚫 Не ставлю в автоплей: ${names.join(", ")}${list.length > 15 ? ` и ещё ${list.length - 15}` : ""}`;
}

/** Меню «Вернуть в автоплей» со всеми, кого автоплей сейчас пропускает. */
export function unbanMenu(list: Blocked) {
  if (list.length === 0) return [];
  const options = list.slice(0, 25).map((b) => ({
    label: truncate(b.name, 100),
    value: b.key.slice(0, 100),
    description: whyText(b.why),
  }));
  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(AP_UNBAN)
        .setPlaceholder("Вернуть исполнителя в автоплей")
        .setMinValues(1)
        .setMaxValues(options.length)
        .addOptions(options),
    ),
  ];
}

/** Ответ на «Не ставить в автоплей»: кнопка отмены сразу под ним. */
export function unbanButton(key: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${AP_UNBAN}:${key}`.slice(0, 100))
      .setLabel("Вернуть")
      .setEmoji(icon("back"))
      .setStyle(ButtonStyle.Secondary),
  );
}
