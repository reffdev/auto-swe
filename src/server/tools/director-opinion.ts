/**
 * Director opinion tools — opinionated, named tools that exist to nudge
 * specific Director reasoning patterns via tool affordance.
 *
 * Each of these could in principle be reproduced by composing primitive
 * read tools, but the named version is what the Director will actually
 * call because it shows up in every step's tool list with a verb that
 * matches Director-shaped reasoning ("check the build", "is this
 * milestone ready to advance"). The doubling principle: prompt and tool
 * working together is more reliable than either alone.
 *
 * LLM-backed tools (compareCodeToClaim, summarizeRecentFailures,
 * verifyAcceptanceCriterion) take a `model` in opts. They make a single
 * inner LLM call and return structured text — they do NOT spawn nested
 * tool-using sub-loops, so latency is bounded.
 *
 * verifyMilestone wraps the existing `director/verifier.ts` machinery
 * end-to-end. The tool DOES make the same expensive call the scheduler
 * used to make at milestone boundaries — that's the whole point: we're
 * moving the caller from the scheduler into the Director's tool loop,
 * not duplicating the verification logic.
 */

import { z } from "zod";
import { tool } from "ai";
import { resolve } from "path";
import type { Db, Project, ForemanTask, DirectorMilestone } from "../db";
import { generate, type LlmModel } from "../llm";
import { runShellCommand, runProcess } from "../util/async-process";
import type { SandboxProfile } from "../util/sandbox";
import { verifyMilestone as runVerifyMilestone } from "../director/verifier";

interface DirectorOpinionOpts {
  /** LLM model used by the LLM-backed tools (compareCodeToClaim, summarizeRecentFailures, verifyAcceptanceCriterion). */
  model: LlmModel;
  /** Sandbox profile applied to subprocess work (runProjectCheck and the verifier's mechanical checks). */
  sandbox?: SandboxProfile;
  /** Optional directive id — when set, listMilestoneTasks etc. resolve milestones against this directive. */
  directiveId?: string;
}

export function makeDirectorOpinionTools(
  db: Db,
  project: Project,
  opts: DirectorOpinionOpts,
) {
  const { model, sandbox } = opts;
  const workdir = resolve(project.workdir);

  // ─── verifyMilestone ──────────────────────────────────────────────────────

  const verifyMilestone = tool({
    description:
      "Run the full milestone verification (mechanical checks + LLM review) for a milestone in the active directive. " +
      "Use this BEFORE declaring a milestone complete. Returns a structured pass/fail verdict with the specific issues found.\n\n" +
      "This is the SAME verifier the system used to run automatically at milestone boundaries — it now runs on demand from you, " +
      "so YOU decide when verification happens.",
    parameters: z.object({
      milestoneId: z.string().describe("The milestone id to verify"),
    }),
    execute: async ({ milestoneId }) => {
      const milestone = db.getDirectorMilestone(milestoneId);
      if (!milestone) return `Milestone not found: ${milestoneId}`;
      try {
        const result = await runVerifyMilestone(db, milestone, milestone.directive_id, project);
        return JSON.stringify({
          milestoneId,
          milestoneTitle: milestone.title,
          passed: result.passed,
          issues: result.issues,
        }, null, 2);
      } catch (err) {
        return `verifyMilestone threw: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  // ─── verifyAcceptanceCriterion (LLM micro-check) ──────────────────────────

  const verifyAcceptanceCriterion = tool({
    description:
      "Cheap LLM micro-verification of a single specific claim against the current code state. " +
      "Pass the criterion as plain text and (optionally) a list of files to inspect. Returns a pass/fail with brief evidence. " +
      "Cheaper than verifyMilestone — use when you need to spot-check ONE thing.",
    parameters: z.object({
      criterion: z.string().describe("The specific claim to check (e.g. 'CurrencyManager autoload is registered in project.godot')"),
      files: z.array(z.string()).optional().describe("Optional list of files to focus on"),
    }),
    execute: async ({ criterion, files }) => {
      let fileContent = "";
      if (files?.length) {
        const { readFile: fsReadFile } = await import("fs/promises");
        for (const f of files.slice(0, 8)) {
          try {
            const path = resolve(workdir, f);
            const content = await fsReadFile(path, "utf-8");
            fileContent += `\n\n## ${f}\n\`\`\`\n${content.slice(0, 8000)}\n\`\`\``;
          } catch { /* skip missing */ }
        }
      }
      const system = "You are verifying a single specific claim against project code. Output a JSON object with fields: pass (boolean), evidence (string explaining how you decided), doubts (array of concerns).";
      const user = `Claim: ${criterion}${fileContent ? "\n\n# Files:" + fileContent : "\n\n(no files provided — answer based on the claim itself)"}\n\nRespond with ONLY a JSON object.`;
      try {
        const text = await generate(model, { system, prompt: user });
        return text.slice(0, 4000);
      } catch (err) {
        return `verifyAcceptanceCriterion LLM call failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  // ─── checkMilestoneReadyToAdvance (composite — the big one) ───────────────

  const checkMilestoneReadyToAdvance = tool({
    description:
      "Composite check: returns whether a milestone is ready to advance. Checks (1) all tasks are completed, " +
      "(2) no tasks are in error states, (3) full milestone verification passes. Returns a structured " +
      "{ready, blockers[], suggestion} object.\n\n" +
      "**This is the tool you should call before deciding to advance to the next milestone.** " +
      "If `ready: false`, address the blockers — plan fix tasks, wait for in-flight work, or decide " +
      "the milestone needs a different approach.",
    parameters: z.object({
      milestoneId: z.string().describe("The milestone id to check"),
    }),
    execute: async ({ milestoneId }) => {
      const milestone = db.getDirectorMilestone(milestoneId);
      if (!milestone) return JSON.stringify({ ready: false, blockers: [`milestone not found: ${milestoneId}`], suggestion: "abort" });

      const tasks = db.getDirectiveTasks(milestone.directive_id, milestone.id);
      const blockers: string[] = [];

      if (tasks.length === 0) {
        return JSON.stringify({
          ready: false,
          blockers: ["no tasks have been planned for this milestone"],
          suggestion: "plan tasks for this milestone before checking readiness",
        });
      }

      const inFlight = tasks.filter(t => t.status === "queued" || t.status === "running" || t.status === "validating");
      if (inFlight.length > 0) {
        blockers.push(`${inFlight.length} task(s) still in flight: ${inFlight.map(t => `"${t.title}" [${t.status}]`).join(", ")}`);
      }
      const failed = tasks.filter(t => t.status === "failed");
      if (failed.length > 0) {
        blockers.push(`${failed.length} task(s) failed: ${failed.map(t => `"${t.title}"`).join(", ")}`);
      }
      const awaitingReview = tasks.filter(t => t.status === "awaiting_review");
      if (awaitingReview.length > 0) {
        blockers.push(`${awaitingReview.length} task(s) awaiting human review: ${awaitingReview.map(t => `"${t.title}"`).join(", ")}`);
      }

      if (blockers.length > 0) {
        return JSON.stringify({
          ready: false,
          blockers,
          suggestion: inFlight.length > 0 ? "wait for in-flight work to complete" : failed.length > 0 ? "plan fix tasks for the failed work" : "address the human review queue",
        }, null, 2);
      }

      // All tasks complete — run verification
      try {
        const result = await runVerifyMilestone(db, milestone, milestone.directive_id, project);
        if (!result.passed) {
          return JSON.stringify({
            ready: false,
            blockers: result.issues,
            suggestion: "plan corrective tasks to address the verification failures",
          }, null, 2);
        }
        return JSON.stringify({
          ready: true,
          blockers: [],
          suggestion: "advance to the next milestone",
        }, null, 2);
      } catch (err) {
        return JSON.stringify({
          ready: false,
          blockers: [`verification threw: ${err instanceof Error ? err.message : String(err)}`],
          suggestion: "verification failed unexpectedly — investigate before advancing",
        }, null, 2);
      }
    },
  });

  // ─── advanceMilestone ─────────────────────────────────────────────────────

  const advanceMilestone = tool({
    description:
      "Run full verification on a milestone and, if it passes, mark it completed and activate the next milestone in the directive. " +
      "This is the tool the Director calls to ACTUALLY ADVANCE — checkMilestoneReadyToAdvance only inspects, advanceMilestone commits.\n\n" +
      "On failure, returns the verification issues without changing state, so the Director can plan corrective tasks.\n\n" +
      "Use the typical flow: (1) listMilestoneTasks to check task statuses, (2) checkMilestoneReadyToAdvance to verify, (3) advanceMilestone to commit.",
    parameters: z.object({
      milestoneId: z.string().describe("The milestone id to advance"),
    }),
    execute: async ({ milestoneId }) => {
      const milestone = db.getDirectorMilestone(milestoneId);
      if (!milestone) return JSON.stringify({ advanced: false, error: `milestone not found: ${milestoneId}` });
      if (milestone.status === "completed") {
        return JSON.stringify({ advanced: false, error: "milestone is already completed" });
      }

      // Pre-check: all tasks must be complete
      const tasks = db.getDirectiveTasks(milestone.directive_id, milestone.id);
      const blockers: string[] = [];
      const inFlight = tasks.filter(t => t.status === "queued" || t.status === "running" || t.status === "validating");
      if (inFlight.length > 0) blockers.push(`${inFlight.length} task(s) still in flight`);
      const failed = tasks.filter(t => t.status === "failed");
      if (failed.length > 0) blockers.push(`${failed.length} task(s) failed`);
      if (tasks.length === 0) blockers.push("no tasks have been planned for this milestone");
      if (blockers.length > 0) {
        return JSON.stringify({ advanced: false, blockers, suggestion: "address blockers before advancing" });
      }

      // Run verification
      let verification: { passed: boolean; issues: string[] };
      try {
        verification = await runVerifyMilestone(db, milestone, milestone.directive_id, project);
      } catch (err) {
        return JSON.stringify({ advanced: false, error: `verification threw: ${err instanceof Error ? err.message : String(err)}` });
      }

      if (!verification.passed) {
        return JSON.stringify({
          advanced: false,
          verificationPassed: false,
          issues: verification.issues,
          suggestion: "plan corrective tasks for these issues; do NOT call advanceMilestone again until they are addressed",
        });
      }

      // Verification passed — commit the state transition
      db.updateDirectorMilestone(milestone.id, { status: "completed", completed_at: new Date().toISOString() });

      // Activate the next milestone if there is one
      const allMilestones = db.getDirectorMilestones(milestone.directive_id);
      const next = allMilestones.find((m: DirectorMilestone) => m.status === "pending");
      let nextMilestone: { id: string; title: string } | null = null;
      if (next) {
        db.updateDirectorMilestone(next.id, { status: "active", started_at: new Date().toISOString() });
        nextMilestone = { id: next.id, title: next.title };
      } else {
        // No next milestone — the directive is complete
        db.updateDirectorDirective(milestone.directive_id, { status: "completed", completed_at: new Date().toISOString() });
      }

      return JSON.stringify({
        advanced: true,
        completedMilestone: { id: milestone.id, title: milestone.title },
        nextMilestone,
        directiveCompleted: !next,
      }, null, 2);
    },
  });

  // ─── inspectTaskOutcome ───────────────────────────────────────────────────

  const inspectTaskOutcome = tool({
    description:
      "Get a structured forensic view of a task: status, error history, recent run failures, and a diff summary. " +
      "Use when a task failed in a way you didn't anticipate, or when you need to understand what an agent actually did before planning the next step.",
    parameters: z.object({
      taskId: z.string().describe("Task id (or 8-char prefix)"),
    }),
    execute: async ({ taskId }) => {
      const task = db.getForemanTask(taskId)
        ?? db.getForemanTasks(project.id).find(t => t.id.startsWith(taskId));
      if (!task) return `Task not found: ${taskId}`;
      const runs = db.getForemanRunsForTask(task.id);
      const recent = runs.slice(-3);
      const summary: Record<string, unknown> = {
        id: task.id,
        title: task.title,
        type: task.type,
        status: task.status,
        priority: task.priority,
        retries: task.retry_count,
        error_message: task.error_message ?? null,
        git_branch: task.git_branch ?? null,
        runs_total: runs.length,
        recent_runs: recent.map(r => ({
          status: r.status,
          duration_ms: r.duration_ms,
          error_message: r.error_message ?? null,
          completed_at: r.completed_at,
        })),
      };
      return JSON.stringify(summary, null, 2);
    },
  });

  // ─── inspectTaskDiff ──────────────────────────────────────────────────────

  const inspectTaskDiff = tool({
    description:
      "Show the git diff a specific task produced on its branch. Cheaper than inspectTaskOutcome when you only need the code changes.",
    parameters: z.object({
      taskId: z.string().describe("Task id (or 8-char prefix)"),
    }),
    execute: async ({ taskId }) => {
      const task = db.getForemanTask(taskId)
        ?? db.getForemanTasks(project.id).find(t => t.id.startsWith(taskId));
      if (!task) return `Task not found: ${taskId}`;
      if (!task.git_branch) return `Task "${task.title}" has no git branch`;
      try {
        const result = await runProcess("git", ["diff", "main", `${task.git_branch}`], { cwd: workdir, timeoutMs: 30_000, sandbox });
        if (result.status !== 0) return `git diff failed: ${(result.stderr ?? "").slice(0, 500)}`;
        const out = result.stdout ?? "";
        return out.length > 30_000 ? out.slice(0, 30_000) + "\n... (truncated)" : (out || "(no diff)");
      } catch (err) {
        return `git diff threw: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  // ─── summarizeRecentFailures (LLM-backed pattern extraction) ─────────────

  const summarizeRecentFailures = tool({
    description:
      "LLM-summarized patterns across recent failed runs. Surfaces repeated bugs, common error types, and drift between what's planned and what's happening. Optionally scoped to a milestone.",
    parameters: z.object({
      milestoneId: z.string().optional().describe("Optional milestone id to scope the summary"),
      limit: z.number().int().min(1).max(50).optional().describe("Max recent failures to include (default 15)"),
    }),
    execute: async ({ milestoneId, limit }) => {
      const n = limit ?? 15;
      const allTasks = milestoneId
        ? (() => {
            const m = db.getDirectorMilestone(milestoneId);
            return m ? db.getDirectiveTasks(m.directive_id, m.id) : [];
          })()
        : db.getForemanTasks(project.id);
      const failedTasks = allTasks.filter(t => t.status === "failed").slice(-n);
      if (failedTasks.length === 0) return "(no recent failed tasks in scope)";
      const lines = failedTasks.map(t => `- "${t.title}" (${t.type}): ${(t.error_message ?? "no error message").slice(0, 300)}`);
      const system = "You are analyzing recent failed agent task outcomes. Identify repeated patterns, common root causes, and any drift between intent and behavior. Be concise — 5-10 bullet points max.";
      const user = `Recent failed tasks:\n${lines.join("\n")}\n\nSummarize the patterns.`;
      try {
        const text = await generate(model, { system, prompt: user });
        return text.slice(0, 4000);
      } catch (err) {
        return `summarizeRecentFailures LLM call failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  // ─── whatChangedSince ─────────────────────────────────────────────────────

  const whatChangedSince = tool({
    description: "Show a summary of git commits and a high-level diff stat since a given ref or date. Useful when resuming a stale directive — answers 'what's different in the project since I last looked'.",
    parameters: z.object({
      ref: z.string().describe("Git ref or date (e.g. 'HEAD~10', 'main@{1.day.ago}', 'abc1234')"),
    }),
    execute: async ({ ref }) => {
      const log = await runProcess("git", ["log", `${ref}..HEAD`, "--pretty=format:%h %ad %an  %s", "--date=short"], { cwd: workdir, timeoutMs: 15_000, sandbox });
      const stat = await runProcess("git", ["diff", "--stat", `${ref}..HEAD`], { cwd: workdir, timeoutMs: 15_000, sandbox });
      const logOut = (log.stdout ?? "").trim() || "(no commits)";
      const statOut = (stat.stdout ?? "").trim() || "(no diff)";
      return `## Commits since ${ref}\n${logOut}\n\n## Diff stat\n${statOut}`;
    },
  });

  // ─── compareCodeToClaim (drift detector) ──────────────────────────────────

  const compareCodeToClaim = tool({
    description:
      "LLM-backed drift detector. Pass a claim from your memory (e.g. 'the CurrencyManager autoload is registered as Currency in project.godot') and a list of files to check. " +
      "Returns whether the code agrees with the claim, with evidence and any contradictions. Use this when you suspect your memory of the project state may be stale.",
    parameters: z.object({
      claim: z.string().describe("The claim to check"),
      files: z.array(z.string()).min(1).describe("Files to inspect for evidence"),
    }),
    execute: async ({ claim, files }) => {
      const { readFile: fsReadFile } = await import("fs/promises");
      let fileContent = "";
      for (const f of files.slice(0, 8)) {
        try {
          const path = resolve(workdir, f);
          const content = await fsReadFile(path, "utf-8");
          fileContent += `\n\n## ${f}\n\`\`\`\n${content.slice(0, 8000)}\n\`\`\``;
        } catch { /* skip */ }
      }
      const system = "You are a code drift detector. Determine whether the provided files actually support the claim. Output a JSON object: {agrees: boolean, evidence: string, contradictions: string[]}.";
      const user = `Claim: ${claim}${fileContent}\n\nRespond with ONLY a JSON object.`;
      try {
        const text = await generate(model, { system, prompt: user });
        return text.slice(0, 4000);
      } catch (err) {
        return `compareCodeToClaim LLM call failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  // ─── listMilestoneTasks ───────────────────────────────────────────────────

  const listMilestoneTasks = tool({
    description: "Structured snapshot of all tasks in a milestone with their statuses, error states, and timing. The Director should call this before reasoning about milestone completion instead of inferring task state from older context.",
    parameters: z.object({
      milestoneId: z.string().describe("The milestone id"),
    }),
    execute: async ({ milestoneId }) => {
      const milestone = db.getDirectorMilestone(milestoneId);
      if (!milestone) return `Milestone not found: ${milestoneId}`;
      const tasks = db.getDirectiveTasks(milestone.directive_id, milestone.id);
      const summary = {
        milestoneId,
        title: milestone.title,
        status: milestone.status,
        verification: milestone.verification ?? null,
        tasks: tasks.map((t: ForemanTask) => ({
          id: t.id.slice(0, 8),
          title: t.title,
          type: t.type,
          status: t.status,
          retries: t.retry_count,
          error: t.error_message ? t.error_message.slice(0, 200) : null,
        })),
      };
      return JSON.stringify(summary, null, 2);
    },
  });

  // ─── runProjectCheck (the named, opinionated runReadOnlyCommand) ──────────

  const runProjectCheck = tool({
    description:
      "Run a named project check. Same allowlist as runReadOnlyCommand but with verb-shaped naming for Director-style reasoning: " +
      "'check the build', 'check the tests', 'validate godot project'. Returns {exitCode, output, durationMs}.\n\n" +
      "Available checks: build, test, lint, typecheck, godot-validate, godot-gut-tests.",
    parameters: z.object({
      checkName: z.enum(["build", "test", "lint", "typecheck", "godot-validate", "godot-gut-tests"]),
    }),
    execute: async ({ checkName }) => {
      // Reuses the same allowlist resolution as runReadOnlyCommand. Kept here so this file
      // doesn't take a hard dependency on director-read.ts.
      let cmd: string | null = null;
      let processArgs: string[] | null = null;
      let processCmd: string | null = null;
      switch (checkName) {
        case "build":
          if (!project.build_command) return JSON.stringify({ exitCode: -1, output: "no build_command configured", durationMs: 0 });
          cmd = project.build_command; break;
        case "test":
          if (!project.test_command) return JSON.stringify({ exitCode: -1, output: "no test_command configured", durationMs: 0 });
          cmd = project.test_command; break;
        case "lint":
          if (!project.lint_command) return JSON.stringify({ exitCode: -1, output: "no lint_command configured", durationMs: 0 });
          cmd = project.lint_command; break;
        case "typecheck":
          cmd = "npx tsc --noEmit"; break;
        case "godot-validate":
          processCmd = "godot"; processArgs = ["--headless", "--quit", "--path", project.workdir]; break;
        case "godot-gut-tests":
          processCmd = "godot"; processArgs = ["--headless", "--script", "res://addons/gut/gut_cmdln.gd", "--path", project.workdir]; break;
      }
      const start = Date.now();
      const result = cmd
        ? await runShellCommand(cmd, { cwd: workdir, timeoutMs: 180_000, sandbox })
        : await runProcess(processCmd!, processArgs!, { cwd: workdir, timeoutMs: 180_000, sandbox });
      const durationMs = Date.now() - start;
      const stdout = (result.stdout ?? "").slice(-3000);
      const stderr = (result.stderr ?? "").slice(-3000);
      return JSON.stringify({
        check: checkName,
        exitCode: result.status,
        durationMs,
        stdout: stdout || "(empty)",
        stderr: stderr || "(empty)",
      }, null, 2);
    },
  });

  return {
    verifyMilestone,
    verifyAcceptanceCriterion,
    checkMilestoneReadyToAdvance,
    advanceMilestone,
    inspectTaskOutcome,
    inspectTaskDiff,
    summarizeRecentFailures,
    whatChangedSince,
    compareCodeToClaim,
    listMilestoneTasks,
    runProjectCheck,
  };
}
