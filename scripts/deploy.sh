#!/usr/bin/env bash
# Обновление на сервере: забрать код из git и пересобрать то, что изменилось.
set -euo pipefail
cd "$(dirname "$0")/.."

git pull --ff-only
bash scripts/fix-permissions.sh
docker compose pull lavalink yt-cipher spotify-tokener
docker compose up -d --build --remove-orphans
docker image prune -f >/dev/null
docker compose ps
