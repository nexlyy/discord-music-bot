@echo off
chcp 65001 >nul
title Music Bot - панель
echo Открываю SSH-туннель к серверу mcr и веб-панель бота...
echo Пока это окно открыто, панель доступна по адресу http://localhost:8090
echo Закрой окно, чтобы отключиться.
echo.
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:8090"
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L 8090:127.0.0.1:8090 mcr
if errorlevel 1 (
  echo.
  echo Не удалось открыть туннель. Проверь, что команда "ssh mcr" работает и порт 8090 свободен.
  pause
)
