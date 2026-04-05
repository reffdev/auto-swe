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

/** Emit a log entry directly (for non-console sources like process events). */
export function emitLogEntry(level: LogEntry["level"], message: string): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
  };
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();
  for (const fn of listeners) fn(entry);
}

/** Install console interceptors. Call once at startup. */
export function installConsoleCapture(): void {
  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  const emit = (level: LogEntry["level"], args: unknown[]) => {
    emitLogEntry(level, capture(level, args));
  };

  console.log = (...args: unknown[]) => { origLog(...args); emit("log", args); };
  console.error = (...args: unknown[]) => { origError(...args); emit("error", args); };
  console.warn = (...args: unknown[]) => { origWarn(...args); emit("warn", args); };

  // Capture process-level events that don't go through console
  process.on("warning", (warning) => {
    emitLogEntry("warn", `[Node warning] ${warning.name}: ${warning.message}`);
  });

  // Capture stderr writes from child processes that bypass console
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: unknown, ...rest: unknown[]): boolean => {
    const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    const trimmed = text.trim();
    // Only capture non-empty lines that aren't already from console.error (avoid double-capture)
    if (trimmed && !trimmed.startsWith("Error:") && !buffer.some(e => e.message.includes(trimmed.slice(0, 50)))) {
      emitLogEntry("error", `[stderr] ${trimmed}`);
    }
    return (origStderrWrite as Function)(chunk, ...rest);
  };
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
