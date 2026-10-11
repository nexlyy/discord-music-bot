/** Переводит частые ошибки Lavalink/YouTube в понятный текст. */
export function humanizeLoadError(message: string | undefined | null): string {
  const m = (message ?? "").toLowerCase();
  if (m.includes("sign in to confirm") || m.includes("login_required") || m.includes("not a bot")) {
    return "YouTube требует вход. Нужно заново подключить OAuth-аккаунт (см. веб-панель → Статус).";
  }
  if (m.includes("age") && m.includes("restrict")) return "Видео с возрастным ограничением, воспроизвести его нельзя.";
  if (m.includes("unavailable") || m.includes("not available")) return "Трек недоступен (удалён или закрыт в регионе сервера).";
  if (m.includes("private")) return "Это приватное видео или плейлист.";
  if (m.includes("copyright")) return "Трек заблокирован правообладателем.";
  if (m.includes("premium") || m.includes("subscription")) return "Для этого трека нужна подписка на площадке.";
  if (m.includes("region") || m.includes("country")) return "Трек недоступен в регионе сервера.";
  if (m.includes("timed out") || m.includes("timeout")) return "Площадка не ответила вовремя, попробуй ещё раз.";
  if (m.includes("429") || m.includes("rate limit")) return "Площадка временно ограничила запросы, попробуй через минуту.";
  return message ? `Ошибка загрузки: ${message}` : "Не удалось загрузить трек.";
}

export function isYoutubeAuthError(message: string | undefined | null): boolean {
  const m = (message ?? "").toLowerCase();
  return m.includes("sign in to confirm") || m.includes("login_required") || m.includes("not a bot");
}
