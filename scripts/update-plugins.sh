#!/usr/bin/env bash
# Автообновление плагинов Lavalink (YouTube ломается чаще всего) и вспомогательных сервисов.
# Запускается cron'ом раз в час. Версии плагинов пишутся в .env (не в git), поэтому git pull не конфликтует.
# Перезапуск делается только когда музыка не играет.
set -uo pipefail
cd "$(dirname "$0")/.."

log() { echo "$(date '+%F %T') $*"; }
env_get() { grep -E "^$1=" .env | head -1 | cut -d= -f2-; }
env_set() { if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi; }

notify() {
  local url
  url=$(python3 -c 'import json;print(json.load(open("data/settings.json")).get("alertWebhookUrl") or "")' 2>/dev/null)
  [ -z "$url" ] && url=$(env_get ALERT_WEBHOOK_URL)
  [ -z "$url" ] && return 0
  python3 - "$url" "$1" <<'EOF' || true
import json, sys, urllib.request
url, text = sys.argv[1], sys.argv[2]
body = json.dumps({"username": "Music Bot · мониторинг", "embeds": [{"title": "🔄 Автообновление", "description": text, "color": 0x3B82F6}]}).encode()
urllib.request.urlopen(urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}), timeout=10)
EOF
}

latest_release() { curl -s -m 15 "https://api.github.com/repos/$1/releases/latest" | grep -m1 '"tag_name"' | cut -d'"' -f4; }
jar_exists() { # group:name version
  local group=${1%%:*} name=${1##*:}
  curl -sfI -m 15 "https://maven.lavalink.dev/releases/${group//.//}/$name/$2/$name-$2.jar" >/dev/null
}
current_version() { # переменная, артефакт — из .env, иначе значение по умолчанию из application.yml
  local v
  v=$(env_get "$1")
  [ -n "$v" ] && { echo "$v"; return; }
  grep -oE "$2:\\\$\{$1:[^}]+\}" lavalink/application.yml | sed -E 's/.*:([^:}]+)\}$/\1/'
}

declare -A updates=()
plan() { # репозиторий, переменная, артефакт
  local cur new
  cur=$(current_version "$2" "$3")
  new=$(latest_release "$1")
  [ -z "$new" ] || [ "$new" = "$cur" ] && return
  if jar_exists "$3" "$new"; then updates[$2]="$new"; log "$3: $cur → $new"
  else log "$3 $new ещё не опубликован в maven, жду"; fi
}

plan lavalink-devs/youtube-source YOUTUBE_PLUGIN_VERSION "dev.lavalink.youtube:youtube-plugin"
plan topi314/LavaSrc LAVASRC_VERSION "com.github.topi314.lavasrc:lavasrc-plugin"
plan topi314/LavaLyrics LAVALYRICS_VERSION "com.github.topi314.lavalyrics:lavalyrics-plugin"

# Вспомогательные сервисы: сравниваем образ контейнера с только что скачанным.
stale_services=()
for svc in yt-cipher spotify-tokener; do
  container="music-$svc"
  image=$(docker inspect --format '{{.Config.Image}}' "$container" 2>/dev/null) || continue
  docker pull -q "$image" >/dev/null 2>&1 || continue
  [ "$(docker inspect --format '{{.Image}}' "$container")" != "$(docker image inspect --format '{{.Id}}' "$image")" ] && stale_services+=("$svc")
done

if [ ${#updates[@]} -eq 0 ] && [ ${#stale_services[@]} -eq 0 ]; then
  log "Обновлений нет"
  exit 0
fi

playing=$(curl -s -m 5 -H "Authorization: $(env_get LAVALINK_PASSWORD)" http://127.0.0.1:2333/v4/stats | grep -oE '"playingPlayers":[0-9]+' | cut -d: -f2)
if [ "${playing:-0}" != "0" ]; then
  log "Сейчас играет музыка — обновление отложено"
  exit 0
fi

summary=""
for var in "${!updates[@]}"; do env_set "$var" "${updates[$var]}"; summary+="• $var → ${updates[$var]}\n"; done
for svc in "${stale_services[@]}"; do summary+="• образ $svc\n"; done

[ ${#stale_services[@]} -gt 0 ] && docker compose up -d "${stale_services[@]}"
[ ${#updates[@]} -gt 0 ] && docker compose up -d --force-recreate lavalink
docker image prune -f >/dev/null
log "Применено"
notify "$(printf '%b' "$summary")"
