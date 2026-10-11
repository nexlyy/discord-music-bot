#!/usr/bin/env bash
# Подключить (или переподключить) запасной Google-аккаунт для YouTube.
# Скрипт сбрасывает старый токен, показывает код для google.com/device и сохраняет новый токен в .env.
set -euo pipefail
cd "$(dirname "$0")/.."

set_env() {
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}

set_env YOUTUBE_OAUTH_ENABLED true
set_env YOUTUBE_OAUTH_SKIP_INIT false
set_env YOUTUBE_REFRESH_TOKEN ""
docker compose up -d --force-recreate lavalink >/dev/null

echo "Жду код от YouTube…"
code_line=$(timeout 180 docker logs -f --since 10s music-lavalink 2>&1 | grep -m1 "enter code" || true)
if [ -z "$code_line" ]; then
  echo "Код не появился за 3 минуты. Посмотри логи: docker logs music-lavalink"
  exit 1
fi
code=$(echo "$code_line" | grep -oE "[A-Z0-9]{3,4}-[A-Z0-9]{3,4}-[A-Z0-9]{3,4}" | head -1)
echo
echo "  1. Открой https://www.google.com/device (лучше в режиме инкогнито)"
echo "  2. Войди ЗАПАСНЫМ Google-аккаунтом, не основным"
echo "  3. Введи код: $code"
echo
echo "Жду подтверждения (до 30 минут)…"

result=$(timeout 1800 docker logs -f --since 1m music-lavalink 2>&1 | grep -m1 -E "Token retrieved successfully|has expired|was denied" || true)
token=$(echo "$result" | grep -oE "\(1//[^)]+\)" | tr -d '()' || true)
if [ -z "$token" ]; then
  echo "Вход не завершён: ${result:-время ожидания вышло}"
  exit 1
fi

set_env YOUTUBE_REFRESH_TOKEN "$token"
echo "Готово: токен сохранён в .env, YouTube работает через запасной аккаунт."
