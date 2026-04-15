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

  // Reentrancy marker: true while we're inside a console.error/warn wrapper
  // calling origError/origWarn. The stderr-write hook below checks this to
  // skip its own emit — otherwise every console.error is captured twice, once
  // via the console wrapper and once via the stderr hook that fires when the
  // underlying stream write happens. The earlier "buffer.some(...)" dedupe
  // check was racy (the buffer hadn't been written yet when the stderr hook
  // ran) and leaked duplicates with a [stderr] prefix.
  let inConsoleWrapper = false;

  console.log = (...args: unknown[]) => { origLog(...args); emit("log", args); };
  console.error = (...args: unknown[]) => {
    inConsoleWrapper = true;
    try { origError(...args); } finally { inConsoleWrapper = false; }
    emit("error", args);
  };
  console.warn = (...args: unknown[]) => {
    inConsoleWrapper = true;
    try { origWarn(...args); } finally { inConsoleWrapper = false; }
    emit("warn", args);
  };

  // Capture process-level events that don't go through console
  process.on("warning", (warning) => {
    emitLogEntry("warn", `[Node warning] ${warning.name}: ${warning.message}`);
  });

  // Capture stderr writes from child processes that bypass console
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: unknown, ...rest: unknown[]): boolean => {
    if (!inConsoleWrapper) {
      const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      const trimmed = text.trim();
      if (trimmed && !trimmed.startsWith("Error:")) {
        emitLogEntry("error", `[stderr] ${trimmed}`);
      }
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
