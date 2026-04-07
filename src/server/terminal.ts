/**
 * Terminal WebSocket server — spawns a PTY running `npx claude` in the
 * project directory and streams stdin/stdout over WebSocket.
 *
 * Sessions are persistent per project: a PTY is created on first connect and
 * kept alive on the server even after the WebSocket disconnects. New
 * connections (page reloads, navigation, browser restarts) reattach to the
 * existing PTY and replay its accumulated output buffer.
 *
 * A session ends only when:
 * - The PTY process exits naturally (e.g., user types `exit`)
 * - The client explicitly resets the session via the "kill" message
 * - The server process restarts
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
    console.warn("[terminal] node-pty not available — terminal feature disabled.", err instanceof Error ? err.message : "");
    return false;
  }
}

// ─── Persistent per-project sessions ────────────────────────────────────────

/** Maximum buffered output retained per session (sliding window). */
const MAX_BUFFER_BYTES = 256 * 1024;
/** Maximum number of concurrent persistent sessions. */
const MAX_SESSIONS = 5;

interface PtySession {
  projectId: string;
  ptyProcess: import("node-pty").IPty;
  cwd: string;
  cols: number;
  rows: number;
  /** Sliding window of recent PTY output (ANSI/text). */
  buffer: string;
  /** The WebSocket currently attached to this session (if any). */
  ws: WebSocket | null;
  createdAt: number;
}

const sessions = new Map<string, PtySession>();

function appendToBuffer(session: PtySession, chunk: string): void {
  session.buffer += chunk;
  if (session.buffer.length > MAX_BUFFER_BYTES) {
    // Drop the oldest data — keep the most recent MAX_BUFFER_BYTES
    session.buffer = session.buffer.slice(session.buffer.length - MAX_BUFFER_BYTES);
  }
}

function killSession(session: PtySession, reason: string): void {
  console.log(`[terminal] killing session for project ${session.projectId} (${reason})`);
  try { session.ptyProcess.kill(); } catch { /* already dead */ }
  if (session.ws && session.ws.readyState === WebSocket.OPEN) {
    try { session.ws.close(); } catch { /* ignore */ }
  }
  sessions.delete(session.projectId);
}

/**
 * Kill all active terminal sessions. Call from the shutdown path so the Node
 * process can exit — persistent PTYs would otherwise keep file descriptors
 * open and block server.close() from completing.
 */
export function shutdownTerminalSessions(): void {
  const count = sessions.size;
  if (count === 0) return;
  console.log(`[terminal] shutting down ${count} session(s)`);
  for (const session of sessions.values()) {
    try { session.ptyProcess.kill(); } catch { /* ignore */ }
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      try { session.ws.close(); } catch { /* ignore */ }
    }
  }
  sessions.clear();
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

    // Extract project ID from query string
    const url = new URL(req.url ?? "", "http://localhost");
    const projectId = url.searchParams.get("project");
    if (!projectId) {
      ws.send(JSON.stringify({ type: "error", data: "Missing project ID" }));
      ws.close();
      return;
    }

    // Parse client dimensions (used for new sessions, or to resize an existing one)
    const cols = parseInt(url.searchParams.get("cols") ?? "120", 10);
    const rows = parseInt(url.searchParams.get("rows") ?? "40", 10);

    // Check for an existing session for this project
    let session = sessions.get(projectId);

    if (session) {
      // Reattach to existing session
      // If a previous WebSocket is still attached, detach it (last connect wins).
      if (session.ws && session.ws.readyState === WebSocket.OPEN) {
        console.log(`[terminal] replacing existing client on project ${projectId}`);
        try {
          session.ws.send(JSON.stringify({ type: "error", data: "Session attached to another client" }));
          session.ws.close();
        } catch { /* ignore */ }
      }
      session.ws = ws;
      // Resize PTY to match the new client's dimensions
      try {
        session.ptyProcess.resize(cols, rows);
        session.cols = cols;
        session.rows = rows;
      } catch { /* PTY may have died */ }
      console.log(`[terminal] reattaching to session for project ${projectId} (buffer: ${session.buffer.length} bytes)`);
      // Send the accumulated buffer so the client can replay history
      ws.send(JSON.stringify({ type: "buffer", data: session.buffer }));
    } else {
      // Create a new session
      if (sessions.size >= MAX_SESSIONS) {
        ws.send(JSON.stringify({ type: "error", data: `Maximum ${MAX_SESSIONS} terminal sessions reached. Reset an existing session first.` }));
        ws.close();
        return;
      }

      const project = db.getProject(projectId);
      const cwd = project ? project.workdir : process.cwd();

      console.log(`[terminal] new session in ${cwd} (${cols}x${rows}) [${sessions.size + 1}/${MAX_SESSIONS}]`);

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

      session = {
        projectId,
        ptyProcess,
        cwd,
        cols,
        rows,
        buffer: "",
        ws,
        createdAt: Date.now(),
      };
      sessions.set(projectId, session);

      // PTY → buffer + active WebSocket
      ptyProcess.onData((data: string) => {
        if (!session) return;
        appendToBuffer(session, data);
        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
          session.ws.send(JSON.stringify({ type: "output", data }));
        }
      });

      ptyProcess.onExit(({ exitCode }) => {
        if (!session) return;
        console.log(`[terminal] PTY exited for project ${projectId} (code ${exitCode})`);
        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
          session.ws.send(JSON.stringify({ type: "exit", code: exitCode }));
          try { session.ws.close(); } catch { /* ignore */ }
        }
        sessions.delete(projectId);
      });
    }

    // WebSocket → PTY
    ws.on("message", (msg) => {
      // Resolve the live session each time (the map entry may have changed)
      const s = sessions.get(projectId);
      if (!s) return;
      try {
        const parsed = JSON.parse(msg.toString());
        switch (parsed.type) {
          case "input":
            s.ptyProcess.write(parsed.data);
            break;
          case "resize":
            if (parsed.cols && parsed.rows) {
              try {
                s.ptyProcess.resize(parsed.cols, parsed.rows);
                s.cols = parsed.cols;
                s.rows = parsed.rows;
              } catch { /* PTY may have died */ }
            }
            break;
          case "kill":
            // Client explicitly requested session termination
            killSession(s, "client requested kill");
            break;
        }
      } catch {
        // Raw text input fallback
        s.ptyProcess.write(msg.toString());
      }
    });

    ws.on("close", () => {
      // Detach this client from its session BUT keep the PTY running.
      // The session persists until the PTY exits, the client kills it, or
      // the server restarts.
      const s = sessions.get(projectId);
      if (s && s.ws === ws) {
        s.ws = null;
        console.log(`[terminal] client detached from session ${projectId} (PTY still running, ${sessions.size} active sessions)`);
      }
    });

    ws.on("error", (err) => {
      console.warn(`[terminal] WebSocket error for project ${projectId}:`, err.message);
      const s = sessions.get(projectId);
      if (s && s.ws === ws) {
        s.ws = null;
      }
    });
  });

  console.log("Terminal WebSocket server attached at /ws/terminal");
}
