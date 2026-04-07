/**
 * Director decomposer — converts an approved conversation into a design doc
 * and milestones. Called once when the user approves the directive plan.
 */

import { writeFile as fsWriteFile, mkdir as fsMkdir, stat as fsStat } from "fs/promises";
import { resolve, dirname } from "path";
import { runProcess } from "../util/async-process";
import type { Db, DirectorDirective, Project } from "../db";
import { parseDesignDoc, parseMilestones } from "./parsers";

async function pathExists(p: string): Promise<boolean> {
  try { await fsStat(p); return true; } catch { return false; }
}

/**
 * Process the approved conversation: extract design doc and milestones,
 * write design doc to project repo, create milestone records.
 */
export async function decomposeDirective(
  db: Db,
  directive: DirectorDirective,
  project: Project,
): Promise<{ designDocPath: string; milestoneCount: number }> {
  // Find the conversation and get the last assistant message with structured blocks
  if (!directive.conversation_id) {
    throw new Error("No conversation associated with this directive");
  }

  const messages = db.getDirectorMessages(directive.conversation_id);
  // Search backwards through assistant messages for one containing structured blocks
  const assistantMessages = [...messages].reverse().filter(m => m.role === "assistant");
  const planMessage = assistantMessages.find(m =>
    m.content.includes("```design_doc") && m.content.includes("```milestones")
  ) ?? assistantMessages[0]; // fallback to most recent

  if (!planMessage) {
    throw new Error("No assistant message found in conversation");
  }

  // Parse design doc from the conversation
  const designDocContent = parseDesignDoc(planMessage.content);
  if (!designDocContent) {
    throw new Error("No design document found in the approved conversation. The assistant should have produced a ```design_doc block.");
  }

  // Parse milestones
  const parsedMilestones = parseMilestones(planMessage.content);
  if (parsedMilestones.length === 0) {
    throw new Error("No milestones found in the approved conversation. The assistant should have produced a ```milestones block.");
  }

  // Write design doc to project repo
  const designDocPath = directive.design_doc_path || "docs/design.md";
  const fullPath = resolve(project.workdir, designDocPath);
  await fsMkdir(dirname(fullPath), { recursive: true });
  await fsWriteFile(fullPath, designDocContent, "utf-8");

  // Commit the design doc (non-fatal — file is written regardless)
  if (await pathExists(resolve(project.workdir, ".git"))) {
    const addResult = await runProcess("git", ["add", designDocPath], { cwd: project.workdir, timeoutMs: 10_000 });
    if (addResult.status === 0) {
      // Only commit if there are staged changes (avoids "nothing to commit" error)
      await runProcess("git", ["commit", "-m", `[Director] Add design document for: ${directive.directive.slice(0, 50)}`], { cwd: project.workdir, timeoutMs: 10_000 });
    }
  }

  // Create milestone records (dedup: skip if milestones already exist for this directive)
  const existingMilestones = db.getDirectorMilestones(directive.id);
  if (existingMilestones.length > 0) {
    console.warn(`[director:decomposer] directive ${directive.id} already has ${existingMilestones.length} milestone(s) — skipping creation to prevent duplicates`);
  } else {
    for (let i = 0; i < parsedMilestones.length; i++) {
      const m = parsedMilestones[i];
      db.createDirectorMilestone({
        directive_id: directive.id,
        sequence: i + 1,
        title: m.title,
        description: m.description,
        verification: m.verification,
      });
    }
  }

  // Activate the first milestone
  const milestones = db.getDirectorMilestones(directive.id);
  if (milestones.length > 0) {
    db.updateDirectorMilestone(milestones[0].id, {
      status: "active",
      started_at: new Date().toISOString(),
    });
  }

  // Update directive
  db.updateDirectorDirective(directive.id, {
    design_doc_path: designDocPath,
    status: "active",
    progress: JSON.stringify({
      milestones: parsedMilestones.map((m, i) => ({
        id: milestones[i]?.id,
        title: m.title,
        status: i === 0 ? "active" : "pending",
        tasks_generated: 0,
        tasks_completed: 0,
        tasks_failed: 0,
      })),
      key_decisions: [],
      total_tasks_completed: 0,
      total_tasks_failed: 0,
      human_reviews_completed: 0,
      last_activity: new Date().toISOString(),
    }),
  });

  return { designDocPath, milestoneCount: parsedMilestones.length };
}
