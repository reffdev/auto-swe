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

import { spawn } from "child_process";
import { resolve } from "path";
import { runProcess } from "../util/async-process";

const SEARCH_TIMEOUT_MS = 10_000;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SearchResult {
  content: string;
  score: number;
  source?: string;
}

// ─── Availability ───────────────────────────────────────────────────────────

let memsearchAvailable: boolean | null = null;

/**
 * Eagerly probe whether the `memsearch` CLI is installed.
 *
 * Started at module load (see `void probeMemsearch()` below). Once the probe
 * resolves, `isMemsearchAvailable()` — which is called from many sync contexts
 * (tick loops, tool dispatch) — returns the cached boolean immediately without
 * blocking on an async check.
 *
 * The probe itself uses the async subprocess helper so startup doesn't block
 * the event loop.
 */
async function probeMemsearch(): Promise<void> {
  try {
    const result = await runProcess("memsearch", ["--version"], { timeoutMs: 5_000 });
    memsearchAvailable = result.status === 0;
  } catch {
    memsearchAvailable = false;
  }
  if (!memsearchAvailable) {
    console.log("MemSearch not installed — semantic memory search disabled. Install with: pip install \"memsearch[onnx]\"");
  }
}
void probeMemsearch();

/**
 * Sync check for memsearch availability. Returns false until the probe
 * completes (first few ms of startup). This is intentional — we prefer to
 * briefly report "unavailable" during startup over blocking the event loop.
 */
export function isMemsearchAvailable(): boolean {
  return memsearchAvailable === true;
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
  await ensureMemoryDirs(projectWorkdir);

  const paths = getMemoryPaths(projectWorkdir);

  return new Promise((resolve) => {
    const proc = spawn("memsearch", ["index", ...paths], {
      cwd: projectWorkdir,
    });

    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      if (code !== 0 && stderr) {
        console.warn(`[memsearch] index failed (code ${code}): ${stderr.slice(0, 200)}`);
      }
      resolve(code === 0);
    });

    proc.on("error", () => { resolve(false); });
  });
}

// ─── Search ─────────────────────────────────────────────────────────────────

/** Maximum number of search retries when the Milvus DB file is locked. */
const SEARCH_MAX_RETRIES = 3;
/** Delay between search retries (exponential: 250ms, 500ms, 1000ms). */
const SEARCH_RETRY_BASE_MS = 250;

/** Result of a single doSearch attempt — distinguishes "no results" from "lock contention". */
interface SearchAttempt {
  results: SearchResult[];
  /** True if the search failed because the Milvus DB file was locked by another process. */
  locked: boolean;
}

/**
 * Semantic search across all project memories.
 * Returns ranked results with content and similarity scores.
 *
 * Retries on Milvus Lite lock contention — the DB only allows one writer at a
 * time, so a concurrent reindex can briefly block searches.
 */
export async function searchMemories(
  projectWorkdir: string,
  query: string,
  topK: number = 5,
): Promise<SearchResult[]> {
  if (!isMemsearchAvailable()) return [];

  let raw: SearchResult[] = [];
  for (let attempt = 0; attempt <= SEARCH_MAX_RETRIES; attempt++) {
    const result = await withMemsearchLock(() => doSearch(projectWorkdir, query, topK * 2));
    if (!result) return [];
    if (!result.locked) {
      raw = result.results;
      break;
    }
    if (attempt < SEARCH_MAX_RETRIES) {
      const delay = SEARCH_RETRY_BASE_MS * Math.pow(2, attempt);
      console.warn(`[memsearch] DB locked, retrying in ${delay}ms (attempt ${attempt + 1}/${SEARCH_MAX_RETRIES})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  if (raw.length === 0) return [];

  // Re-rank with a recency bonus. Pure relevance ranking can let stale
  // conventions outrank newer ones that contradict them — older convention
  // files describing how the project USED to work get matched on the same
  // keywords as the recent ones, and the embedding score doesn't care about
  // age. We over-fetch (topK*2) and then blend score + recency to pick the
  // final topK.
  //
  // Recency bonus: linear decay from 1.0 at "modified now" to 0.0 at "30+
  // days ago". Combined as: combinedScore = relevance * 0.85 + recency * 0.15.
  // The 85/15 split keeps relevance dominant (a stale-but-perfect match
  // still wins over a fresh-but-irrelevant one) while breaking ties in favor
  // of recent updates.
  const enriched = await enrichWithMtime(projectWorkdir, raw);
  const now = Date.now();
  const RECENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
  for (const r of enriched) {
    const ageMs = r.mtimeMs ? Math.max(0, now - r.mtimeMs) : RECENCY_WINDOW_MS;
    const recency = Math.max(0, 1 - ageMs / RECENCY_WINDOW_MS);
    r.combinedScore = r.score * 0.85 + recency * 0.15;
  }
  enriched.sort((a, b) => (b.combinedScore ?? 0) - (a.combinedScore ?? 0));
  return enriched.slice(0, topK);
}

interface EnrichedResult extends SearchResult {
  mtimeMs?: number;
  combinedScore?: number;
}

async function enrichWithMtime(projectWorkdir: string, results: SearchResult[]): Promise<EnrichedResult[]> {
  const { stat: fsStat } = await import("fs/promises");
  const { resolve: resolvePath } = await import("path");
  const out: EnrichedResult[] = [];
  for (const r of results) {
    const enriched: EnrichedResult = { ...r };
    if (r.source) {
      try {
        const stat = await fsStat(resolvePath(projectWorkdir, ".swe", r.source));
        enriched.mtimeMs = stat.mtimeMs;
      } catch {
        // Memsearch returns sources relative to .swe/; if mtime fails the
        // recency bonus is just 0 and the result still ranks by relevance.
      }
    }
    out.push(enriched);
  }
  return out;
}

async function doSearch(
  projectWorkdir: string,
  query: string,
  topK: number,
): Promise<SearchAttempt> {

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
        // Detect Milvus Lite lock contention so the caller can retry.
        const locked = /opened by another program|database is locked|file has been opened/i.test(stderr);
        if (!locked && stderr) {
          console.warn(`[memsearch] search failed: ${stderr.slice(0, 200)}`);
        }
        resolve({ results: [], locked });
        return;
      }
      try {
        const results = JSON.parse(stdout);
        if (Array.isArray(results)) {
          resolve({
            locked: false,
            results: results.map((r: any) => ({
              content: String(r.content ?? r.text ?? ""),
              score: Number(r.score ?? r.distance ?? 0),
              source: r.source ?? r.file ?? undefined,
            })),
          });
        } else {
          resolve({ results: [], locked: false });
        }
      } catch {
        resolve({ results: [], locked: false });
      }
    });

    proc.on("error", () => { clearTimeout(searchTimeout); resolve({ results: [], locked: false }); });
  });
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

/**
 * Stop any pending reindex timers. Call on server shutdown.
 *
 * Note: there is no file watcher process. We rely on the post-write hook in
 * persistent-memory.ts (registered above) to schedule reindexes after writes —
 * a long-running `memsearch watch` subprocess would hold the Milvus DB file
 * open and block search calls.
 */
export function stopMemsearchWatch(): void {
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
  readConvention,
  writeConvention,
  deleteConvention,
  readProjectBrief,
  writeProjectBrief,
  categoryDir,
  setMemoryWriteHook,
  PROJECT_BRIEF_FILENAME,
  type MemoryCategory,
} from "./persistent-memory";

// ─── Wire up the post-write reindex hook ────────────────────────────────────
//
// persistent-memory.ts is the lower-level write layer; memsearch.ts is the
// higher-level search/index layer. Rather than have persistent-memory import
// memsearch (circular dependency), persistent-memory exposes a write hook
// that we register here at module load. Every memory write — including
// episodic logs — will now trigger a debounced reindex automatically.
setMemoryWriteHook((workdir) => {
  scheduleReindex(workdir);
});

// ─── Junk-write validator ────────────────────────────────────────────────
//
// Centralizes the rejection rules for memory writes so writeSemanticMemory
// and writeConvention apply the same checks. The patterns come from a real
// audit of accumulated junk in `.swe/memory/semantic/` — the agent had a
// strong tendency to journal in-progress task state ("X-fix-needed.md",
// "X-status.md", "X-implementation-plan.md") and to mirror specifications
// from conventions/ into semantic/. Both shapes are caught here.

interface MemoryValidationResult {
  ok: boolean;
  reason?: string;
}

/** Filename patterns that indicate ephemeral/journal content. Hard reject. */
const JUNK_FILENAME_PATTERNS: Array<{ re: RegExp; hint: string }> = [
  { re: /(?:^|-)tasks?(?:-|\.md$)/i,           hint: "task notes — use the task list, not memory" },
  { re: /(?:^|-)fix(?:es)?(?:-|\.md$)/i,       hint: "fix recipe — fix is in code, rationale is in commit" },
  { re: /(?:^|-)bugs?(?:-|\.md$)/i,            hint: "bug snapshot — save the prevention rule, not the bug" },
  { re: /(?:^|-)status(?:-|\.md$)/i,           hint: "status snapshot — re-derive from git/tasks" },
  { re: /(?:^|-)pending(?:-|\.md$)/i,          hint: "in-progress state — task list" },
  { re: /(?:^|-)needed(?:-|\.md$)/i,           hint: "TODO state — task list" },
  { re: /(?:^|-)found(?:-|\.md$)/i,            hint: "discovery snapshot — save the durable lesson" },
  { re: /(?:^|-)verified(?:-|\.md$)/i,         hint: "verification snapshot — re-verify when needed" },
  { re: /(?:^|-)verification(?:-|\.md$)/i,     hint: "verification snapshot — re-verify when needed" },
  { re: /(?:^|-)batch(?:-|\.md$)/i,            hint: "activity log — episodic memory captures this" },
  { re: /(?:^|-)complete(?:d)?(?:-|\.md$)/i,   hint: "completion log — what was completed is in git" },
  { re: /(?:^|-)created(?:-|\.md$)/i,          hint: "creation log — repo state is in git" },
  { re: /(?:^|-)next-steps?(?:-|\.md$)/i,      hint: "TODO list — task list" },
  { re: /(?:^|-)plan(?:ning)?(?:-|\.md$)/i,    hint: "planning notes — task list / planner output" },
  { re: /(?:^|-)details?(?:-|\.md$)/i,         hint: "task details — task description" },
  { re: /(?:^|-)blockers?(?:-|\.md$)/i,        hint: "blocker snapshot — task list" },
  { re: /(?:^|-)current-state(?:-|\.md$)/i,    hint: "snapshot of repo state — derivable from ls/grep" },
  { re: /(?:^|-)implementation-(?:plan|guide|status)(?:-|\.md$)/i, hint: "task-shaped planning notes — task description" },
  { re: /(?:^|-)milestone-(?:blocker|unblock|resolution)(?:-|\.md$)/i, hint: "milestone state — re-derive from milestones table" },
  { re: /(?:^|-)rewrite-plan(?:-|\.md$)/i,     hint: "rewrite plan — task description" },
  { re: /(?:^|-)spec-compliance(?:-|\.md$)/i,  hint: "spec mirror — the spec is in conventions/, not semantic" },
];

/** Phrases inside the body that indicate ephemeral/journal content. */
const JUNK_BODY_MARKERS: Array<{ re: RegExp; hint: string }> = [
  { re: /\b(?:TODO|FIXME)\b/i,                          hint: "contains TODO/FIXME — that's a task, not durable knowledge" },
  { re: /\bcurrent implementation\b/i,                  hint: "describes 'current implementation' — frozen snapshot, will drift" },
  { re: /\bfailed tasks?\b/i,                           hint: "describes 'failed tasks' — task list state, not memory" },
  { re: /\brequired fix order\b/i,                      hint: "describes a fix sequence — that's a task plan, not memory" },
  { re: /\bnext steps?\b/i,                             hint: "describes 'next steps' — task list, not memory" },
  { re: /\bmissing (?:test )?(?:assets|files)\b/i,      hint: "describes missing artifacts — repo state, not memory" },
  { re: /\b(?:will be|to be) (?:fixed|implemented|added|done)\b/i, hint: "future tense — that's a task, not memory" },
  { re: /\b(?:as of|currently)[\s:]/i,                  hint: "time-bound snapshot ('as of...', 'currently...') — will go stale" },
  { re: /^\s*\*\*Date:\*\*/im,                          hint: "dated header — that's an activity log entry" },
  { re: /^#+ +(?:Task|Failed) /im,                      hint: "Task-headed sections — task list shape" },
];

async function validateMemoryWrite(
  projectWorkdir: string,
  category: "semantic" | "conventions",
  fname: string,
  content: string,
): Promise<MemoryValidationResult> {
  // 1. Filename pattern rejection.
  for (const { re, hint } of JUNK_FILENAME_PATTERNS) {
    if (re.test(fname)) {
      return {
        ok: false,
        reason: `Refused: filename "${fname}" looks like ${hint}. Memory is for durable knowledge that passes the durability test ("still true and useful in 30 days, AND not derivable from code/git/grep"). Re-route this content to where it belongs (task description, commit message, conventions/, or — most likely — leave it out).`,
      };
    }
  }

  // 2. Body content marker rejection.
  for (const { re, hint } of JUNK_BODY_MARKERS) {
    if (re.test(content)) {
      return {
        ok: false,
        reason: `Refused: body ${hint}. This is ephemeral content masquerading as durable knowledge. Apply the durability test before saving.`,
      };
    }
  }

  // 3. Same-day journaling check: if 3+ existing files share a token prefix
  // with the new filename and were written today, the agent is journaling on
  // a single feature instead of consolidating.
  try {
    const dir = categoryDir(projectWorkdir, category as MemoryCategory);
    const { readdir, stat } = await import("fs/promises");
    const { join } = await import("path");
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return { ok: true };
    }
    const stem = fname.replace(/\.md$/, "");
    const tokens = stem.split("-").filter(t => t.length > 2);
    if (tokens.length === 0) return { ok: true };
    const today = new Date().toISOString().slice(0, 10);
    let sameDayMatches = 0;
    const matchedNames: string[] = [];
    for (const entry of entries) {
      if (entry === fname || !entry.endsWith(".md")) continue;
      const entryStem = entry.replace(/\.md$/, "");
      const entryTokens = new Set(entryStem.split("-"));
      const overlap = tokens.filter(t => entryTokens.has(t)).length;
      if (overlap >= 2) {
        try {
          const st = await stat(join(dir, entry));
          if (st.mtime.toISOString().slice(0, 10) === today) {
            sameDayMatches++;
            matchedNames.push(entry);
          }
        } catch { /* ignore */ }
      }
    }
    if (sameDayMatches >= 2) {
      return {
        ok: false,
        reason: `Refused: ${sameDayMatches} memory file(s) on the same topic were already written today (${matchedNames.slice(0, 3).join(", ")}). This is journaling, not curation. Use editMemory to UPDATE one of the existing files, or skip the write entirely if the content is ephemeral.`,
      };
    }
  } catch { /* validation is best-effort; never crash a write because the check failed */ }

  return { ok: true };
}

/**
 * Scan a project's memory directories for files matching the junk patterns.
 * READ-ONLY — returns the list of candidate files for review. The caller
 * decides whether to delete. Used by an admin endpoint so the user can
 * audit accumulated pollution without me guessing filenames.
 */
export async function findJunkMemories(projectWorkdir: string): Promise<{
  semantic: Array<{ name: string; reason: string; sizeBytes: number; mtime: string }>;
  conventions: Array<{ name: string; reason: string; sizeBytes: number; mtime: string }>;
}> {
  const { readdir, stat, readFile } = await import("fs/promises");
  const { join } = await import("path");

  async function scan(category: "semantic" | "conventions") {
    const dir = categoryDir(projectWorkdir, category as MemoryCategory);
    const out: Array<{ name: string; reason: string; sizeBytes: number; mtime: string }> = [];
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      // Check filename patterns first (cheap)
      let reason: string | null = null;
      for (const { re, hint } of JUNK_FILENAME_PATTERNS) {
        if (re.test(entry)) { reason = `filename: ${hint}`; break; }
      }
      // If filename is clean, sample the body for marker phrases
      if (!reason) {
        try {
          const content = await readFile(join(dir, entry), "utf-8");
          for (const { re, hint } of JUNK_BODY_MARKERS) {
            if (re.test(content)) { reason = `body: ${hint}`; break; }
          }
        } catch { /* skip */ }
      }
      if (reason) {
        try {
          const st = await stat(join(dir, entry));
          out.push({
            name: entry,
            reason,
            sizeBytes: st.size,
            mtime: st.mtime.toISOString(),
          });
        } catch { /* skip */ }
      }
    }
    return out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  }

  return {
    semantic: await scan("semantic"),
    conventions: await scan("conventions"),
  };
}

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
        "Maintain the PROJECT BRIEF — the single document injected into EVERY agent " +
        "call. Hard cap ~3000 chars. Identity only: tech stack, hard invariants, " +
        "top-level architecture. NO status, NO TODOs, NO activity logs (those bloat " +
        "every agent call). Updates rarely — if you're updating more than once per " +
        "milestone, you're writing status, not identity.",
      parameters: z.object({
        content: z.string().describe("Full markdown content of the project brief (replaces existing)"),
      }),
      execute: async ({ content }) => {
        const previous = await readProjectBrief(projectWorkdir);
        await writeProjectBrief(projectWorkdir, content);
        const action = previous ? "Updated" : "Created";
        const warning = content.length > 3000
          ? ` ⚠️ Brief is ${content.length} chars — consider trimming to under 3000 for context efficiency.`
          : "";
        return `${action} PROJECT_BRIEF.md (${content.length} chars).${warning}`;
      },
    }),

    writeSemanticMemory: tool({
      description:
        "Save durable project knowledge — the WHY behind a decision, a non-obvious " +
        "gotcha, a user preference. Apply the durability test from the system prompt " +
        "before saving (still true in 30 days AND not derivable from code/git/grep). " +
        "Search first; update existing memories instead of creating new files on the " +
        "same topic. Topic-named filenames only (NOT task-/fix-/status- shapes).",
      parameters: z.object({
        filename: z.string().describe("Topic name, e.g. 'big-gd-precision.md'. Must end in .md"),
        content: z.string().describe("Markdown content"),
      }),
      execute: async ({ filename, content }) => {
        const fname = filename.endsWith(".md") ? filename : `${filename}.md`;
        const validation = await validateMemoryWrite(projectWorkdir, "semantic", fname, content);
        if (!validation.ok) return validation.reason!;
        const existing = await readMemory(projectWorkdir, "semantic", fname);
        await writeMemory(projectWorkdir, "semantic", fname, content);
        return existing
          ? `Updated semantic memory: ${fname}`
          : `Created semantic memory: ${fname}`;
      },
    }),

    writeConvention: tool({
      description:
        "Save a project-wide RULE that constrains future work (style guide, naming " +
        "convention, hard invariant). Loaded into context on every Director run — cost " +
        "is high, bar is high. The single test: will this rule constrain how someone " +
        "writes new code three months from now? If no, don't save it. See the system " +
        "prompt for the full anti-pattern list. Topic-named filenames only.",
      parameters: z.object({
        filename: z.string().describe("Topic name, e.g. 'gdscript-naming.md'. Must end in .md"),
        content: z.string().describe("Markdown content describing the rule"),
      }),
      execute: async ({ filename, content }) => {
        const fname = filename.endsWith(".md") ? filename : `${filename}.md`;
        if (fname === PROJECT_BRIEF_FILENAME) {
          return `Use updateProjectBrief to maintain ${PROJECT_BRIEF_FILENAME}, not writeConvention.`;
        }
        const validation = await validateMemoryWrite(projectWorkdir, "conventions", fname, content);
        if (!validation.ok) return validation.reason!;
        try {
          const result = await writeConvention(projectWorkdir, fname, content);
          return result.created
            ? `Created convention: ${fname}`
            : `Updated convention: ${fname}`;
        } catch (err) {
          return `Failed to write convention: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    writeProcedure: tool({
      description:
        "Save a REPEATABLE step-by-step workflow that future agents will follow many " +
        "times (e.g. 'how to add a new game'). One-time fix instructions are NOT " +
        "procedures. The single test: will an agent run these exact steps again, for a " +
        "different task, in the future? If no, don't save it.",
      parameters: z.object({
        filename: z.string().describe("Filename (e.g. 'adding-a-new-game.md'). Must end in .md"),
        content: z.string().describe("Markdown content with step-by-step instructions"),
      }),
      execute: async ({ filename, content }) => {
        const fname = filename.endsWith(".md") ? filename : `${filename}.md`;
        const existing = await readMemory(projectWorkdir, "procedural", fname);
        await writeMemory(projectWorkdir, "procedural", fname, content);
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
          const entries = await readConventions(projectWorkdir);
          if (entries.length === 0) {
            return "No convention files. (PROJECT_BRIEF.md is managed separately via updateProjectBrief.)";
          }
          return entries
            .map(e => `- **${e.filename}** (updated: ${e.updatedAt.toISOString().slice(0, 10)})`)
            .join("\n");
        }
        const entries = await readMemoryCategory(projectWorkdir, category as MemoryCategory);
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
            const brief = await readProjectBrief(projectWorkdir);
            return brief ?? `${PROJECT_BRIEF_FILENAME} does not exist yet.`;
          }
          const content = await readConvention(projectWorkdir, fname);
          return content ?? `File not found: convention/${fname}`;
        }
        const content = await readMemory(projectWorkdir, category as MemoryCategory, filename);
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
        const content = category === "convention"
          ? await readConvention(projectWorkdir, fname)
          : await readMemory(projectWorkdir, category as MemoryCategory, fname);

        if (!content) {
          return `File not found: ${category}/${fname}`;
        }
        if (!content.includes(old_text)) {
          return `Text not found in ${category}/${fname}. Use readMemoryFile to see current content.`;
        }

        const updated = content.replace(old_text, new_text);
        if (category === "convention") {
          await writeConvention(projectWorkdir, fname, updated);
        } else {
          await writeMemory(projectWorkdir, category as MemoryCategory, fname, updated);
        }
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
        const { createSnapshot } = await import("./persistent-memory");
        await createSnapshot(projectWorkdir, `pre-delete-${fname.replace(".md", "")}`);

        if (category === "convention") {
          const deleted = await deleteConvention(projectWorkdir, fname);
          return deleted
            ? `Deleted convention/${fname} (snapshot created)`
            : `File not found: convention/${fname}`;
        }

        const { unlink: fsUnlink, stat: fsStat } = await import("fs/promises");
        const filePath = resolve(categoryDir(projectWorkdir, category as MemoryCategory), fname);
        try {
          await fsStat(filePath);
        } catch {
          return `File not found: ${category}/${fname}`;
        }
        await fsUnlink(filePath);
        return `Deleted ${category}/${fname} (snapshot created)`;
      },
    }),
  };
}

/**
 * Foreman agent memory tools — a curated SUBSET of `makeMemoryTools` that
 * lets task-executor agents contribute to the project's persistent memory.
 *
 * Without this, knowledge flowed one-way: Director writes, Foreman reads.
 * Foreman agents who discovered project quirks (build-system gotchas,
 * working API patterns, undocumented module behaviors) had no way to record
 * the discovery — the next task hit the same quirk and re-learned it from
 * scratch.
 *
 * The exposed tools are:
 *   - searchMemory (read)
 *   - readMemoryFile (read a specific file)
 *   - listMemories (browse what exists)
 *   - writeSemanticMemory (record findings, decisions, learnings)
 *   - writeConvention (document a discovered system spec or pattern)
 *
 * NOT exposed (Director-only):
 *   - updateProjectBrief — the always-injected identity is the Director's
 *     responsibility; Foreman agents can write narrower conventions instead
 *   - editMemory / deleteMemory — destructive ops stay with the Director
 *   - writeProcedure — procedures are workflows the Director documents
 */
export function makeForemanMemoryTools(projectWorkdir: string) {
  const all = makeMemoryTools(projectWorkdir);
  return {
    searchMemory: all.searchMemory,
    readMemoryFile: all.readMemoryFile,
    listMemories: all.listMemories,
    writeSemanticMemory: all.writeSemanticMemory,
    writeConvention: all.writeConvention,
  };
}
