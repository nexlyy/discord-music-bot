import { SlashCommandBuilder } from "discord.js";
import { SEARCH_SOURCES, SEARCH_SOURCE_KEYS } from "../sources.js";

const sourceChoices = SEARCH_SOURCE_KEYS.map((k) => ({ name: SEARCH_SOURCES[k].label, value: k }));

export const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Включить трек, альбом или плейлист: ссылка или поиск")
    .addStringOption((o) =>
      o.setName("запрос").setDescription("Название, ссылка или имя твоего плейлиста").setRequired(true).setAutocomplete(true).setMaxLength(500),
    )
    .addStringOption((o) => o.setName("площадка").setDescription("Где искать (по умолчанию — из настроек)").addChoices(...sourceChoices))
    .addBooleanOption((o) => o.setName("следующим").setDescription("Поставить в начало очереди")),

  new SlashCommandBuilder().setName("pause").setDescription("Пауза / продолжить"),
  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Следующий трек")
    .addIntegerOption((o) => o.setName("сколько").setDescription("Пропустить несколько треков").setMinValue(1)),
  new SlashCommandBuilder().setName("previous").setDescription("Предыдущий трек"),
  new SlashCommandBuilder().setName("stop").setDescription("Остановить музыку и очистить очередь"),
  new SlashCommandBuilder().setName("leave").setDescription("Выйти из голосового канала"),
  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Показать очередь")
    .addIntegerOption((o) => o.setName("страница").setDescription("Номер страницы").setMinValue(1)),
  new SlashCommandBuilder().setName("player").setDescription("Показать плеер Артура из твоего войса для всех в этом чате"),
  new SlashCommandBuilder().setName("shuffle").setDescription("Режим перемешивания: включить или выключить"),
  new SlashCommandBuilder().setName("playlists").setDescription("Мои плейлисты: создать, импортировать, включить"),
  new SlashCommandBuilder().setName("browse").setDescription("Обзор: чарты, топ сервера, радио по истории"),
  new SlashCommandBuilder()
    .setName("wrapped")
    .setDescription("Музыкальные итоги сервера: топ треков, слушатели, диджеи")
    .addStringOption((o) =>
      o
        .setName("период")
        .setDescription("За какой период (по умолчанию этот месяц)")
        .addChoices({ name: "Этот месяц", value: "month" }, { name: "Прошлый месяц", value: "last" }, { name: "Всё время", value: "all" }),
    ),
  new SlashCommandBuilder().setName("like").setDescription("Добавить текущий трек в «Любимые» (или убрать)"),
  new SlashCommandBuilder()
    .setName("loop")
    .setDescription("Режим повтора")
    .addStringOption((o) =>
      o
        .setName("режим")
        .setDescription("Что повторять")
        .setRequired(true)
        .addChoices({ name: "Выключить", value: "off" }, { name: "Очередь", value: "queue" }, { name: "Текущий трек", value: "track" }),
    ),
  new SlashCommandBuilder()
    .setName("volume")
    .setDescription("Громкость")
    .addIntegerOption((o) => o.setName("уровень").setDescription("От 0 до 150").setRequired(true).setMinValue(0).setMaxValue(200)),
  new SlashCommandBuilder()
    .setName("seek")
    .setDescription("Перемотать трек")
    .addStringOption((o) => o.setName("время").setDescription("Например 1:30 или 90").setRequired(true)),
  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Убрать трек из очереди")
    .addIntegerOption((o) => o.setName("номер").setDescription("Позиция в очереди").setRequired(true).setMinValue(1)),
  new SlashCommandBuilder()
    .setName("move")
    .setDescription("Переместить трек в очереди")
    .addIntegerOption((o) => o.setName("откуда").setDescription("Текущая позиция").setRequired(true).setMinValue(1))
    .addIntegerOption((o) => o.setName("куда").setDescription("Новая позиция").setRequired(true).setMinValue(1)),
  new SlashCommandBuilder()
    .setName("jump")
    .setDescription("Перейти к треку из очереди")
    .addIntegerOption((o) => o.setName("номер").setDescription("Позиция в очереди").setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName("clear").setDescription("Очистить очередь (текущий трек доиграет)"),
  new SlashCommandBuilder()
    .setName("autoplay")
    .setDescription("Автоплей: похожие треки, когда очередь закончится")
    .addBooleanOption((o) => o.setName("включить").setDescription("Без параметра — переключить")),
  new SlashCommandBuilder().setName("lyrics").setDescription("Текст песни, синхронно с треком"),
  new SlashCommandBuilder()
    .setName("247")
    .setDescription("Режим 24/7: бот не выходит из канала")
    .addBooleanOption((o) => o.setName("включить").setDescription("Без параметра — переключить")),
  new SlashCommandBuilder()
    .setName("quiz")
    .setDescription("Угадай трек — музыкальная викторина")
    .addSubcommand((s) =>
      s
        .setName("start")
        .setDescription("Начать игру")
        .addStringOption((o) =>
          o
            .setName("режим")
            .setDescription("С какого места играет трек")
            .setRequired(true)
            .addChoices({ name: "Дроп — самый узнаваемый момент", value: "drop" }, { name: "С начала трека", value: "start" }),
        )
        .addIntegerOption((o) =>
          o
            .setName("раунды")
            .setDescription("Сколько раундов (по умолчанию 10)")
            .addChoices({ name: "5", value: 5 }, { name: "10", value: 10 }, { name: "15", value: 15 }, { name: "20", value: 20 }),
        )
        .addIntegerOption((o) =>
          o
            .setName("время")
            .setDescription("Сколько секунд звучит трек (по умолчанию 10)")
            .addChoices({ name: "5 секунд", value: 5 }, { name: "10 секунд", value: 10 }, { name: "15 секунд", value: 15 }, { name: "20 секунд", value: 20 }, { name: "25 секунд", value: 25 }),
        ),
    )
    .addSubcommand((s) => s.setName("stop").setDescription("Остановить игру"))
    .addSubcommand((s) => s.setName("top").setDescription("Рейтинг игроков сервера за всё время")),
  new SlashCommandBuilder().setName("cleanup").setDescription("Удалить старые сообщения бота в этом канале (плеер и закреплённые останутся)"),
  new SlashCommandBuilder().setName("panel").setDescription("Как открыть веб-панель настроек"),
];

export const commandsJson = commands.map((c) => c.toJSON());
