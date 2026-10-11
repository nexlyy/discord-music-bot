type Level = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  time: number;
  level: Level;
  scope: string;
  message: string;
}

const RING_SIZE = 300;
const ring: LogEntry[] = [];
const debugEnabled = process.env.LOG_LEVEL === "debug";

function formatArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack ?? arg.message;
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function write(level: Level, scope: string, args: unknown[]) {
  if (level === "debug" && !debugEnabled) return;
  const message = args.map(formatArg).join(" ");
  const entry: LogEntry = { time: Date.now(), level, scope, message };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
  const line = `${new Date(entry.time).toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export function createLogger(scope: string) {
  return {
    debug: (...args: unknown[]) => write("debug", scope, args),
    info: (...args: unknown[]) => write("info", scope, args),
    warn: (...args: unknown[]) => write("warn", scope, args),
    error: (...args: unknown[]) => write("error", scope, args),
  };
}

export type Logger = ReturnType<typeof createLogger>;

export function recentLogs(limit = RING_SIZE): LogEntry[] {
  return ring.slice(-limit);
}
