/**
 * Auto-SWE server entry point.
 *
 * Express app serving the API on port 3001.
 * Initializes the database, runs crash recovery, and mounts routes.
 */

import { installConsoleCapture } from "./console-log";
installConsoleCapture(); // must be first — before any console.log calls

import express from "express";
import cors from "cors";
import { resolve } from "path";
import { existsSync } from "fs";
import { Db } from "./db";
import { createApiRouter } from "./api";
import { createPlannerRouter } from "./planner-api";
import { startStatsCollector } from "./stats";
import { startAnalysisScheduler } from "./analysis";
import { createForemanRouter } from "./foreman/api";
import { startForemanScheduler } from "./foreman/scheduler";
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
if (recovered.machines > 0 || recovered.runs > 0 || recovered.issues > 0 || recovered.foremanTasks > 0 || recovered.foremanRuns > 0) {
  console.log(`Crash recovery: reset ${recovered.machines} machine(s), ${recovered.runs} run(s), ${recovered.issues} issue(s), ${recovered.foremanTasks} foreman task(s), ${recovered.foremanRuns} foreman run(s)`);
}

// 3. Create Express app
const app = express();
app.use(cors());

// Voice pipeline (STT → LLM → TTS) — mounted BEFORE express.json() so binary body parsing works
if (process.env.STT_URL || process.env.VOICE_LLM_URL || process.env.TTS_URL || process.env.PIPER_PATH) {
  // Select TTS adapter: Piper CLI > Piper HTTP > llama.cpp
  let tts: TtsAdapter;
  if (process.env.PIPER_PATH && process.env.PIPER_MODEL) {
    tts = new PiperCliTts(process.env.PIPER_PATH, process.env.PIPER_MODEL, process.env.PIPER_CONFIG);
    console.log(`Voice TTS: Piper CLI (${process.env.PIPER_MODEL})`);
  } else if (process.env.PIPER_URL) {
    tts = new PiperHttpTts(process.env.PIPER_URL);
    console.log(`Voice TTS: Piper HTTP (${process.env.PIPER_URL})`);
  } else {
    tts = new LlamaCppTts(process.env.TTS_URL ?? "http://localhost:8082");
    console.log(`Voice TTS: llama.cpp (${process.env.TTS_URL ?? "http://localhost:8082"})`);
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
startStatsCollector(db);
startAnalysisScheduler(db);
startForemanScheduler(db);

// 8. Start server
const server = app.listen(PORT, () => {
  console.log(`auto-swe server listening on http://localhost:${PORT}`);
});
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\nFATAL: Port ${PORT} is already in use. Kill the old process first:\n  cmd.exe /c "taskkill /F /PID $(netstat -ano | grep :${PORT} | head -1 | awk '{print $NF}')"\n`);
  } else {
    console.error("Server error:", err);
  }
  process.exit(1);
});

// 7. Graceful shutdown
function shutdown(signal: string) {
  console.log(`\n${signal} received — shutting down`);
  server.close(() => {
    db.close();
    console.log("Server closed");
    process.exit(0);
  });
  // Force exit after 10s if draining takes too long
  setTimeout(() => {
    console.log("Forced shutdown after timeout");
    db.close();
    process.exit(1);
  }, 10_000);
}

process.on("SIGTERM", () => { shutdown("SIGTERM"); });
process.on("SIGINT", () => { shutdown("SIGINT"); });

// Re-export for consumers
export { Db } from "./db";
export type { Machine, Project, Issue, Run, ForemanTask, ForemanRun, ForemanConfig } from "./db";
export {
  ContextBudget,
  makeFilesystemTools,
  makeReadOnlyTools,
  makeTestWriteTools,
  makeVerifyTools,
  fetchUrlTool,
} from "./tools";
