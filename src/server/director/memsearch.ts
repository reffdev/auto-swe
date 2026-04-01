/**
 * MemSearch integration — semantic search over the Director's markdown memory.
 *
 * Wraps the `memsearch` Python CLI to provide:
 * - Indexing: index .swe/memory/ and .swe/conventions/ markdown files
 * - Search: semantic search across all memories
 * - Watch: background file watcher for auto-indexing
 *
 * Install: pip install "memsearch[onnx]"
 * Docs: https://github.com/zilliztech/memsearch
 */

import { spawn, spawnSync, type ChildProcess } from "child_process";
import { resolve } from "path";

const SEARCH_TIMEOUT_MS = 10_000;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SearchResult {
  content: string;
  score: number;
  source?: string;
}

// ─── Availability ───────────────────────────────────────────────────────────

let memsearchAvailable: boolean | null = null;

/** Check if memsearch CLI is installed. Cached after first check. */
export function isMemsearchAvailable(): boolean {
  if (memsearchAvailable !== null) return memsearchAvailable;
  try {
    const result = spawnSync("memsearch", ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    memsearchAvailable = result.status === 0;
  } catch {
    memsearchAvailable = false;
  }
  if (!memsearchAvailable) {
    console.log("MemSearch not installed — semantic memory search disabled. Install with: pip install \"memsearch[onnx]\"");
  }
  return memsearchAvailable;
}

// ─── Memory Paths ───────────────────────────────────────────────────────────

/** Get the directories memsearch should index for a project. */
function getMemoryPaths(projectWorkdir: string): string[] {
  return [
    resolve(projectWorkdir, ".swe", "memory"),
    resolve(projectWorkdir, ".swe", "conventions"),
  ];
}

// ─── Indexing ───────────────────────────────────────────────────────────────

/**
 * Index all markdown files in the project's .swe/ directory.
 * Should be called on startup and after writing new memories.
 */
export async function indexMemories(projectWorkdir: string): Promise<boolean> {
  if (!isMemsearchAvailable()) return false;

  // Ensure dirs exist before indexing
  const { ensureMemoryDirs } = await import("./persistent-memory");
  ensureMemoryDirs(projectWorkdir);

  const paths = getMemoryPaths(projectWorkdir);

  return new Promise((resolve) => {
    const proc = spawn("memsearch", ["index", ...paths], {
      cwd: projectWorkdir,
      encoding: "utf-8",
      timeout: 30_000,
    } as any);

    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      if (code !== 0 && stderr) {
        console.warn(`MemSearch index failed (code ${code}): ${stderr.slice(0, 200)}`);
      }
      resolve(code === 0);
    });

    proc.on("error", () => resolve(false));
  });
}

// ─── Search ─────────────────────────────────────────────────────────────────

/**
 * Semantic search across all project memories.
 * Returns ranked results with content and similarity scores.
 */
export async function searchMemories(
  projectWorkdir: string,
  query: string,
  topK: number = 5,
): Promise<SearchResult[]> {
  if (!isMemsearchAvailable()) return [];

  return new Promise((resolve) => {
    const proc = spawn(
      "memsearch",
      ["search", query, "--top-k", String(topK), "--json-output"],
      {
        cwd: projectWorkdir,
        encoding: "utf-8",
        timeout: SEARCH_TIMEOUT_MS,
      } as any,
    );

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      if (code !== 0) {
        if (stderr) console.warn(`MemSearch search failed: ${stderr.slice(0, 200)}`);
        resolve([]);
        return;
      }
      try {
        const results = JSON.parse(stdout);
        if (Array.isArray(results)) {
          resolve(results.map((r: any) => ({
            content: String(r.content ?? r.text ?? ""),
            score: Number(r.score ?? r.distance ?? 0),
            source: r.source ?? r.file ?? undefined,
          })));
        } else {
          resolve([]);
        }
      } catch {
        resolve([]);
      }
    });

    proc.on("error", () => resolve([]));
  });
}

// ─── Watch ──────────────────────────────────────────────────────────────────

let watchProcess: ChildProcess | null = null;

/**
 * Start the memsearch file watcher in the background.
 * Auto-indexes new/modified markdown files.
 */
export function startMemsearchWatch(projectWorkdir: string): void {
  if (!isMemsearchAvailable()) return;
  if (watchProcess) return; // already watching

  const paths = getMemoryPaths(projectWorkdir);

  watchProcess = spawn("memsearch", ["watch", ...paths], {
    cwd: projectWorkdir,
    stdio: "ignore",
    detached: true,
  });

  watchProcess.unref(); // don't keep the Node process alive for this

  watchProcess.on("exit", (code) => {
    console.log(`MemSearch watcher exited (code ${code})`);
    watchProcess = null;
  });

  watchProcess.on("error", (err) => {
    console.warn("MemSearch watcher failed to start:", err.message);
    watchProcess = null;
  });

  console.log("MemSearch watcher started");
}

/** Stop the background watcher. */
export function stopMemsearchWatch(): void {
  if (watchProcess) {
    watchProcess.kill();
    watchProcess = null;
    console.log("MemSearch watcher stopped");
  }
}

// ─── LLM Tools ──────────────────────────────────────────────────────────────

import { z } from "zod";
import { tool } from "ai";
import {
  writeMemory,
  readMemory,
  readMemoryCategory,
  categoryDir,
  type MemoryCategory,
} from "./persistent-memory";

/**
 * Build all Director memory tools for a project.
 */
export function makeMemoryTools(projectWorkdir: string) {
  return {
    searchMemory: tool({
      description:
        "Search your persistent memory for relevant context. Use this to recall " +
        "past decisions, conventions, workflows, and previous activity. Returns " +
        "semantically similar memory chunks ranked by relevance.",
      parameters: z.object({
        query: z.string().describe("What to search for in memory (natural language)"),
        top_k: z.number().optional().describe("Number of results to return (default: 5)"),
      }),
      execute: async ({ query, top_k }) => {
        const results = await searchMemories(projectWorkdir, query, top_k ?? 5);
        if (results.length === 0) {
          return "No relevant memories found.";
        }
        return results
          .map((r, i) => `**${i + 1}.** (score: ${r.score.toFixed(3)})${r.source ? ` [${r.source}]` : ""}\n${r.content}`)
          .join("\n\n---\n\n");
      },
    }),

    writeSemanticMemory: tool({
      description:
        "Save a stable fact, preference, or piece of knowledge to long-term memory. " +
        "Use this for things that are unlikely to change and should be remembered across " +
        "sessions: project constraints, user preferences, architectural decisions, " +
        "discovered patterns. Each file is a topic — update existing files rather than " +
        "creating duplicates.",
      parameters: z.object({
        filename: z.string().describe("Filename (e.g. 'tech-stack.md', 'user-preferences.md'). Must end in .md"),
        content: z.string().describe("Markdown content to write"),
      }),
      execute: async ({ filename, content }) => {
        const fname = filename.endsWith(".md") ? filename : `${filename}.md`;
        const existing = readMemory(projectWorkdir, "semantic", fname);
        writeMemory(projectWorkdir, "semantic", fname, content);
        return existing
          ? `Updated semantic memory: ${fname}`
          : `Created semantic memory: ${fname}`;
      },
    }),

    writeConvention: tool({
      description:
        "Save a project convention, style rule, or standard. Use this for rules that " +
        "all agents and tasks should follow: coding conventions, naming patterns, " +
        "art style guidelines, commit message formats. These are injected into every " +
        "planning context with highest priority.",
      parameters: z.object({
        filename: z.string().describe("Filename (e.g. 'code-style.md', 'art-guidelines.md'). Must end in .md"),
        content: z.string().describe("Markdown content to write"),
      }),
      execute: async ({ filename, content }) => {
        const fname = filename.endsWith(".md") ? filename : `${filename}.md`;
        const { existsSync: exists, mkdirSync: mkdir, writeFileSync: writeFile } = await import("fs");
        const dirPath = resolve(projectWorkdir, ".swe", "conventions");
        const filePath = resolve(dirPath, fname);
        const existing = exists(filePath);
        mkdir(dirPath, { recursive: true });
        writeFile(filePath, content);
        return existing
          ? `Updated convention: ${fname}`
          : `Created convention: ${fname}`;
      },
    }),

    writeProcedure: tool({
      description:
        "Save a workflow or how-to guide. Use this for repeatable processes: " +
        "how to add a new game, how to generate pixel art assets, how to set up " +
        "a new system. Step-by-step instructions that can be followed by future " +
        "planning sessions.",
      parameters: z.object({
        filename: z.string().describe("Filename (e.g. 'adding-a-new-game.md'). Must end in .md"),
        content: z.string().describe("Markdown content with step-by-step instructions"),
      }),
      execute: async ({ filename, content }) => {
        const fname = filename.endsWith(".md") ? filename : `${filename}.md`;
        const existing = readMemory(projectWorkdir, "procedural", fname);
        writeMemory(projectWorkdir, "procedural", fname, content);
        return existing
          ? `Updated procedure: ${fname}`
          : `Created procedure: ${fname}`;
      },
    }),

    listMemories: tool({
      description:
        "List all files in a memory category. Use this to see what memories exist " +
        "before writing, to avoid duplicates.",
      parameters: z.object({
        category: z.enum(["semantic", "procedural", "episodic"]).describe("Which memory category to list"),
      }),
      execute: async ({ category }) => {
        const entries = readMemoryCategory(projectWorkdir, category as MemoryCategory);
        if (entries.length === 0) {
          return `No files in ${category} memory.`;
        }
        return entries
          .map(e => `- **${e.filename}** (updated: ${e.updatedAt.toISOString().slice(0, 10)})`)
          .join("\n");
      },
    }),

    readMemoryFile: tool({
      description:
        "Read a specific memory file by category and filename. Use this to check " +
        "existing content before updating a memory.",
      parameters: z.object({
        category: z.enum(["semantic", "procedural", "episodic"]).describe("Memory category"),
        filename: z.string().describe("Filename to read (e.g. 'tech-stack.md')"),
      }),
      execute: async ({ category, filename }) => {
        const content = readMemory(projectWorkdir, category as MemoryCategory, filename);
        if (!content) {
          return `File not found: ${category}/${filename}`;
        }
        return content;
      },
    }),

    editMemory: tool({
      description:
        "Edit an existing memory file by replacing a specific section of text. " +
        "Use readMemoryFile first to see the current content, then provide the " +
        "exact text to find and what to replace it with. For conventions, use " +
        "category 'convention'.",
      parameters: z.object({
        category: z.enum(["semantic", "procedural", "episodic", "convention"]).describe("Memory category"),
        filename: z.string().describe("Filename to edit"),
        old_text: z.string().describe("Exact text to find in the file"),
        new_text: z.string().describe("Text to replace it with"),
      }),
      execute: async ({ category, filename, old_text, new_text }) => {
        const fname = filename.endsWith(".md") ? filename : `${filename}.md`;

        const filePath = category === "convention"
          ? resolve(projectWorkdir, ".swe", "conventions", fname)
          : resolve(categoryDir(projectWorkdir, category as MemoryCategory), fname);

        let content: string | null;
        try {
          const { readFileSync } = await import("fs");
          content = readFileSync(filePath, "utf-8");
        } catch {
          content = null;
        }

        if (!content) {
          return `File not found: ${category}/${fname}`;
        }
        if (!content.includes(old_text)) {
          return `Text not found in ${category}/${fname}. Use readMemoryFile to see current content.`;
        }

        const updated = content.replace(old_text, new_text);
        const { writeFileSync } = await import("fs");
        writeFileSync(filePath, updated);

        return `Edited ${category}/${fname}`;
      },
    }),

    deleteMemory: tool({
      description:
        "Delete a memory file that is no longer relevant. Use with caution — " +
        "a snapshot is created before deletion. For conventions, use category 'convention'.",
      parameters: z.object({
        category: z.enum(["semantic", "procedural", "convention"]).describe("Memory category (cannot delete episodic)"),
        filename: z.string().describe("Filename to delete"),
      }),
      execute: async ({ category, filename }) => {
        const fname = filename.endsWith(".md") ? filename : `${filename}.md`;
        const { unlinkSync, existsSync: exists } = await import("fs");
        const { createSnapshot } = await import("./persistent-memory");

        const filePath = category === "convention"
          ? resolve(projectWorkdir, ".swe", "conventions", fname)
          : resolve(categoryDir(projectWorkdir, category as MemoryCategory), fname);

        if (!exists(filePath)) {
          return `File not found: ${category}/${fname}`;
        }

        createSnapshot(projectWorkdir, `pre-delete-${fname.replace(".md", "")}`);
        unlinkSync(filePath);
        return `Deleted ${category}/${fname} (snapshot created)`;
      },
    }),
  };
}
