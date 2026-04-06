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

// ─── Serialization ──────────────────────────────────────────────────────────
// Milvus Lite doesn't support concurrent access from separate processes.
// All memsearch CLI calls must be serialized through this queue.

let memsearchBusy = false;
const memsearchQueue: Array<() => Promise<void>> = [];

async function withMemsearchLock<T>(fn: () => Promise<T>): Promise<T | null> {
  if (memsearchBusy) {
    // Queue it — will run when current operation finishes
    return new Promise<T | null>((resolve) => {
      memsearchQueue.push(async () => {
        try { resolve(await fn()); } catch { resolve(null); }
      });
    });
  }

  memsearchBusy = true;
  try {
    return await fn();
  } finally {
    memsearchBusy = false;
    // Process next queued operation
    const next = memsearchQueue.shift();
    if (next) void next();
  }
}

// ─── Debounced re-indexing ───────────────────────────────────────────────────

let reindexTimer: ReturnType<typeof setTimeout> | null = null;
let lastIndexedWorkdir: string | null = null;

/**
 * Schedule a re-index after a memory write. Debounced to at most once per 60s.
 */
export function scheduleReindex(projectWorkdir: string): void {
  lastIndexedWorkdir = projectWorkdir;
  if (reindexTimer) return; // already scheduled
  reindexTimer = setTimeout(() => {
    reindexTimer = null;
    if (lastIndexedWorkdir) {
      indexMemories(lastIndexedWorkdir).catch(() => {});
    }
  }, 60_000);
}

/**
 * Index all markdown files in the project's .swe/ directory.
 * Serialized via memsearch lock — only one CLI call at a time.
 */
export async function indexMemories(projectWorkdir: string): Promise<boolean> {
  if (!isMemsearchAvailable()) return false;

  return (await withMemsearchLock(() => doIndex(projectWorkdir))) ?? false;
}

async function doIndex(projectWorkdir: string): Promise<boolean> {

  // Ensure dirs exist before indexing
  const { ensureMemoryDirs } = await import("./persistent-memory");
  ensureMemoryDirs(projectWorkdir);

  const paths = getMemoryPaths(projectWorkdir);

  return new Promise((resolve) => {
    const proc = spawn("memsearch", ["index", ...paths], {
      cwd: projectWorkdir,
    });

    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      if (code !== 0 && stderr) {
        console.warn(`MemSearch index failed (code ${code}): ${stderr.slice(0, 200)}`);
      }
      resolve(code === 0);
    });

    proc.on("error", () => { resolve(false); });
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

  return (await withMemsearchLock(() => doSearch(projectWorkdir, query, topK))) ?? [];
}

async function doSearch(
  projectWorkdir: string,
  query: string,
  topK: number,
): Promise<SearchResult[]> {

  return new Promise((resolve) => {
    const proc = spawn(
      "memsearch",
      ["search", query, "--top-k", String(topK), "--json-output"],
      { cwd: projectWorkdir },
    );

    // Kill if search takes too long
    const searchTimeout = setTimeout(() => { try { proc.kill(); } catch {} }, SEARCH_TIMEOUT_MS);

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      clearTimeout(searchTimeout);
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

    proc.on("error", () => { clearTimeout(searchTimeout); resolve([]); });
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

/** Stop the background watcher and clean up timers. */
export function stopMemsearchWatch(): void {
  if (watchProcess) {
    watchProcess.kill();
    watchProcess = null;
    console.log("MemSearch watcher stopped");
  }
  if (reindexTimer) {
    clearTimeout(reindexTimer);
    reindexTimer = null;
  }
}

// ─── LLM Tools ──────────────────────────────────────────────────────────────

import { z } from "zod";
import { tool } from "ai";
import {
  writeMemory,
  readMemory,
  readMemoryCategory,
  readConventions,
  readProjectBrief,
  writeProjectBrief,
  categoryDir,
  PROJECT_BRIEF_FILENAME,
  type MemoryCategory,
} from "./persistent-memory";

/**
 * Build all Director memory tools for a project.
 */
export function makeMemoryTools(projectWorkdir: string) {
  return {
    searchMemory: tool({
      description:
        "Semantic search across your persistent memory (conventions, semantic memory, " +
        "procedures, episodic logs). Use this to find relevant past knowledge before " +
        "planning or making decisions. Returns ranked results by relevance to the query.",
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

    updateProjectBrief: tool({
      description:
        "Maintain the PROJECT BRIEF — the single document that is ALWAYS injected into " +
        "every agent's context. This is the project's identity card: what it is, what " +
        "it's built with, the most critical rules and patterns. Keep it under ~3000 " +
        "characters — it should be scannable in a few seconds. Update it in-place when " +
        "fundamentals change. Do NOT use this for status updates, learnings, or detailed " +
        "specs — those go in semantic memory or conventions.\n\n" +
        "Good content: tech stack, key architectural decisions, critical invariants " +
        "(e.g. 'all currency math via Big.gd', 'no anti-aliasing on pixel art'), " +
        "essential file/directory layout.\n\n" +
        "Bad content: task lists, status, what was done yesterday, debug findings, " +
        "specifications longer than a few lines.",
      parameters: z.object({
        content: z.string().describe("Full markdown content of the project brief (replaces existing)"),
      }),
      execute: async ({ content }) => {
        const previous = readProjectBrief(projectWorkdir);
        writeProjectBrief(projectWorkdir, content);
        scheduleReindex(projectWorkdir);
        const action = previous ? "Updated" : "Created";
        const warning = content.length > 3000
          ? ` ⚠️ Brief is ${content.length} chars — consider trimming to under 3000 for context efficiency.`
          : "";
        return `${action} PROJECT_BRIEF.md (${content.length} chars).${warning}`;
      },
    }),

    writeSemanticMemory: tool({
      description:
        "Save facts, learnings, status updates, and discoveries. This is the right place " +
        "for things you want to remember but that should NOT be in every agent's context.\n\n" +
        "Use this for:\n" +
        "- Task completion notes and outcomes\n" +
        "- Debug findings and root cause analyses\n" +
        "- Milestone status and progress notes\n" +
        "- User preferences and feedback patterns\n" +
        "- Discovered patterns and behaviors\n" +
        "- Architectural decisions worth recalling\n\n" +
        "These files are surfaced via semantic search when relevant to the current task. " +
        "Write freely — the search system handles relevance. Update existing files in " +
        "place rather than creating new ones for the same topic.",
      parameters: z.object({
        filename: z.string().describe("Descriptive filename (e.g. 'currency-manager-bug-fix.md', 'milestone-2-status.md'). Must end in .md"),
        content: z.string().describe("Markdown content to write"),
      }),
      execute: async ({ filename, content }) => {
        const fname = filename.endsWith(".md") ? filename : `${filename}.md`;
        const existing = readMemory(projectWorkdir, "semantic", fname);
        writeMemory(projectWorkdir, "semantic", fname, content);
        scheduleReindex(projectWorkdir);
        return existing
          ? `Updated semantic memory: ${fname}`
          : `Created semantic memory: ${fname}`;
      },
    }),

    writeConvention: tool({
      description:
        "Save detailed project knowledge: specifications, style guides, and reference " +
        "material. Each convention is a focused document covering ONE topic in depth.\n\n" +
        "Conventions are NOT all loaded at once — they are surfaced via semantic search " +
        "when relevant to a task. Name files specifically so search can find them: " +
        "`currency-manager-spec.md`, `art-guidelines.md`, `gdscript-naming.md`. " +
        "Generic names like `notes.md` or `status.md` won't be found.\n\n" +
        "Use this for KNOWLEDGE that an agent needs when working on a specific area:\n" +
        "- System/module specifications\n" +
        "- Style guides (code, art, naming, formatting)\n" +
        "- File/schema/format definitions\n" +
        "- Detailed reference material for a specific domain\n\n" +
        "Do NOT use this for status updates, completion notes, debug findings, or " +
        "transient state — those belong in semantic memory. If you find yourself writing " +
        "a 'convention' that describes the past rather than how things should be, it's " +
        "semantic memory.\n\n" +
        "There is a separate `updateProjectBrief` tool for the always-injected project " +
        "identity document. Use that for project-level essentials.",
      parameters: z.object({
        filename: z.string().describe("Specific filename (e.g. 'currency-manager-spec.md', 'art-guidelines.md'). Must end in .md"),
        content: z.string().describe("Markdown content to write"),
      }),
      execute: async ({ filename, content }) => {
        const fname = filename.endsWith(".md") ? filename : `${filename}.md`;
        if (fname === PROJECT_BRIEF_FILENAME) {
          return `Use updateProjectBrief to maintain ${PROJECT_BRIEF_FILENAME}, not writeConvention.`;
        }
        const fs = await import("fs");
        const dirPath = resolve(projectWorkdir, ".swe", "conventions");
        const filePath = resolve(dirPath, fname);
        const existing = fs.existsSync(filePath);
        fs.mkdirSync(dirPath, { recursive: true });
        fs.writeFileSync(filePath, content);
        scheduleReindex(projectWorkdir);
        return existing
          ? `Updated convention: ${fname}`
          : `Created convention: ${fname}`;
      },
    }),

    writeProcedure: tool({
      description:
        "Save a step-by-step workflow or how-to guide. Use this for repeatable processes " +
        "an agent might need to follow: how to add a new game, how to generate pixel art, " +
        "how to set up a new system. Procedures are surfaced via semantic search when " +
        "relevant — they are not all loaded at once.\n\n" +
        "A procedure answers 'how do I do X?'. If the answer is 'follow this rule' or " +
        "'these are the constraints', that's a convention, not a procedure.",
      parameters: z.object({
        filename: z.string().describe("Filename (e.g. 'adding-a-new-game.md'). Must end in .md"),
        content: z.string().describe("Markdown content with step-by-step instructions"),
      }),
      execute: async ({ filename, content }) => {
        const fname = filename.endsWith(".md") ? filename : `${filename}.md`;
        const existing = readMemory(projectWorkdir, "procedural", fname);
        writeMemory(projectWorkdir, "procedural", fname, content);
        scheduleReindex(projectWorkdir);
        return existing
          ? `Updated procedure: ${fname}`
          : `Created procedure: ${fname}`;
      },
    }),

    listMemories: tool({
      description:
        "List all files in a memory category. Use 'convention' to see all project " +
        "conventions/specs, 'semantic' for facts and findings, 'procedural' for how-to " +
        "guides, 'episodic' for daily activity logs. Check existing files before writing " +
        "to avoid duplicates.",
      parameters: z.object({
        category: z.enum(["convention", "semantic", "procedural", "episodic"]).describe("Which category to list"),
      }),
      execute: async ({ category }) => {
        if (category === "convention") {
          const entries = readConventions(projectWorkdir);
          if (entries.length === 0) {
            return "No convention files. (PROJECT_BRIEF.md is managed separately via updateProjectBrief.)";
          }
          return entries
            .map(e => `- **${e.filename}** (updated: ${e.updatedAt.toISOString().slice(0, 10)})`)
            .join("\n");
        }
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
        "Read a specific memory file by category and filename. Use 'convention' to read " +
        "convention files (or 'PROJECT_BRIEF' to read the project brief). Use this to " +
        "check existing content before updating.",
      parameters: z.object({
        category: z.enum(["convention", "semantic", "procedural", "episodic"]).describe("Memory category"),
        filename: z.string().describe("Filename to read (e.g. 'tech-stack.md', 'PROJECT_BRIEF.md')"),
      }),
      execute: async ({ category, filename }) => {
        if (category === "convention") {
          const fname = filename.endsWith(".md") ? filename : `${filename}.md`;
          if (fname === PROJECT_BRIEF_FILENAME) {
            const brief = readProjectBrief(projectWorkdir);
            return brief ?? `${PROJECT_BRIEF_FILENAME} does not exist yet.`;
          }
          const fs = await import("fs");
          const filePath = resolve(projectWorkdir, ".swe", "conventions", fname);
          if (!fs.existsSync(filePath)) {
            return `File not found: convention/${fname}`;
          }
          return fs.readFileSync(filePath, "utf-8");
        }
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
        const fs = await import("fs");
        const { createSnapshot } = await import("./persistent-memory");

        const filePath = category === "convention"
          ? resolve(projectWorkdir, ".swe", "conventions", fname)
          : resolve(categoryDir(projectWorkdir, category as MemoryCategory), fname);

        if (!fs.existsSync(filePath)) {
          return `File not found: ${category}/${fname}`;
        }

        createSnapshot(projectWorkdir, `pre-delete-${fname.replace(".md", "")}`);
        fs.unlinkSync(filePath);
        return `Deleted ${category}/${fname} (snapshot created)`;
      },
    }),
  };
}
