#!/usr/bin/env bash
# Ежедневная копия данных бота: история и итоги месяцев, рейтинг «Угадай трек», плейлисты, настройки,
# найденные замены треков и .env (токены). Хранится 7 дней в /var/backups/discord-music-bot (доступ только root).
# Запускается cron'ом (см. setup.sh). Восстановить при остановленном боте:
#   docker compose stop bot && tar -xzf /var/backups/discord-music-bot/music-bot-ГГГГ-ММ-ДД.tar.gz -C /opt/discord-music-bot && docker compose start bot
set -euo pipefail
cd "$(dirname "$0")/.."

DEST="${BACKUP_DIR:-/var/backups/discord-music-bot}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-7}"

umask 077
mkdir -p "$DEST"
chmod 700 "$DEST"

name="music-bot-$(date +%F).tar.gz"
# Файлы данных пишутся атомарно (временный файл + переименование), поэтому копировать можно на ходу.
tar --exclude='data/*.tmp' --exclude='data/.running' -czf "$DEST/$name.part" data .env
mv "$DEST/$name.part" "$DEST/$name"
find "$DEST" -maxdepth 1 -name 'music-bot-*.tar.gz' -mtime +"$KEEP_DAYS" -delete

echo "$(date '+%F %T') Копия: $DEST/$name ($(du -h "$DEST/$name" | cut -f1)), всего копий: $(find "$DEST" -maxdepth 1 -name 'music-bot-*.tar.gz' | wc -l)"
