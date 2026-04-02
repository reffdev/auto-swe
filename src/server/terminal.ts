/**
 * Terminal WebSocket server — spawns a PTY running `npx claude` in the
 * project directory and streams stdin/stdout over WebSocket.
 *
 * Supports multiple concurrent sessions. Each WebSocket connection gets
 * its own PTY process.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import type { Db } from "./db";

// node-pty is a native module — dynamic import to handle missing builds gracefully
let pty: typeof import("node-pty") | null = null;

export async function initPty(): Promise<boolean> {
  try {
    pty = await import("node-pty");
    return true;
  } catch (err) {
    console.warn("Terminal: node-pty not available — terminal feature disabled.", err instanceof Error ? err.message : "");
    return false;
  }
}

/**
 * Attach the terminal WebSocket server to the HTTP server.
 * Handles /ws/terminal connections.
 */
export function attachTerminalServer(server: Server, db: Db): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (req.url?.startsWith("/ws/terminal")) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    }
  });

  let activeTerminals = 0;
  const MAX_TERMINALS = 5;

  // Heartbeat — detect dead connections before the OS timeout
  const PING_INTERVAL = 20_000; // 20s
  const pingTimer = setInterval(() => {
    for (const client of wss.clients) {
      if ((client as any).__dead) {
        client.terminate();
        continue;
      }
      (client as any).__dead = true;
      client.ping();
    }
  }, PING_INTERVAL);

  wss.on("close", () => clearInterval(pingTimer));

  wss.on("connection", (ws, req) => {
    // Pong marks the connection as alive
    ws.on("pong", () => { (ws as any).__dead = false; });
    if (!pty) {
      ws.send(JSON.stringify({ type: "error", data: "Terminal not available — node-pty failed to load" }));
      ws.close();
      return;
    }
    if (activeTerminals >= MAX_TERMINALS) {
      ws.send(JSON.stringify({ type: "error", data: `Maximum ${MAX_TERMINALS} terminal sessions reached` }));
      ws.close();
      return;
    }

    // Extract project ID from query string
    const url = new URL(req.url ?? "", "http://localhost");
    const projectId = url.searchParams.get("project");

    let cwd = process.cwd();
    if (projectId) {
      const project = db.getProject(projectId);
      if (project) cwd = project.workdir;
    }

    // Parse initial dimensions
    const cols = parseInt(url.searchParams.get("cols") ?? "120", 10);
    const rows = parseInt(url.searchParams.get("rows") ?? "40", 10);

    activeTerminals++;
    console.log(`Terminal: new session in ${cwd} (${cols}x${rows}) [${activeTerminals}/${MAX_TERMINALS}]`);

    // Spawn PTY
    const shell = process.platform === "win32" ? "powershell.exe" : "bash";
    const args = process.platform === "win32"
      ? ["-Command", "npx @anthropic-ai/claude-code"]
      : ["-c", "npx @anthropic-ai/claude-code"];

    const ptyProcess = pty.spawn(shell, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: "xterm-256color", COLUMNS: String(cols), LINES: String(rows) },
    });

    // PTY → WebSocket
    ptyProcess.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "output", data }));
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      console.log(`Terminal: session exited (code ${exitCode})`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "exit", code: exitCode }));
        ws.close();
      }
    });

    // WebSocket → PTY
    ws.on("message", (msg) => {
      try {
        const parsed = JSON.parse(msg.toString());
        switch (parsed.type) {
          case "input":
            ptyProcess.write(parsed.data);
            break;
          case "resize":
            if (parsed.cols && parsed.rows) {
              ptyProcess.resize(parsed.cols, parsed.rows);
            }
            break;
        }
      } catch {
        // Raw text input fallback
        ptyProcess.write(msg.toString());
      }
    });

    ws.on("close", () => {
      activeTerminals = Math.max(0, activeTerminals - 1);
      console.log(`Terminal: WebSocket closed — killing PTY [${activeTerminals}/${MAX_TERMINALS}]`);
      try { ptyProcess.kill(); } catch { /* already dead */ }
    });

    ws.on("error", () => {
      activeTerminals = Math.max(0, activeTerminals - 1);
      try { ptyProcess.kill(); } catch { /* already dead */ }
    });
  });

  console.log("Terminal WebSocket server attached at /ws/terminal");
}
