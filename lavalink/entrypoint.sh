#!/bin/sh
# Включает Яндекс Музыку и VK только при наличии токенов: без токена LavaSrc падает на старте.
set -e

if [ -n "$YANDEX_MUSIC_TOKEN" ]; then export LAVASRC_YANDEX_ENABLED=true; else export LAVASRC_YANDEX_ENABLED=false; fi
if [ -n "$VK_MUSIC_TOKEN" ]; then export LAVASRC_VK_ENABLED=true; else export LAVASRC_VK_ENABLED=false; fi

# Прокси нужны Яндексу и VK за пределами РФ/СНГ. Spring подхватит их через relaxed binding.
if [ -n "$YANDEX_PROXY_URL" ]; then
  export PLUGINS_LAVASRC_YANDEXMUSIC_PROXY_URL="$YANDEX_PROXY_URL"
  [ -n "$YANDEX_PROXY_USERNAME" ] && export PLUGINS_LAVASRC_YANDEXMUSIC_PROXY_USERNAME="$YANDEX_PROXY_USERNAME"
  [ -n "$YANDEX_PROXY_PASSWORD" ] && export PLUGINS_LAVASRC_YANDEXMUSIC_PROXY_PASSWORD="$YANDEX_PROXY_PASSWORD"
fi
if [ -n "$VK_PROXY_URL" ]; then
  export PLUGINS_LAVASRC_VKMUSIC_PROXY_URL="$VK_PROXY_URL"
  [ -n "$VK_PROXY_USERNAME" ] && export PLUGINS_LAVASRC_VKMUSIC_PROXY_USERNAME="$VK_PROXY_USERNAME"
  [ -n "$VK_PROXY_PASSWORD" ] && export PLUGINS_LAVASRC_VKMUSIC_PROXY_PASSWORD="$VK_PROXY_PASSWORD"
fi

echo "[entrypoint] yandex=$LAVASRC_YANDEX_ENABLED vk=$LAVASRC_VK_ENABLED"
exec java ${LAVALINK_JAVA_OPTS:--Xmx768m} -jar Lavalink.jar
