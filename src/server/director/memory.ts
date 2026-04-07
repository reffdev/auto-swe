/**
 * Director memory system — progress tracking and context assembly.
 *
 * Manages the three-tier memory architecture:
 * - Working memory: assembled fresh for each LLM call (this module)
 * - Session memory: progress JSON in directive.progress (this module)
 * - Project memory: CLAUDE.md, design doc, git history (read from disk)
 */

import { readFile as fsReadFile } from "fs/promises";
import { resolve } from "path";
import type { Db, DirectorDirective, Project } from "../db";
import { gatherProjectContext } from "../pipeline/nodes";
import { searchMemories, isMemsearchAvailable } from "./memsearch";
import { getMemoryContext, formatMemoryContext } from "./memory-context";
import { getStyleLock } from "./style-lock";

// ─── Progress JSON ──────────────────────────────────────────────────────────

export interface MilestoneProgress {
  id: string;
  title: string;
  status: string;
  tasks_generated: number;
  tasks_completed: number;
  tasks_failed: number;
  verified_at?: string;
}

export interface DirectiveProgress {
  milestones: MilestoneProgress[];
  key_decisions: string[];
  total_tasks_completed: number;
  total_tasks_failed: number;
  human_reviews_completed: number;
  last_activity: string;
}

/** Build or update the progress JSON for a directive */
export function buildProgress(db: Db, directive: DirectorDirective): DirectiveProgress {
  const milestones = db.getDirectorMilestones(directive.id);
  const allTasks = db.getDirectiveTasks(directive.id);
  const reviews = db.getDirectorReviews(directive.id);

  const milestoneProgress: MilestoneProgress[] = milestones.map(m => {
    const mTasks = allTasks.filter(t => t.milestone_id === m.id);
    return {
      id: m.id,
      title: m.title,
      status: m.status,
      tasks_generated: mTasks.length,
      tasks_completed: mTasks.filter(t => t.status === "completed").length,
      tasks_failed: mTasks.filter(t => t.status === "failed").length,
      verified_at: m.completed_at ?? undefined,
    };
  });

  // Parse existing decisions from progress
  let existingDecisions: string[] = [];
  if (directive.progress) {
    try {
      const prev: DirectiveProgress = JSON.parse(directive.progress);
      existingDecisions = prev.key_decisions ?? [];
    } catch { /* ignore */ }
  }

  return {
    milestones: milestoneProgress,
    key_decisions: existingDecisions,
    total_tasks_completed: allTasks.filter(t => t.status === "completed").length,
    total_tasks_failed: allTasks.filter(t => t.status === "failed").length,
    human_reviews_completed: reviews.filter(r => r.status === "responded").length,
    last_activity: new Date().toISOString(),
  };
}

/** Save progress JSON to the directive */
export function saveProgress(db: Db, directive: DirectorDirective): void {
  const progress = buildProgress(db, directive);
  db.updateDirectorDirective(directive.id, { progress: JSON.stringify(progress) });
}

/** Add a key decision to the progress */
export function addKeyDecision(db: Db, directive: DirectorDirective, decision: string): void {
  const progress = buildProgress(db, directive);
  progress.key_decisions.push(decision);
  db.updateDirectorDirective(directive.id, { progress: JSON.stringify(progress) });
}

// ─── Context Assembly ───────────────────────────────────────────────────────

/**
 * Assemble the full context for a Director LLM call.
 * This is the "context assembly pipeline" from the plan.
 */
export async function assembleDirectorContext(
  db: Db,
  directive: DirectorDirective,
  project: Project,
  opts?: { includeTaskSummaries?: boolean; maxRecentTasks?: number },
): Promise<string> {
  const parts: string[] = [];
  const maxRecentTasks = opts?.maxRecentTasks ?? 10;

  // 1. Project CLAUDE.md
  const claudeMd = await tryReadFile(resolve(project.workdir, "CLAUDE.md"));
  if (claudeMd) {
    parts.push("# Project Rules (CLAUDE.md)\n\n" + claudeMd);
  }

  // 2. Generated design doc
  if (directive.design_doc_path) {
    const designDoc = await tryReadFile(resolve(project.workdir, directive.design_doc_path));
    if (designDoc) {
      parts.push("# Design Document\n\n" + designDoc);
    }
  }

  // 3. Input design docs (referenced by directive)
  if (directive.design_docs) {
    const docPaths: string[] = JSON.parse(directive.design_docs);
    for (const docPath of docPaths) {
      const content = await tryReadFile(resolve(project.workdir, docPath));
      if (content) {
        parts.push(`# Reference: ${docPath}\n\n` + content);
      }
    }
  }

  // 4. Progress summary
  if (directive.progress) {
    try {
      const progress: DirectiveProgress = JSON.parse(directive.progress);
      parts.push(formatProgressSummary(progress));
    } catch { /* ignore */ }
  }

  // 5. Current milestone
  const activeMilestone = db.getActiveMilestone(directive.id);
  if (activeMilestone) {
    parts.push(`# Current Milestone\n\nTitle: ${activeMilestone.title}\nDescription: ${activeMilestone.description}\nVerification: ${activeMilestone.verification ?? "Not specified"}`);
  }

  // 6. Task summaries for the planner
  //
  // Two lists, both curated to prevent the planner from generating duplicates:
  //
  //   a) "Recent Task Results" — the most recent N completed/failed tasks
  //      with error messages for failures, so the planner understands what
  //      went wrong and can plan corrective work. Capped at maxRecentTasks.
  //
  //   b) "All Task Titles (do NOT re-plan these)" — the FULL list of every
  //      task title in this directive regardless of status, so the planner
  //      cannot produce a duplicate just because the task is older than the
  //      recent-results window. Deduped by lowercased title.
  //
  // The old code only capped (a) at 10 and only showed NON-completed tasks in
  // (b) — so completed tasks older than the 10 most recent dropped off the
  // context entirely, and the LLM planner would regenerate them as if new.
  if (opts?.includeTaskSummaries !== false) {
    const tasks = db.getDirectiveTasks(directive.id);
    const recentCompleted = tasks
      .filter(t => t.status === "completed" || t.status === "failed")
      .sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""))
      .slice(0, maxRecentTasks);

    if (recentCompleted.length > 0) {
      const summaries = recentCompleted.map(t =>
        `- [${t.status.toUpperCase()}] ${t.title}${t.error_message ? ` (error: ${t.error_message})` : ""}`
      );
      parts.push("# Recent Task Results\n\n" + summaries.join("\n"));
    }

    // Full title manifest — every task for this directive, deduped by title.
    // Prevents the planner from regenerating completed work that dropped off
    // the "Recent Task Results" window.
    if (tasks.length > 0) {
      const seen = new Set<string>();
      const manifest: string[] = [];
      for (const t of tasks) {
        const key = t.title.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        manifest.push(`- [${t.status}] ${t.title} (${t.type})`);
      }
      parts.push(
        "# All Task Titles In This Directive (do NOT re-plan any of these)\n\n" +
        "Every task below — including completed and accepted ones — already exists. " +
        "Do not generate a task with the same title or the same concept as any of these. " +
        "If you believe one of these needs to be redone, stop and escalate instead.\n\n" +
        manifest.join("\n")
      );
    }
  }

  // 7. Art style status
  const styleLock = await getStyleLock(project.workdir);
  if (styleLock) {
    parts.push(`# Art Style (LOCKED)\n\nPreset: ${styleLock.preset}\nCheckpoint: ${styleLock.checkpoint}\nStyle prefix: "${styleLock.prompt_style_prefix}"\nIP-Adapter: ${styleLock.ip_adapter_model} @ ${styleLock.ip_adapter_weight}\nLocked: ${styleLock.locked_at}`);
  } else {
    parts.push("# Art Style\n\n**Not established.** No style reference locked for this project. A style_exploration task should be created before generating production art assets.");
  }

  // 8. Persistent memory — project brief always, conventions retrieved by relevance
  const searchQuery = buildMemorySearchQuery(directive, activeMilestone);
  const memoryCtx = await getMemoryContext(project.workdir, {
    query: searchQuery ?? undefined,
    budget: 30_000, // Director planning has a larger budget than per-task execution
    topK: 10,
  });
  const memoryText = formatMemoryContext(memoryCtx);
  if (memoryText) {
    parts.push(memoryText);
  }

  // Semantic + episodic memories (separate from conventions): search for relevant ones
  // Note: convention results are filtered out by getMemoryContext above; this surfaces
  // semantic/procedural/episodic results from the same query.
  if (searchQuery && isMemsearchAvailable()) {
    const results = await searchMemories(project.workdir, searchQuery, 10);
    const nonConvResults = results.filter(r =>
      !r.source || !r.source.includes("/conventions/")
    );
    if (nonConvResults.length > 0) {
      const memText = nonConvResults
        .map((r, i) => `${i + 1}. ${r.source ? `[${r.source}] ` : ""}${r.content}`)
        .join("\n\n");
      parts.push("# Relevant Memories\n\n" + memText);
    }
  }

  // 8. Project filesystem state (directory listing, key files)
  try {
    const projectState = await gatherProjectContext(project.workdir);
    if (projectState.context) {
      parts.push("# Project Filesystem State\n\n" + projectState.context);
    }
  } catch { /* non-fatal — project dir may not exist yet */ }

  // 8. Pending review gates
  const pendingReviews = db.getPendingReviewsForDirective(directive.id);
  if (pendingReviews.length > 0) {
    parts.push("# Pending Human Reviews\n\n" + pendingReviews.map(r =>
      `- [${r.review_type}] ${r.question}`
    ).join("\n"));
  }

  return parts.join("\n\n---\n\n");
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a search query from the current directive and milestone context.
 * This is what memsearch uses to find relevant memories.
 */
function buildMemorySearchQuery(
  directive: DirectorDirective,
  activeMilestone: { title: string; description?: string | null } | null,
): string | null {
  if (!isMemsearchAvailable()) return null;

  const parts: string[] = [];

  // Directive description gives the overall project goal
  if (directive.directive) {
    parts.push(directive.directive);
  }

  // Current milestone narrows the focus
  if (activeMilestone) {
    parts.push(activeMilestone.title);
    if (activeMilestone.description) {
      parts.push(activeMilestone.description);
    }
  }

  return parts.length > 0 ? parts.join(" ") : null;
}

async function tryReadFile(path: string): Promise<string | null> {
  try {
    return await fsReadFile(path, "utf-8");
  } catch {
    return null;
  }
}

function formatProgressSummary(progress: DirectiveProgress): string {
  const lines: string[] = ["# Progress Summary\n"];

  for (const m of progress.milestones) {
    const pct = m.tasks_generated > 0 ? Math.round((m.tasks_completed / m.tasks_generated) * 100) : 0;
    lines.push(`- **${m.title}**: ${m.status} (${m.tasks_completed}/${m.tasks_generated} tasks, ${pct}%)${m.tasks_failed > 0 ? ` [${m.tasks_failed} failed]` : ""}`);
  }

  lines.push(`\nTotal completed: ${progress.total_tasks_completed}, Failed: ${progress.total_tasks_failed}, Reviews: ${progress.human_reviews_completed}`);

  if (progress.key_decisions.length > 0) {
    lines.push("\n## Key Decisions\n");
    for (const d of progress.key_decisions) {
      lines.push(`- ${d}`);
    }
  }

  return lines.join("\n");
}
