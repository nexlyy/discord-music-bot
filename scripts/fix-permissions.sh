#!/usr/bin/env bash
# Каталоги, в которые пишут контейнеры: lavalink работает под uid 322, бот — под uid 1000 (node).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p lavalink/plugins lavalink/logs data
chown -R 322:322 lavalink/plugins lavalink/logs
chown -R 1000:1000 data
sed -i 's/\r$//' lavalink/entrypoint.sh scripts/*.sh
