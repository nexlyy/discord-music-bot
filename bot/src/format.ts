export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** "1:30", "01:02:03", "90" (секунды) → миллисекунды. null, если не разобрать. */
export function parseTime(input: string): number | null {
  const parts = input.trim().split(":");
  if (parts.length === 0 || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0) * 1000;
}

export function progressBar(position: number, duration: number, size = 16): string {
  if (!duration || duration <= 0) return "▬".repeat(size);
  const ratio = Math.min(Math.max(position / duration, 0), 1);
  const filled = Math.round(ratio * (size - 1));
  return "━".repeat(filled) + "●" + "─".repeat(size - 1 - filled);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Экранирует markdown Discord, чтобы названия треков не ломали разметку. */
export function escapeMd(text: string): string {
  return text.replace(/([\\*_`~|\[\]])/g, "\\$1");
}

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export function tracksWord(n: number): string {
  return `${n} ${plural(n, "трек", "трека", "треков")}`;
}
