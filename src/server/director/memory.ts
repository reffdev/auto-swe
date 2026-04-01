/**
 * Director memory system — progress tracking and context assembly.
 *
 * Manages the three-tier memory architecture:
 * - Working memory: assembled fresh for each LLM call (this module)
 * - Session memory: progress JSON in directive.progress (this module)
 * - Project memory: CLAUDE.md, design doc, git history (read from disk)
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { Db, DirectorDirective, Project } from "../db";
import { gatherProjectContext } from "../pipeline/nodes";
import { readConventions, readMemoryCategory } from "./persistent-memory";
import { searchMemories, isMemsearchAvailable } from "./memsearch";

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
  const claudeMd = tryReadFile(resolve(project.workdir, "CLAUDE.md"));
  if (claudeMd) {
    parts.push("# Project Rules (CLAUDE.md)\n\n" + claudeMd);
  }

  // 2. Generated design doc
  if (directive.design_doc_path) {
    const designDoc = tryReadFile(resolve(project.workdir, directive.design_doc_path));
    if (designDoc) {
      parts.push("# Design Document\n\n" + designDoc);
    }
  }

  // 3. Input design docs (referenced by directive)
  if (directive.design_docs) {
    const docPaths: string[] = JSON.parse(directive.design_docs);
    for (const docPath of docPaths) {
      const content = tryReadFile(resolve(project.workdir, docPath));
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

  // 6. Recent task summaries
  if (opts?.includeTaskSummaries !== false) {
    const tasks = db.getDirectiveTasks(directive.id);
    const recentCompleted = tasks
      .filter(t => t.status === "completed" || t.status === "failed")
      .sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""))
      .slice(0, maxRecentTasks);

    if (recentCompleted.length > 0) {
      const summaries = recentCompleted.map(t =>
        `- [${t.status.toUpperCase()}] ${t.title}${t.error_message ? ` (error: ${t.error_message.slice(0, 100)})` : ""}`
      );
      parts.push("# Recent Task Results\n\n" + summaries.join("\n"));
    }

    // Show in-progress tasks
    const inProgress = tasks.filter(t => t.status === "running" || t.status === "queued");
    if (inProgress.length > 0) {
      parts.push("# Tasks In Progress\n\n" + inProgress.map(t => `- [${t.status}] ${t.title}`).join("\n"));
    }
  }

  // 7. Persistent memory
  // Conventions always included (they're project rules)
  const conventions = readConventions(project.workdir);
  if (conventions.length > 0) {
    const convText = conventions
      .map(e => `### ${e.filename.replace(".md", "")}\n${e.content}`)
      .join("\n\n");
    parts.push("# Conventions\n\n" + convText);
  }

  // Procedural workflows always included (they're small and high-value)
  const procedural = readMemoryCategory(project.workdir, "procedural");
  if (procedural.length > 0) {
    const procText = procedural
      .map(e => `### ${e.filename.replace(".md", "")}\n${e.content}`)
      .join("\n\n");
    parts.push("# Workflows\n\n" + procText);
  }

  // Semantic + episodic: search for relevant memories instead of dumping everything
  const searchQuery = buildMemorySearchQuery(directive, activeMilestone);
  if (searchQuery) {
    const results = await searchMemories(project.workdir, searchQuery, 10);
    if (results.length > 0) {
      const memText = results
        .map((r, i) => `${i + 1}. ${r.source ? `[${r.source}] ` : ""}${r.content}`)
        .join("\n\n");
      parts.push("# Relevant Memories\n\n" + memText);
    }
  }

  // 8. Project filesystem state (directory listing, key files)
  try {
    const projectState = gatherProjectContext(project.workdir);
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
    parts.push(directive.directive.slice(0, 200));
  }

  // Current milestone narrows the focus
  if (activeMilestone) {
    parts.push(activeMilestone.title);
    if (activeMilestone.description) {
      parts.push(activeMilestone.description.slice(0, 200));
    }
  }

  return parts.length > 0 ? parts.join(" ") : null;
}

function tryReadFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
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
