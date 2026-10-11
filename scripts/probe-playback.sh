#!/usr/bin/env bash
# Проверить, что треки действительно воспроизводятся (а не только находятся).
# Пример: bash scripts/probe-playback.sh "https://youtu.be/kJQP7kiw5Fk" "ymsearch:земфира"
set -euo pipefail
cd "$(dirname "$0")/.."
docker run --rm --network music-bot_default \
  -e LAVALINK_PASSWORD="$(grep -E '^LAVALINK_PASSWORD=' .env | cut -d= -f2-)" \
  -v "$(pwd)/scripts/probe-playback.mjs:/app/probe.mjs:ro" \
  --entrypoint node music-bot-bot /app/probe.mjs "$@"
