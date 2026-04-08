/**
 * Auto-SWE server entry point.
 *
 * Express app serving the API on port 3001.
 * Initializes the database, runs crash recovery, and mounts routes.
 */

import { installConsoleCapture } from "./console-log";
installConsoleCapture(); // must be first — before any console.log calls

// Prevent transient network/abort errors from crashing the process
process.on("unhandledRejection", (err) => {
  if (err instanceof DOMException && err.name === "AbortError") {
    console.warn("[server] caught unhandled AbortError (task cancellation) — ignored");
    return;
  }
  // Socket errors from dropped connections (e.g., nginx reload, network hiccup)
  if (err instanceof TypeError && (err.message === "terminated" || err.message === "fetch failed")) {
    console.warn(`[server] caught unhandled network error: ${err.message} — ignored (connection was dropped)`);
    return;
  }
  console.error("[server] unhandled rejection:", err);
});

import express from "express";
import cors from "cors";
import { resolve } from "path";
import { existsSync } from "fs";
import { Db } from "./db";
import { createApiRouter } from "./api";
import { createPlannerRouter } from "./planner-api";
import { createForemanRouter } from "./foreman/api";
import { createDirectorRouter } from "./director/api";
import { startOrchestrator } from "./orchestrator";
import { createVoiceRouter } from "./voice";
import { LlamaCppStt } from "./voice/stt-llamacpp";
import { LlamaCppLlm } from "./voice/llm-llamacpp";
import { LlamaCppTts } from "./voice/tts-llamacpp";
import { PiperHttpTts, PiperCliTts } from "./voice/tts-piper";
import type { TtsAdapter } from "./voice/types";

const PORT = parseInt(process.env.PORT ?? "3001", 10);

// 1. Initialize database
const db = new Db();

// 2. Crash recovery — reset stuck machines/runs from prior crashes
const recovered = db.recoverFromCrash();
const recoveryParts: string[] = [];
if (recovered.machines > 0) recoveryParts.push(`${recovered.machines} machine(s)`);
if (recovered.runs > 0) recoveryParts.push(`${recovered.runs} run(s)`);
if (recovered.issues > 0) recoveryParts.push(`${recovered.issues} issue(s)`);
if (recovered.foremanTasks > 0) recoveryParts.push(`${recovered.foremanTasks} stuck-running task(s)`);
if (recovered.foremanTasksValidating > 0) recoveryParts.push(`${recovered.foremanTasksValidating} stuck-validating task(s)`);
if (recovered.foremanRuns > 0) recoveryParts.push(`${recovered.foremanRuns} foreman run(s)`);
if (recovered.directorDirectives > 0) recoveryParts.push(`${recovered.directorDirectives} directive(s)`);
if (recovered.directorMilestones > 0) recoveryParts.push(`${recovered.directorMilestones} stuck-verifying milestone(s)`);
if (recovered.analysisRuns > 0) recoveryParts.push(`${recovered.analysisRuns} analysis run(s)`);
if (recoveryParts.length > 0) {
  console.log(`[crash-recovery] reset ${recoveryParts.join(", ")}`);
}

// 2a. Prune old history rows. Without this the high-volume tables
// (llm_requests, foreman_runs, runs, analysis_runs) grow unbounded — every
// agent step is logged forever. Retention defaults to 30 days, override
// with SWE_RETENTION_DAYS=N. Setting it to 0 disables the sweep entirely.
const retentionDays = parseInt(process.env.SWE_RETENTION_DAYS ?? "30", 10);
if (Number.isFinite(retentionDays) && retentionDays > 0) {
  const pruned = db.cleanupOldRecords(retentionDays);
  const prunedParts: string[] = [];
  if (pruned.llmRequests > 0) prunedParts.push(`${pruned.llmRequests} llm_request(s)`);
  if (pruned.foremanRuns > 0) prunedParts.push(`${pruned.foremanRuns} foreman_run(s)`);
  if (pruned.runs > 0) prunedParts.push(`${pruned.runs} run(s)`);
  if (pruned.analysisRuns > 0) prunedParts.push(`${pruned.analysisRuns} analysis_run(s)`);
  if (prunedParts.length > 0) {
    console.log(`[startup:cleanup] pruned ${prunedParts.join(", ")} older than ${retentionDays}d`);
  }
}

// 2b. Worktree orphan sweep — best-effort, fire-and-forget. Removes
// worktrees on disk that don't correspond to any active foreman task. Hard
// crashes can leave these stranded; recoverFromCrash() resets the DB row but
// the directory persists. Run per project so cross-project worktrees aren't
// touched. Uses dynamic import so the startup path doesn't pull git.ts
// Diagnostic: log the godot binary location and the orchestrator PATH so
// "verifier can't find godot" failures are obvious from the startup output.
// Logged once. Cheap.
void (async () => {
  try {
    const { runProcess } = await import("./util/async-process");
    const which = await runProcess("which", ["godot"], { timeoutMs: 2000 });
    const godotPath = which.status === 0 ? (which.stdout ?? "").trim() : "(not found)";
    console.log(`[startup:tooling] godot: ${godotPath}`);
    console.log(`[startup:tooling] PATH: ${process.env.PATH ?? "(unset)"}`);
    if (godotPath.startsWith("/snap/")) {
      console.warn(`[startup:tooling] godot is installed via snap (${godotPath}). The bwrap sandbox does NOT bind /snap by default, so verifier godot calls will fail when sandbox_enabled=1. Either install godot to /usr/bin or /usr/local/bin, OR add /snap to the sandbox bind list.`);
    }
  } catch (err) {
    console.warn("[startup:tooling] godot probe failed:", err instanceof Error ? err.message : err);
  }
})();

// before the rest of the app is wired.
void (async () => {
  try {
    const { sweepOrphanWorktrees } = await import("./git");
    const projects = db.getProjects();
    const activeTasks = new Set<string>();
    for (const t of db.getForemanTasks()) {
      if (t.status === "queued" || t.status === "running" || t.status === "validating" || t.status === "awaiting_review") {
        activeTasks.add(t.id);
      }
    }
    let total = 0;
    for (const p of projects) {
      total += await sweepOrphanWorktrees(p.workdir, activeTasks);
    }
    if (total > 0) console.log(`[startup] worktree sweep removed ${total} orphan(s) across ${projects.length} project(s)`);
  } catch (err) {
    console.warn("[startup] worktree sweep failed:", err instanceof Error ? err.message : err);
  }
})();

// 3. Create Express app
const app = express();
app.use(cors());

// Voice pipeline (STT → LLM → TTS) — mounted BEFORE express.json() so binary body parsing works
if (process.env.STT_URL || process.env.VOICE_LLM_URL || process.env.TTS_URL || process.env.PIPER_PATH) {
  // Select TTS adapter: Piper CLI > Piper HTTP > llama.cpp
  let tts: TtsAdapter;
  if (process.env.PIPER_PATH && process.env.PIPER_MODEL) {
    tts = new PiperCliTts(process.env.PIPER_PATH, process.env.PIPER_MODEL, process.env.PIPER_CONFIG);
    console.log(`[voice:tts] Piper CLI (${process.env.PIPER_MODEL})`);
  } else if (process.env.PIPER_URL) {
    tts = new PiperHttpTts(process.env.PIPER_URL);
    console.log(`[voice:tts] Piper HTTP (${process.env.PIPER_URL})`);
  } else {
    tts = new LlamaCppTts(process.env.TTS_URL ?? "http://localhost:8082");
    console.log(`[voice:tts] llama.cpp (${process.env.TTS_URL ?? "http://localhost:8082"})`);
  }

  const voiceRouter = createVoiceRouter({
    stt: new LlamaCppStt(process.env.STT_URL ?? "http://localhost:8080"),
    llm: new LlamaCppLlm(process.env.VOICE_LLM_URL ?? "http://localhost:8081", process.env.VOICE_MODEL_ID ?? "default"),
    tts,
    systemPrompt: process.env.VOICE_SYSTEM_PROMPT,
  });
  app.use("/api/voice", voiceRouter);
  console.log("Voice endpoint enabled at /api/voice");
}

app.use(express.json());

// 4. Mount API routes (with runner context for approve/retry)
app.use("/api", createApiRouter(db, { pipelineCtx: { db } }));
app.use("/api/planner", createPlannerRouter(db));
app.use("/api/foreman", createForemanRouter(db));
app.use("/api/director", createDirectorRouter(db));

// 5. Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// 6. Serve built frontend (production mode)
const clientDir = resolve(__dirname, "../../dist/client");
if (existsSync(clientDir)) {
  app.use(express.static(clientDir));
  // SPA fallback — serve index.html for all non-API routes
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(resolve(clientDir, "index.html"));
  });
  console.log(`Serving frontend from ${clientDir}`);
}

// 7. Start background services
startOrchestrator(db);

// 8. Start server
const server = app.listen(PORT, () => {
  console.log(`auto-swe server listening on http://localhost:${PORT}`);
});

// 9. Terminal WebSocket (PTY for Claude CLI)
import { initPty, attachTerminalServer, shutdownTerminalSessions } from "./terminal";
void initPty().then((ok) => {
  if (ok) attachTerminalServer(server, db);
}).catch(() => {});
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\nFATAL: Port ${PORT} is already in use. Kill the old process first:\n  cmd.exe /c "taskkill /F /PID $(netstat -ano | grep :${PORT} | head -1 | awk '{print $NF}')"\n`);
  } else {
    console.error("[server] error:", err);
  }
  process.exit(1);
});

// 7. Graceful shutdown
let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received — shutting down`);

  // Kill persistent terminal PTYs and close their WebSockets — without this
  // server.close() never drains because each PTY holds a file descriptor open
  // and each WebSocket counts as an active server connection.
  try { shutdownTerminalSessions(); } catch { /* ignore */ }

  server.close(() => {
    db.close();
    console.log("Server closed");
    process.exit(0);
  });
  // Force exit after 3s if draining takes too long (systemd's stop timeout
  // is typically 5s, so leave headroom).
  setTimeout(() => {
    console.log("Forced shutdown after timeout");
    db.close();
    process.exit(1);
  }, 3_000);
}

process.on("SIGTERM", () => { shutdown("SIGTERM"); });
process.on("SIGINT", () => { shutdown("SIGINT"); });

// Re-export for consumers
export { Db } from "./db";
export type { Machine, Project, Issue, Run, ForemanTask, ForemanRun, ForemanConfig, DirectorDirective, DirectorMilestone, DirectorReview, DirectorConversation, DirectorMessage } from "./db";
export {
  ContextBudget,
  makeFilesystemTools,
  makeReadOnlyTools,
  makeTestWriteTools,
  makeVerifyTools,
  fetchUrlTool,
} from "./tools";
