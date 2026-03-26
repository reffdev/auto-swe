/**
 * Auto-SWE server entry point.
 *
 * Express app serving the API on port 3001.
 * Initializes the database, runs crash recovery, and mounts routes.
 */

import express from "express";
import cors from "cors";
import { resolve } from "path";
import { existsSync } from "fs";
import { Db } from "./db";
import { createApiRouter } from "./api";
import { createPlannerRouter } from "./planner-api";

const PORT = parseInt(process.env.PORT ?? "3001", 10);

// 1. Initialize database
const db = new Db();

// 2. Crash recovery — reset stuck machines/runs from prior crashes
const recovered = db.recoverFromCrash();
if (recovered.machines > 0 || recovered.runs > 0 || recovered.issues > 0) {
  console.log(`Crash recovery: reset ${recovered.machines} machine(s), ${recovered.runs} run(s), ${recovered.issues} issue(s)`);
}

// 3. Create Express app
const app = express();
app.use(cors());
app.use(express.json());


// 4. Mount API routes (with runner context for approve/retry)
app.use("/api", createApiRouter(db, { pipelineCtx: { db } }));
app.use("/api/planner", createPlannerRouter(db));

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

// 7. Start server
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

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Re-export for consumers
export { Db } from "./db";
export type { Machine, Project, Issue, Run } from "./db";
export {
  ContextBudget,
  makeFilesystemTools,
  makeReadOnlyTools,
  makeTestWriteTools,
  makeVerifyTools,
  fetchUrlTool,
} from "./tools";
