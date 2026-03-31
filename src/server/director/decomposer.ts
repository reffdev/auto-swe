/**
 * Director decomposer — converts an approved conversation into a design doc
 * and milestones. Called once when the user approves the directive plan.
 */

import { writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { spawnSync } from "child_process";
import type { Db, DirectorDirective, Project } from "../db";
import { parseDesignDoc, parseMilestones } from "./parsers";

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
  const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");

  if (!lastAssistant) {
    throw new Error("No assistant message found in conversation");
  }

  // Parse design doc from the conversation
  const designDocContent = parseDesignDoc(lastAssistant.content);
  if (!designDocContent) {
    throw new Error("No design document found in the approved conversation. The assistant should have produced a ```design_doc block.");
  }

  // Parse milestones
  const parsedMilestones = parseMilestones(lastAssistant.content);
  if (parsedMilestones.length === 0) {
    throw new Error("No milestones found in the approved conversation. The assistant should have produced a ```milestones block.");
  }

  // Write design doc to project repo
  const designDocPath = directive.design_doc_path || "docs/design.md";
  const fullPath = resolve(project.workdir, designDocPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, designDocContent, "utf-8");

  // Commit the design doc
  try {
    spawnSync("git", ["add", designDocPath], { cwd: project.workdir });
    spawnSync("git", ["commit", "-m", `[Director] Add design document for: ${directive.directive.slice(0, 50)}`], { cwd: project.workdir });
  } catch {
    // Non-fatal — file is written even if git commit fails
  }

  // Create milestone records
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
