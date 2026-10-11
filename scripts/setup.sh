#!/usr/bin/env bash
# Первая установка на сервере: .env с паролями, права на каталоги, запуск.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s/^LAVALINK_PASSWORD=.*/LAVALINK_PASSWORD=$(openssl rand -hex 24)/" .env
  sed -i "s/^YT_CIPHER_TOKEN=.*/YT_CIPHER_TOKEN=$(openssl rand -hex 24)/" .env
  sed -i "s/^PANEL_PASSWORD=.*/PANEL_PASSWORD=$(openssl rand -base64 12 | tr -d '/+=')/" .env
  chmod 600 .env
  echo "Создан .env. Впиши DISCORD_TOKEN и DISCORD_GUILD_ID, затем запусти скрипт ещё раз."
  exit 0
fi

bash scripts/fix-permissions.sh

# Автообновление плагинов раз в час (скрипт сам ждёт, пока музыка не играет).
if [ -d /etc/cron.d ]; then
  echo "17 * * * * root $(pwd)/scripts/update-plugins.sh >> /var/log/music-bot-update.log 2>&1" > /etc/cron.d/discord-music-bot
  chmod 644 /etc/cron.d/discord-music-bot
fi

if grep -q '^DISCORD_TOKEN=$' .env; then
  echo "DISCORD_TOKEN пуст — запускаю только аудиосервер."
  docker compose up -d lavalink yt-cipher spotify-tokener
else
  docker compose up -d --build
fi
docker compose ps
