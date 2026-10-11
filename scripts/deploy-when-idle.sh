#!/usr/bin/env bash
# Дождаться, пока музыка не играет 2 минуты подряд, и выкатить обновление (scripts/deploy.sh).
# Запуск в фоне: nohup bash scripts/deploy-when-idle.sh > /tmp/deploy-when-idle.log 2>&1 &
set -uo pipefail
cd "$(dirname "$0")/.."

max_hours=${1:-12}
deadline=$(( $(date +%s) + max_hours * 3600 ))
pw=$(grep -E '^LAVALINK_PASSWORD=' .env | cut -d= -f2-)
quiet=0

echo "$(date '+%F %T') жду тишины (до ${max_hours} ч)"
while [ "$(date +%s)" -lt "$deadline" ]; do
  playing=$(curl -s -m 5 -H "Authorization: $pw" http://127.0.0.1:2333/v4/stats | grep -oE '"playingPlayers":[0-9]+' | cut -d: -f2)
  if [ "${playing:-0}" = "0" ]; then quiet=$((quiet + 1)); else quiet=0; fi
  if [ "$quiet" -ge 2 ]; then
    echo "$(date '+%F %T') музыка не играет — обновляю"
    bash scripts/deploy.sh && echo "DEPLOY_DONE" || echo "DEPLOY_FAILED"
    exit 0
  fi
  sleep 60
done
echo "$(date '+%F %T') не дождался тишины, обновление не выполнено"
echo "DEPLOY_SKIPPED"
