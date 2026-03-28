/**
 * Console log capture — intercepts console.log/error/warn and buffers
 * recent entries for the /api/console SSE endpoint.
 */

export interface LogEntry {
  timestamp: string;
  level: "log" | "error" | "warn";
  message: string;
}

const MAX_BUFFER = 500;
const buffer: LogEntry[] = [];
const listeners = new Set<(entry: LogEntry) => void>();

function capture(level: LogEntry["level"], args: unknown[]): string {
  return args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
}

/** Install console interceptors. Call once at startup. */
export function installConsoleCapture(): void {
  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  const emit = (level: LogEntry["level"], args: unknown[]) => {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: capture(level, args),
    };
    buffer.push(entry);
    if (buffer.length > MAX_BUFFER) buffer.shift();
    for (const fn of listeners) fn(entry);
  };

  console.log = (...args: unknown[]) => { origLog(...args); emit("log", args); };
  console.error = (...args: unknown[]) => { origError(...args); emit("error", args); };
  console.warn = (...args: unknown[]) => { origWarn(...args); emit("warn", args); };
}

/** Get recent log entries. */
export function getRecentLogs(limit = 100): LogEntry[] {
  return buffer.slice(-limit);
}

/** Subscribe to new log entries. Returns unsubscribe function. */
export function onLogEntry(fn: (entry: LogEntry) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
