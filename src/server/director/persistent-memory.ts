/**
 * Director persistent memory — structured markdown storage that persists
 * across directives, sessions, and restarts.
 *
 * Layout:
 *   <projectWorkdir>/.swe/
 *   ├── memory/
 *   │   ├── episodic/    # Daily logs: what happened, when
 *   │   └── semantic/    # Knowledge base: stable facts, preferences
 *   └── conventions/
 *       ├── procedural/  # Workflows: how-to guides, repeatable processes
 *       └── snapshots/   # Backups before major changes
 *
 * The Director reads relevant memories before planning and writes new
 * memories after significant events (milestones, failures, decisions).
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, statSync, copyFileSync, unlinkSync } from "fs";
import { resolve } from "path";

// ─── Types ──────────────────────────────────────────────────────────────────

export type MemoryCategory = "episodic" | "semantic" | "procedural";
/**
 * "convention" is a virtual category — convention files live at the root of
 * .swe/conventions/ rather than under a category subdirectory. The hook system
 * uses this string so consumers can distinguish convention writes from other
 * memory writes (e.g. for indexing).
 */
export type WriteCategory = MemoryCategory | "convention" | "project_brief";

export interface MemoryEntry {
  category: MemoryCategory;
  filename: string;
  content: string;
  /** File modification time */
  updatedAt: Date;
}

// ─── Write hook (dependency inversion for indexing) ─────────────────────────

/**
 * Hook fired after any persistent-memory write completes. Used by memsearch
 * to schedule a re-index without persistent-memory needing to import memsearch
 * (which would create a circular dependency).
 *
 * Register at startup via setMemoryWriteHook(). Only one hook is supported.
 */
export type MemoryWriteHook = (
  projectWorkdir: string,
  category: WriteCategory,
  filename: string,
) => void;

let writeHook: MemoryWriteHook | null = null;

/** Register (or clear) the post-write hook. */
export function setMemoryWriteHook(hook: MemoryWriteHook | null): void {
  writeHook = hook;
}

/** Fire the registered hook, if any. Errors in the hook are swallowed. */
function fireWriteHook(workdir: string, category: WriteCategory, filename: string): void {
  if (!writeHook) return;
  try { writeHook(workdir, category, filename); } catch { /* hook errors are non-fatal */ }
}

// ─── Path Resolution ────────────────────────────────────────────────────────

const SWE_ROOT = ".swe";

/** Map each category to its directory */
export function categoryDir(projectWorkdir: string, category: MemoryCategory): string {
  switch (category) {
    case "episodic":
      return resolve(projectWorkdir, SWE_ROOT, "memory", "episodic");
    case "semantic":
      return resolve(projectWorkdir, SWE_ROOT, "memory", "semantic");
    case "procedural":
      return resolve(projectWorkdir, SWE_ROOT, "conventions", "procedural");
  }
}

const ALL_DIRS = [
  ["memory", "episodic"],
  ["memory", "semantic"],
  ["conventions", "procedural"],
  ["conventions", "snapshots"],
];

const ensuredDirs = new Set<string>();

/** Ensure the directory structure exists, seed ABOUT.md files, and prune old episodic logs. */
export function ensureMemoryDirs(projectWorkdir: string): void {
  if (ensuredDirs.has(projectWorkdir)) return;
  ensuredDirs.add(projectWorkdir);
  for (const [parent, child] of ALL_DIRS) {
    const dirPath = resolve(projectWorkdir, SWE_ROOT, parent, child);
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
    const aboutPath = resolve(dirPath, "ABOUT.md");
    if (!existsSync(aboutPath)) {
      const content = ABOUT_CONTENT[child as keyof typeof ABOUT_CONTENT];
      if (content) writeFileSync(aboutPath, content);
    }
  }
  // Seed conventions/ root with ABOUT.md so the convention category is documented
  const convAboutPath = resolve(projectWorkdir, SWE_ROOT, "conventions", "ABOUT.md");
  if (!existsSync(convAboutPath)) {
    writeFileSync(convAboutPath, ABOUT_CONTENT.conventions);
  }
  pruneEpisodicLogs(projectWorkdir);
  ensureGitignore(projectWorkdir);
}

/** Add .swe/ to the project's .gitignore if not already present. */
function ensureGitignore(projectWorkdir: string): void {
  if (!existsSync(resolve(projectWorkdir, ".git"))) return;
  const gitignorePath = resolve(projectWorkdir, ".gitignore");
  let content = "";
  if (existsSync(gitignorePath)) {
    content = readFileSync(gitignorePath, "utf-8");
    // Check if already ignored (exact line match)
    const lines = content.split("\n").map(l => l.trim());
    if (lines.includes(".swe/") || lines.includes(".swe") || lines.includes("/.swe/") || lines.includes("/.swe")) {
      return;
    }
  }
  // Append with a newline if file doesn't end with one
  const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  writeFileSync(gitignorePath, content + prefix + ".swe/\n");
}

const PRUNE_DAYS = 30;

/**
 * Remove episodic log files older than PRUNE_DAYS.
 * Before deleting, extracts patterns into semantic memory via LLM.
 * Creates a snapshot before deleting anything.
 */
function pruneEpisodicLogs(projectWorkdir: string): void {
  const episodicDir = categoryDir(projectWorkdir, "episodic");
  if (!existsSync(episodicDir)) return;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - PRUNE_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const files = readdirSync(episodicDir)
    .filter(f => f.endsWith(".md") && f !== "ABOUT.md")
    .filter(f => {
      const dateStr = f.replace(".md", "");
      return dateStr < cutoffStr;
    });

  if (files.length === 0) return;

  // Collect content from logs about to be pruned
  const logContents = files.map(f => {
    try { return readFileSync(resolve(episodicDir, f), "utf-8"); } catch { return ""; }
  }).filter(Boolean);

  // Snapshot before pruning
  try {
    createSnapshot(projectWorkdir, "pre-prune");
  } catch (err) {
    console.warn("[director:memory] failed to create pre-prune snapshot:", err);
  }

  // Extract patterns asynchronously, then delete
  if (logContents.length > 0) {
    extractAndPrune(projectWorkdir, episodicDir, files, logContents);
  } else {
    deleteFiles(episodicDir, files);
  }
}

function deleteFiles(dir: string, files: string[]): void {
  for (const file of files) {
    try { unlinkSync(resolve(dir, file)); } catch { /* best effort */ }
  }
  console.log(`[director:memory] pruned ${files.length} episodic log(s) older than ${PRUNE_DAYS} days`);
}

/**
 * Extract patterns from old episodic logs via LLM, save to semantic memory, then delete.
 * Runs in the background — doesn't block startup.
 */
function extractAndPrune(
  projectWorkdir: string,
  episodicDir: string,
  files: string[],
  logContents: string[],
): void {
  // Dynamic import to avoid circular dependency with planner-llm
  import("./episodic-extractor").then(({ extractPatternsFromLogs }) => {
    extractPatternsFromLogs(projectWorkdir, logContents)
      .then(() => deleteFiles(episodicDir, files))
      .catch(err => {
        console.warn("[director:memory] episodic pattern extraction failed — pruning anyway:", err);
        deleteFiles(episodicDir, files);
      });
  }).catch(() => {
    // Module not available — prune without extraction
    deleteFiles(episodicDir, files);
  });
}

const ABOUT_CONTENT = {
  episodic: `# Episodic Memory

Daily activity logs — what happened and when. Auto-generated by the Director.

Each file is one day (\`YYYY-MM-DD.md\`) with timestamped entries.

## What goes here
- Task completions and failures
- Milestone transitions
- Planning decisions
- Human review responses

## Example

\`\`\`markdown
# 2026-03-31

- **14:23:15** Task completed: "Implement CurrencyManager"
  Type: code, Confidence: 0.92
- **14:25:01** Planned 3 task(s) for "Core Systems"
  Types: code, code, art (top-up for idle: comfyui)
- **15:10:44** Task failed verification: "Create upgrade panel"
  Missing signal connection for currency_changed
- **16:00:00** Milestone completed: "Core Systems"
  Tasks: 5
\`\`\`

These files are auto-managed. You can read them but generally shouldn't edit them.

## Pruning

Episodic logs older than 30 days are automatically pruned on startup. Before pruning,
a snapshot is created so nothing is permanently lost.

If important patterns emerge from episodic logs (e.g., "art tasks fail when prompts
are too vague"), extract them into a semantic memory instead of keeping the raw logs.
`,

  semantic: `# Semantic Memory

Facts, learnings, status updates, and discoveries. Use this for anything you want to
remember but does NOT need to be in every task's context.

This is the right place for:
- Task completion notes and outcomes
- Debug findings and root causes
- Milestone status updates
- User preferences and feedback patterns
- Discovered patterns and behaviors
- Architectural decisions worth recalling
- Things you learned that didn't make it into the project brief or a convention

These files are NOT injected into agent prompts directly. They are surfaced via
semantic search when relevant to the current task or planning context. Write freely —
the search system will find what's relevant when it's needed.

## Example files

**\`tech-stack-history.md\`**
\`\`\`markdown
- Originally tried Bevy, switched to Godot for faster iteration
- Considered Aseprite for art but standardized on FLUX-generated pixel sprites
\`\`\`

**\`user-preferences.md\`**
\`\`\`markdown
- Prefers single bundled PRs over many small ones for refactors
- Wants terse responses, no trailing summaries
- Art review: prioritizes style consistency over individual quality
\`\`\`

**\`currency-manager-bug-2026-04.md\`**
\`\`\`markdown
- Big.gd serialization broke when prestige multiplier exceeded 1e308
- Root cause: float overflow before conversion to Big
- Fixed by deferring conversion until after threshold check
\`\`\`

**\`milestone-2-completion.md\`**
\`\`\`markdown
- Completed CurrencyManager + Data Resources milestone on 2026-04-06
- All tests passing, PR #25-27 merged
- Discovered: GUT 9.4 needs explicit -gtest path for test discovery
\`\`\`

## Pruning

Semantic memories are not auto-pruned. Remove or update entries manually when they
become misleading. Outdated facts that contradict current state should be deleted —
search results that surface stale information are worse than nothing.
`,

  procedural: `# Procedural Memory

Step-by-step workflows and how-to guides. These describe *how* to do something
repeatable, in enough detail that an agent could follow the steps without context.

These files are NOT injected into agent prompts. They are surfaced via semantic
search when relevant to the current task or planning context.

## What goes here
- Step-by-step procedures for common project operations
- Workflow templates the Director follows
- Build/deploy/test recipes
- Asset pipeline instructions

## Example files

**\`adding-a-new-game.md\`**
\`\`\`markdown
1. Create games/game_N_<name>/ directory
2. Copy project.godot template from games/template/
3. Create scenes/, scripts/, data/, assets/ subdirs
4. Register autoloads pointing to engine/ in project.godot
5. Create game brief in docs/game_N_<name>_brief.md
6. Create directive referencing the brief
\`\`\`

**\`pixel-art-generation.md\`**
\`\`\`markdown
1. Use preset: pixel_sprite for sprites, icon for UI
2. Always include "pixel art" and dimensions in prompt
3. Include "transparent background" for sprites
4. Review for: consistent palette, clean edges, no anti-aliasing
5. If rejected: specify exact colors or reference existing sprites
\`\`\`

A procedure should answer "how do I do X?". If the answer is "follow this rule" or
"these are the constraints", that's a convention, not a procedure.
`,

  conventions: `# Conventions

Detailed project knowledge, specifications, and guidelines. Each file is a focused
document covering ONE topic in depth.

These files are NOT all loaded at once. They are surfaced via semantic search when
relevant to a task or planning context. An agent working on the CurrencyManager will
see \`currency-manager-spec.md\` retrieved automatically; an agent working on art
generation will see \`art-guidelines.md\` retrieved automatically.

Conventions are for KNOWLEDGE. Status, progress, debug findings, and learnings go in
**semantic memory** instead.

## What goes here
- Specifications for systems, modules, features
- Style guides (code, art, naming, formatting)
- Format definitions (file structures, schemas, configs)
- Detailed reference material that agents need when working on a specific area

## What does NOT go here
- "Status updates" (semantic memory)
- "Task completed" notes (semantic memory or just let episodic logs handle it)
- "Debug findings" (semantic memory)
- "Milestone complete" notes (semantic memory)
- Anything that's about THE PAST rather than HOW THINGS SHOULD BE

## Naming
Name files specifically so search can find them. \`currency-manager-spec.md\` is much
better than \`spec.md\` or \`status-1.md\`. The filename is part of the search signal.

## Project Brief

There is a special file in this directory: **PROJECT_BRIEF.md**. It is the ONE
convention that is always injected into every agent context. Keep it small (under
~3000 chars). It captures the essential project identity: tech stack, key
architectural decisions, critical rules. Update it in-place — don't append.

Use \`updateProjectBrief\` to maintain it. Use \`writeConvention\` for everything else.
`,

  snapshots: `# Snapshots

Automatic backups of memory and conventions taken before major changes.

Each snapshot is a timestamped folder containing copies of all memory and convention
files at that point in time.

## When snapshots are created
- Before milestone transitions
- Before major directive changes
- On manual request

## Structure
\`\`\`
2026-03-31T14-23-15_milestone-core-systems/
├── memory/
│   ├── episodic/
│   └── semantic/
├── procedural/
└── conventions/
\`\`\`

These are read-only backups. To restore, copy files back to their original locations.

## Pruning

Snapshots older than 90 days can be safely deleted. They exist primarily as a safety
net during active development. Keep at least the most recent 3 snapshots.
`,
} as const;

// ─── Reading ────────────────────────────────────────────────────────────────

/**
 * Read all memory entries from a category.
 * Returns files sorted by modification time (newest first).
 */
export function readMemoryCategory(projectWorkdir: string, category: MemoryCategory): MemoryEntry[] {
  const dirPath = categoryDir(projectWorkdir, category);
  if (!existsSync(dirPath)) return [];

  try {
    const files = readdirSync(dirPath).filter(f => f.endsWith(".md"));
    return files
      .map(filename => {
        const filePath = resolve(dirPath, filename);
        try {
          const content = readFileSync(filePath, "utf-8");
          const stat = statSync(filePath);
          return { category, filename, content, updatedAt: stat.mtime };
        } catch {
          return null;
        }
      })
      .filter((e): e is MemoryEntry => e !== null)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  } catch {
    return [];
  }
}

/**
 * Read all memories across all categories.
 */
export function readAllMemories(projectWorkdir: string): MemoryEntry[] {
  const categories: MemoryCategory[] = ["episodic", "semantic", "procedural"];
  return categories.flatMap(cat => readMemoryCategory(projectWorkdir, cat));
}

/**
 * Read a specific memory file.
 */
export function readMemory(projectWorkdir: string, category: MemoryCategory, filename: string): string | null {
  const filePath = resolve(categoryDir(projectWorkdir, category), filename);
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Read all convention files (top-level markdown in conventions/).
 */
/** The single always-injected "project identity" file. Stored alongside conventions. */
export const PROJECT_BRIEF_FILENAME = "PROJECT_BRIEF.md";

export function readConventions(projectWorkdir: string): MemoryEntry[] {
  const dirPath = resolve(projectWorkdir, SWE_ROOT, "conventions");
  if (!existsSync(dirPath)) return [];

  try {
    // Exclude PROJECT_BRIEF.md (own dedicated read path) and ABOUT.md (category doc)
    const files = readdirSync(dirPath).filter(f =>
      f.endsWith(".md") && f !== PROJECT_BRIEF_FILENAME && f !== "ABOUT.md"
    );
    return files.map(filename => {
      const filePath = resolve(dirPath, filename);
      try {
        const content = readFileSync(filePath, "utf-8");
        const stat = statSync(filePath);
        return { category: "procedural" as MemoryCategory, filename, content, updatedAt: stat.mtime };
      } catch {
        return null;
      }
    }).filter((e): e is MemoryEntry => e !== null);
  } catch {
    return [];
  }
}

/**
 * Read the project brief — a single compact identity document always injected
 * into every agent context (Director and Foreman). Returns null if not yet created.
 */
export function readProjectBrief(projectWorkdir: string): string | null {
  const filePath = resolve(projectWorkdir, SWE_ROOT, "conventions", PROJECT_BRIEF_FILENAME);
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Write/replace the project brief. Always overwrites — the brief is meant to be
 * maintained in-place, not appended to.
 */
export function writeProjectBrief(projectWorkdir: string, content: string): void {
  ensureMemoryDirs(projectWorkdir);
  const filePath = resolve(projectWorkdir, SWE_ROOT, "conventions", PROJECT_BRIEF_FILENAME);
  writeFileSync(filePath, content);
  fireWriteHook(projectWorkdir, "project_brief", PROJECT_BRIEF_FILENAME);
}

/**
 * Read a single convention file by name. Returns null if it doesn't exist.
 */
export function readConvention(projectWorkdir: string, filename: string): string | null {
  const fname = filename.endsWith(".md") ? filename : `${filename}.md`;
  const filePath = resolve(projectWorkdir, SWE_ROOT, "conventions", fname);
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Write a convention file (top-level .md in .swe/conventions/). Creates the
 * file if it doesn't exist, overwrites if it does. Returns true if a new file
 * was created, false if an existing one was overwritten.
 *
 * The PROJECT_BRIEF.md and ABOUT.md filenames are reserved — use writeProjectBrief
 * for the brief; ABOUT.md is managed by the system.
 */
export function writeConvention(
  projectWorkdir: string,
  filename: string,
  content: string,
): { created: boolean } {
  const fname = filename.endsWith(".md") ? filename : `${filename}.md`;
  if (fname === PROJECT_BRIEF_FILENAME || fname === "ABOUT.md") {
    throw new Error(`${fname} is reserved — use the appropriate dedicated function`);
  }
  ensureMemoryDirs(projectWorkdir);
  const dirPath = resolve(projectWorkdir, SWE_ROOT, "conventions");
  const filePath = resolve(dirPath, fname);
  const created = !existsSync(filePath);
  writeFileSync(filePath, content);
  fireWriteHook(projectWorkdir, "convention", fname);
  return { created };
}

/**
 * Delete a convention file. Returns true if a file was actually deleted.
 */
export function deleteConvention(projectWorkdir: string, filename: string): boolean {
  const fname = filename.endsWith(".md") ? filename : `${filename}.md`;
  const filePath = resolve(projectWorkdir, SWE_ROOT, "conventions", fname);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  fireWriteHook(projectWorkdir, "convention", fname);
  return true;
}

// ─── Writing ────────────────────────────────────────────────────────────────

/**
 * Write a memory entry. Creates the file if it doesn't exist, overwrites if it does.
 */
export function writeMemory(
  projectWorkdir: string,
  category: MemoryCategory,
  filename: string,
  content: string,
): void {
  ensureMemoryDirs(projectWorkdir);
  const filePath = resolve(categoryDir(projectWorkdir, category), filename);
  writeFileSync(filePath, content);
  fireWriteHook(projectWorkdir, category, filename);
}

/**
 * Append to an existing memory file (e.g., daily episodic log).
 */
export function appendMemory(
  projectWorkdir: string,
  category: MemoryCategory,
  filename: string,
  content: string,
): void {
  ensureMemoryDirs(projectWorkdir);
  const filePath = resolve(categoryDir(projectWorkdir, category), filename);
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
  writeFileSync(filePath, existing + "\n" + content);
  fireWriteHook(projectWorkdir, category, filename);
}

// ─── Episodic: Daily Logs ───────────────────────────────────────────────────

/**
 * Log an event to today's episodic log.
 */
export function logEpisodic(
  projectWorkdir: string,
  event: string,
  details?: string,
): void {
  const today = new Date().toISOString().slice(0, 10);
  const filename = `${today}.md`;
  const timestamp = new Date().toISOString().slice(11, 19);

  let entry = `- **${timestamp}** ${event}`;
  if (details) entry += `\n  ${details}`;

  const filePath = resolve(categoryDir(projectWorkdir, "episodic"), filename);
  if (!existsSync(filePath)) {
    writeMemory(projectWorkdir, "episodic", filename, `# ${today}\n\n${entry}`);
  } else {
    appendMemory(projectWorkdir, "episodic", filename, entry);
  }
}

// ─── Snapshots ──────────────────────────────────────────────────────────────

/**
 * Create a snapshot of all current memories and conventions before a major change.
 */
export function createSnapshot(projectWorkdir: string, label: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const snapshotDir = resolve(projectWorkdir, SWE_ROOT, "conventions", "snapshots", `${timestamp}_${label}`);
  mkdirSync(snapshotDir, { recursive: true });

  // Snapshot memory/
  for (const cat of ["episodic", "semantic"] as const) {
    const srcDir = categoryDir(projectWorkdir, cat);
    if (!existsSync(srcDir)) continue;
    const destDir = resolve(snapshotDir, "memory", cat);
    mkdirSync(destDir, { recursive: true });
    for (const file of readdirSync(srcDir).filter(f => f.endsWith(".md"))) {
      copyFileSync(resolve(srcDir, file), resolve(destDir, file));
    }
  }

  // Snapshot conventions/procedural/
  const procDir = categoryDir(projectWorkdir, "procedural");
  if (existsSync(procDir)) {
    const destDir = resolve(snapshotDir, "procedural");
    mkdirSync(destDir, { recursive: true });
    for (const file of readdirSync(procDir).filter(f => f.endsWith(".md"))) {
      copyFileSync(resolve(procDir, file), resolve(destDir, file));
    }
  }

  // Snapshot top-level conventions/*.md
  const convDir = resolve(projectWorkdir, SWE_ROOT, "conventions");
  if (existsSync(convDir)) {
    const destConv = resolve(snapshotDir, "conventions");
    mkdirSync(destConv, { recursive: true });
    for (const file of readdirSync(convDir).filter(f => f.endsWith(".md"))) {
      copyFileSync(resolve(convDir, file), resolve(destConv, file));
    }
  }

  return snapshotDir;
}

// ─── Context Assembly for LLM ───────────────────────────────────────────────

/**
 * Build a memory context string for inclusion in LLM prompts.
 * Includes conventions, semantic knowledge, procedural guides, and recent episodic logs.
 * Caps total size to avoid blowing up the context.
 */
export function assembleMemoryContext(
  projectWorkdir: string,
  opts?: { maxEpisodicDays?: number; maxTotalChars?: number },
): string {
  const maxDays = opts?.maxEpisodicDays ?? 7;
  const maxChars = opts?.maxTotalChars ?? 15_000;

  const parts: string[] = [];
  let totalChars = 0;

  const addSection = (title: string, entries: MemoryEntry[], budget: number): void => {
    if (entries.length === 0 || totalChars >= budget) return;
    parts.push(`## ${title}\n`);
    for (const entry of entries) {
      const section = `### ${entry.filename.replace(".md", "")}\n${entry.content}\n`;
      if (totalChars + section.length > maxChars) break;
      parts.push(section);
      totalChars += section.length;
    }
  };

  // Conventions (top-level markdown — highest priority)
  addSection("Conventions", readConventions(projectWorkdir), maxChars);

  // Semantic memories (stable knowledge)
  addSection("Knowledge Base", readMemoryCategory(projectWorkdir, "semantic"), maxChars);

  // Procedural (workflows under conventions/procedural/)
  addSection("Workflows & Processes", readMemoryCategory(projectWorkdir, "procedural"), maxChars * 0.8);

  // Episodic (recent daily logs — most recent first)
  const episodic = readMemoryCategory(projectWorkdir, "episodic");
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxDays);
  const recentEpisodic = episodic.filter(e => e.updatedAt >= cutoff);
  addSection("Recent Activity", recentEpisodic, maxChars * 0.95);

  if (parts.length === 0) return "";
  return "# Director Memory\n\n" + parts.join("\n");
}
