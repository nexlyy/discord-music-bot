#!/usr/bin/env bash
# Обновление на сервере: забрать код из git и пересобрать то, что изменилось.
# Пока играет музыка, не перезапускает (очередь при перезапуске теряется). Принудительно: --force
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${1:-}" != "--force" ]; then
  pw=$(grep -E '^LAVALINK_PASSWORD=' .env | cut -d= -f2-)
  playing=$(curl -s -m 5 -H "Authorization: $pw" http://127.0.0.1:2333/v4/stats | grep -oE '"playingPlayers":[0-9]+' | cut -d: -f2 || true)
  if [ "${playing:-0}" != "0" ]; then
    echo "Сейчас играет музыка — перезапуск оборвёт её и очистит очередь."
    echo "Повтори позже или запусти: bash scripts/deploy.sh --force"
    exit 1
  fi
fi

git pull --ff-only
bash scripts/fix-permissions.sh
docker compose pull lavalink yt-cipher spotify-tokener
docker compose up -d --build --remove-orphans
docker image prune -f >/dev/null
docker compose ps
