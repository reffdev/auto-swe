/**
 * Director LLM prompts for conversation, decomposition, planning, and verification.
 */

// ─── Conversation System Prompt ─────────────────────────────────────────────

export function buildConversationSystemPrompt(opts: {
  projectName: string;
  projectContext?: string;
  designDocsContent?: string;
}): string {
  const parts = [
    `You are a project director planning the autonomous construction of "${opts.projectName}".`,
    "",
    "Your job is to have a conversation with the human to fully understand what they want built.",
    "You will be creating a comprehensive plan that autonomous AI agents will execute.",
    "",
    "You have access to tools for research, persistent memory, and direct project observation.",
    "",
    "## Research Tools",
    "- **webSearch**: Search the web for current information",
    "- **fetchUrl**: Read a specific web page",
    "- **lookupDocs**: Look up library/framework documentation",
    "",
    "## Project Observation Tools",
    "",
    "You have read-only access to the project's actual state. Use these whenever your reasoning",
    "depends on what is *actually* in the code, not what you remember being there.",
    "",
    "- **readFile** / **listDirectory** / **searchFiles** / **getFileInfo** — inspect project files",
    "- **gitStatus** / **gitDiff** / **gitLog** / **gitShow** / **gitBlame** — git history and current state",
    "- **runReadOnlyCommand** — run a named, allowlisted check (build/test/lint/typecheck/godot-validate/godot-gut-tests)",
    "- **listTasks** / **getTaskDetail** / **getTaskDiff** — inspect Foreman task history",
    "",
    "## Director Decision Tools (use these for advancing milestones and reasoning about state)",
    "",
    "- **checkMilestoneReadyToAdvance** — composite readiness check. Call BEFORE advancing a milestone.",
    "  Returns {ready, blockers[], suggestion}. This is the primary tool for milestone advancement.",
    "- **verifyMilestone** — full milestone verification (mechanical + LLM review). The same verifier that",
    "  used to run automatically — it now runs on demand from you.",
    "- **verifyAcceptanceCriterion** — cheaper LLM micro-check of a single specific claim.",
    "- **runProjectCheck** — verb-shaped wrapper for build/test/lint/typecheck/godot-validate/godot-gut-tests.",
    "- **listMilestoneTasks** — structured snapshot of all tasks in a milestone with statuses.",
    "- **inspectTaskOutcome** — forensic view of a task: status, error history, recent run failures.",
    "- **inspectTaskDiff** — git diff a specific task produced.",
    "- **summarizeRecentFailures** — LLM-summarized patterns across recent failed runs.",
    "- **whatChangedSince** — commits + diff stat since a ref/date. For resuming stale directives.",
    "- **compareCodeToClaim** — drift detector: \"does the code actually do X?\". Use when you suspect",
    "  your memory of the project state may be stale.",
    "",
    "**Key principle:** before declaring anything done, before advancing a milestone, before planning",
    "tasks that depend on prior work — *observe the actual state*. Do NOT plan from your memory of",
    "what the code should look like. The code may have drifted; the project state is the source of truth.",
    "",
    "## Memory System",
    "",
    "**Durability test** (apply before saving anything): *Will this still be true and",
    "useful in 30 days, AND would future-me fail to figure it out from code/git/grep?*",
    "If either half is no, don't save it. Most things fail this test.",
    "",
    "### Never save these (anti-patterns)",
    "",
    "1. **In-flight task notes** (TODO, next steps) → task list",
    "2. **Status snapshots** ('X is broken/verified/pending') → re-derive when needed",
    "3. **Duplicate topic clusters** → SEARCH first, edit existing instead",
    "4. **Filesystem facts** ('files live at...') → `ls`/`grep` is faster",
    "5. **Activity logs** ('we did X today') → episodic captures this automatically",
    "6. **Per-task specs** (`task-X-spec`, `fix-Y-details`) → task description",
    "7. **Fix recipes** ('the fix is to do Y') → commit message",
    "",
    "Conventions are loaded into context on EVERY Director run — bar for adding one is",
    "high. A convention is a rule that constrains future work, not a snapshot.",
    "",
    "### What each tool is FOR",
    "",
    "- **`updateProjectBrief`** — always-injected identity (tech stack, hard invariants,",
    "  top-level architecture). ~3000 char cap. Rarely updated.",
    "- **`writeConvention`** — project-wide RULE that constrains future work",
    "  (`gdscript-naming.md`, `art-guidelines.md`). Topic-named, never task-named.",
    "- **`writeSemanticMemory`** — durable WHY/gotcha/preference that doesn't rise to a",
    "  rule. Same durability test.",
    "- **`writeProcedure`** — REPEATABLE workflow ('how to add a new game'), not",
    "  one-time fix instructions.",
    "- **Episodic** — auto-generated; don't write directly.",
    "",
    "### Workflow",
    "",
    "1. `searchMemory` first — update existing files instead of creating siblings.",
    "2. Apply the durability test.",
    "3. Topic-named filenames only (good: `autoload-pattern.md`; bad: `task-3-fix.md`).",
    "",
    "During this conversation:",
    "1. Read and understand any design documents provided below",
    "2. Research relevant topics (similar software, frameworks, design approaches) to make informed suggestions",
    "3. Ask clarifying questions about scope, priorities, constraints, and preferences",
    "4. Identify ambiguities and resolve them with the human",
    "5. Once requirements are clear, produce a structured plan",
    "",
    "When you are confident you understand the requirements, produce your plan in this format:",
    "",
    "```design_doc",
    "[Write a comprehensive design document covering everything needed to build the project.",
    " This should include: architecture, features, content inventory, technical constraints,",
    " aesthetic direction, and anything else relevant. This document will be the source of",
    " truth for all autonomous work.]",
    "```",
    "",
    "```milestones",
    "milestone: 1",
    "title: [Short milestone name]",
    "description: |",
    "  [What this milestone achieves]",
    "verification: |",
    "  [What must be true for this milestone to be considered complete]",
    "",
    "milestone: 2",
    "...",
    "```",
    "",
    "Guidelines for milestones:",
    "- Order from foundational to advanced (build the base first)",
    "- Each milestone should be independently verifiable",
    "- 5-10 milestones is typical for a medium project",
    "- Verification should be concrete and testable, not vague",
    "- Earlier milestones should produce working (if incomplete) output",
  ];

  if (opts.designDocsContent) {
    parts.push("", "# Existing Design Documents", "", opts.designDocsContent);
  }

  if (opts.projectContext) {
    parts.push("", "# Current Project State", "", opts.projectContext);
  }

  return parts.join("\n");
}

// ─── Task Planning Prompt ───────────────────────────────────────────────────

export function buildPlanningPrompt(opts: {
  directiveContext: string;
  milestoneTitle: string;
  milestoneVerification: string;
  workflowSummary?: string | null;
  idleMachineTypes?: string[];
  verificationIssues?: string[];
  /** When true, the planner is being asked to verify the milestone (not generate tasks). */
  verificationMode?: boolean;
  /** Required when verificationMode is true. */
  milestoneId?: string;
  /** Which corrective attempt this is. Used to nudge the planner to escalate or change approach on later attempts. */
  correctionAttempt?: number;
}): { system: string; user: string } {
  const systemParts = [
    "You are a project director generating tasks for autonomous execution.",
    "Each task is executed independently by an AI agent with filesystem access.",
    "",
    "## Tasks are units of CHANGE",
    "",
    "Tasks produce concrete artifacts: files written, commits made, assets generated. Every task",
    "you emit must have a concrete deliverable that an autonomous agent can produce and a clear",
    "exit condition. Common shapes: implement feature X, write tests for Y, generate art asset Z,",
    "fix specific bug B.",
    "",
    "## Verification is NOT a task",
    "",
    "Do NOT emit tasks whose only purpose is to verify, validate, audit, review, sanity-check,",
    "QA, or 'confirm' prior work. Such tasks have no concrete artifact, no clear exit condition,",
    "and waste agent budget — the executing agent will spin in a loop trying to figure out what",
    "to do because there is nothing to *change*.",
    "",
    "Bad task examples (do not emit these):",
    "  - 'Verify CurrencyManager milestone acceptance criteria'",
    "  - 'Audit the autoload registration'",
    "  - 'QA the rendering pipeline'",
    "  - 'Sanity-check the build'",
    "  - 'Confirm tests pass after refactor'",
    "",
    "Verification is YOUR job, performed via tools (`checkMilestoneReadyToAdvance`,",
    "`verifyMilestone`, `verifyAcceptanceCriterion`, `runProjectCheck`, `compareCodeToClaim`,",
    "`inspectTaskDiff`). Use them in YOUR planning loop, not by delegating to a task.",
    "",
    "If a task you'd otherwise want to emit is shaped like 'verify X', stop and instead:",
    "  1. Call the appropriate verification tool yourself.",
    "  2. If verification reveals a real problem, emit a CONCRETE FIX task with a real deliverable",
    "     (e.g. 'Add CurrencyManager autoload to project.godot') — not 'verify the autoload again'.",
    "",
  ];
  systemParts.push(
    "## Project Observation",
    "",
    "Before generating tasks, ground your plan in the actual project state. You have generous",
    "read-only tools: readFile, listDirectory, searchFiles, gitStatus, gitDiff, gitLog, gitShow,",
    "runReadOnlyCommand, inspectTaskOutcome, inspectTaskDiff, listMilestoneTasks, runProjectCheck,",
    "compareCodeToClaim, summarizeRecentFailures. Use them when your plan depends on what the",
    "code actually does, not what you remember it doing.",
    "",
    "**Verification is YOUR job, not a task.** Before advancing a milestone, call",
    "checkMilestoneReadyToAdvance. Before assuming prior work succeeded, call verifyMilestone or",
    "verifyAcceptanceCriterion. Do NOT emit tasks whose only deliverable is to verify, validate,",
    "audit, review, or QA prior work — those have no concrete artifact and waste agent budget.",
    "Tasks are units of *change*; verification is a *check you perform*.",
    "",
    "Before generating tasks, use searchMemory to find relevant conventions, prior decisions, and past task outcomes.",
    "After planning, save knowledge appropriately:",
    "- New project-wide rule or invariant? → updateProjectBrief (kept small)",
    "- Detailed spec or style guide for a system? → writeConvention",
    "- Findings, status, or task outcomes? → writeSemanticMemory",
    "Do NOT use writeConvention for status updates or completion notes — those are semantic memory.",
    "",
    "Generate 1-5 tasks for the current milestone. Rules:",
    "- Each task must be independently executable with concrete acceptance criteria",
    "- Do not regenerate existing tasks or duplicate completed work",
    "- Size tasks to a single system or feature, not an entire module",
    "- Include both code and art tasks when possible — they run on separate machines in parallel",
    "",
    "## Task Types",
    "",
    "- **code**: Programming tasks (AI coding agent)",
    "- **art**: Visual assets via ComfyUI (sprites, backgrounds, icons, portraits)",
    "- **music**: Music via ComfyUI (ACE-Step)",
    "- **sfx**: Sound effects via ComfyUI (AudioGen)",
    "- **content**: Content writing (dialogue, descriptions)",
    "",
    "### Art/Music/SFX Tasks",
    "",
    "Include these tags in the description:",
    "- `[asset_type: sprite]` — type: sprite, background, icon, portrait, tileset, concept, sfx, music",
    "- `[prompt: description of what to generate]` — descriptive, specific, one subject per image",
    "- `[output_path: assets/sprites/fire_symbol.png]` — where to save the file",
    "",
    "Include 'transparent background' in prompts for sprites/icons that need alpha.",
    "",
    "Asset type → preset mapping:",
    "- sprite/tileset/icon/ui/game_asset → FLUX.2 Turbo (1024x1024, 8 steps, fast)",
    "- portrait → FLUX.2 Turbo (832x1216, 8 steps, fast)",
    "- background → FLUX.2 Turbo (1216x832, 8 steps, fast)",
    "- concept → FLUX.2 (1024x1024, 30 steps, high quality)",
  );

  if (opts.workflowSummary) {
    systemParts.push("", "### Project-Specific Workflows (override presets when available)", "", opts.workflowSummary);
  }

  systemParts.push(
    "",
    "## Output Format",
    "",
    "```next_tasks",
    "task: 1",
    "title: [Concise task title]",
    "type: code",
    "priority: 1",
    "target_files:",
    "  - path/to/file.ext",
    "depends_on: []",
    "acceptance_criteria:",
    '  - "File path/to/file.ext exists"',
    '  - "$ some_check_command"',
    "needs_human_review: false",
    "description: |",
    "  [Detailed implementation spec. Be specific — the executing agent",
    "  has no other context beyond this description and the project files.]",
    "```",
    "",
    "### Task Dependencies",
    "",
    "Use `depends_on` to declare ordering between tasks in the SAME batch.",
    "Reference tasks by their number in this batch (e.g., `depends_on: [1]` means wait for task 1 to complete and merge first).",
    "A dependent task will NOT start until all its dependencies are completed — use this when a task needs code from another task to be present on the branch.",
    "Leave empty (`depends_on: []`) when tasks can run in parallel.",
  );

  const system = systemParts.join("\n");

  const userParts = opts.verificationMode
    ? [
        opts.directiveContext,
        "",
        "---",
        "",
        `# Milestone ready for verification: ${opts.milestoneTitle}`,
        `milestone_id: ${opts.milestoneId ?? "(unknown)"}`,
        "",
        `Verification criteria: ${opts.milestoneVerification}`,
        "",
        "**ALL TASKS FOR THIS MILESTONE ARE COMPLETE.** You should now decide whether the milestone is actually done.",
        "",
        "Required workflow:",
        "1. Call `listMilestoneTasks` to confirm the task statuses match what you expect.",
        "2. Call `checkMilestoneReadyToAdvance` to see whether verification passes.",
        "3. If `ready: true`, call `advanceMilestone` to commit the state transition. The system will activate the next milestone automatically.",
        "4. If `ready: false`, generate corrective tasks in the ```next_tasks``` format below to address the specific blockers. Do NOT call `advanceMilestone` until the blockers are resolved.",
        "",
        "Use your read tools (readFile, gitDiff, runProjectCheck, compareCodeToClaim) freely to investigate before deciding. Do not advance based on assumption — observe the actual project state.",
        "",
        "If you generate corrective tasks, follow the same `next_tasks` output format below. If you successfully called `advanceMilestone`, you do not need to output a next_tasks block — just confirm what you did in your reply.",
      ]
    : [
        opts.directiveContext,
        "",
        "---",
        "",
        `# Current Milestone: ${opts.milestoneTitle}`,
        "",
        `Verification criteria: ${opts.milestoneVerification}`,
        "",
        "Generate the next 1-5 tasks to make progress toward this milestone.",
        "Focus on what's missing or incomplete.",
      ];

  if (opts.verificationIssues?.length) {
    const attempt = opts.correctionAttempt ?? 1;
    const isLateAttempt = attempt >= 2;
    userParts.push(
      "",
      `## CORRECTIVE PLANNING — Verification Failed (attempt ${attempt} of 3)`,
      "",
      "The milestone was verified and the following issues were found. You MUST generate tasks to fix these specific errors.",
      "Do NOT regenerate tasks that already exist — create NEW fix tasks with DIFFERENT titles.",
      "Use the read-only tools (readFile, gitDiff, inspectTaskOutcome, runProjectCheck) to investigate the root cause before generating tasks.",
      "",
      "**Verification errors:**",
      ...opts.verificationIssues.map(issue => `- ${issue}`),
    );
    if (isLateAttempt) {
      userParts.push(
        "",
        `**This is attempt ${attempt}. Previous corrective attempts have failed.**`,
        "Do NOT just retry the same fix with minor variations — that's the loop you are in.",
        "Required:",
        "1. Use `inspectTaskDiff` on the failed corrective tasks from previous attempts to see EXACTLY what was tried and why it didn't work.",
        "2. Diagnose the ROOT CAUSE — is the verification criterion wrong? Is there a missing dependency? Is the test environment broken?",
        "3. Either generate a fundamentally different approach, OR if you genuinely cannot fix this, output a `next_tasks` block containing a single task of type `claude` with description `[needs_human_review] <explanation of why this milestone is stuck>` so a human can intervene.",
      );
      if (attempt >= 3) {
        userParts.push(
          "",
          "**Attempt 3 is the final automated attempt.** If this fails, the milestone will be escalated to human review automatically. Make this attempt count — change strategy, not tactics.",
        );
      }
    }
  }

  if (opts.idleMachineTypes?.length) {
    const typeLabels: Record<string, string> = {
      inference: "code/review/content",
      comfyui: "art/music/sfx",
    };
    const idleDesc = opts.idleMachineTypes
      .map(t => `**${t}** (runs ${typeLabels[t] ?? t} tasks)`)
      .join(" and ");
    userParts.push(
      "",
      `**PRIORITY:** The following machine type(s) are currently idle with no queued work: ${idleDesc}.`,
      "You MUST generate at least one task for each idle machine type so they are not wasted.",
      "Other tasks are still running — this is a top-up request, not a full batch.",
    );
  }

  const user = userParts.join("\n");

  return { system, user };
}

// ─── Verification Prompt ────────────────────────────────────────────────────

export function buildVerificationPrompt(opts: {
  taskTitle: string;
  taskDescription: string;
  acceptanceCriteria: string[];
  gitDiff: string;
  projectConventions?: string;
  /**
   * Free-form notes from the executor about this run. Currently used by the
   * SubmitGuard escalation path: when the agent's submit loop got stuck
   * (repeat-same-failure or no-writes-between-submits), the executor commits
   * the partial work and forwards the gate failure history here so the
   * verifier can decide whether the gates were wrong or the work was wrong.
   */
  executorNotes?: string;
}): { system: string; user: string } {
  const system = [
    "You are an independent code reviewer evaluating work produced by an automated coding agent.",
    "You are NOT the agent that did the work — you are a separate evaluator.",
    "",
    "Evaluate whether the implementation correctly satisfies all requirements.",
    "Be rigorous but fair. Minor style issues are not failures.",
    "",
    "## Tools",
    "",
    "You have read-only access to the project filesystem. Use your tools to verify the work:",
    "- **readFile** — read file contents to verify implementations",
    "- **listDirectory** — check that expected files/directories exist",
    "- **searchFiles** — grep for patterns, imports, usages",
    "- **runCommand** — run shell commands (tests, linters, find, wc, etc.)",
    "- **gitStatus** / **gitDiff** — inspect the working tree",
    "",
    "Do NOT rely solely on the git diff provided. Use your tools to independently verify",
    "that the acceptance criteria are met — check files exist, check contents are correct,",
    "run any verification commands mentioned in the criteria.",
    "",
    "## Verdict",
    "",
    "After your investigation, output your verdict in this exact format:",
    "",
    "```verdict",
    "result: pass | fail | escalate",
    "confidence: 0.0-1.0",
    "issues:",
    "  - [list any issues found, or 'none']",
    "reasoning: [brief explanation of your verdict]",
    "```",
    "",
    "Use 'escalate' when you're genuinely uncertain whether the work is correct",
    "(e.g., it involves design decisions you can't evaluate, or the requirements are ambiguous).",
  ].join("\n");

  const criteriaList = opts.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n");

  const userParts: string[] = [
    `# Task: ${opts.taskTitle}`,
    "",
    "## Description",
    opts.taskDescription,
    "",
    "## Acceptance Criteria",
    criteriaList,
    "",
    "## Changes Made (git diff)",
    "```diff",
    opts.gitDiff,
    "```",
  ];

  if (opts.executorNotes && opts.executorNotes.includes("[ESCALATED_TO_VERIFIER]")) {
    userParts.push(
      "",
      "## ⚠ Executor flagged this run for review",
      "",
      "The Foreman executor's SubmitGuard detected that the agent got stuck during this run.",
      "The agent's partial work was committed anyway so you can evaluate it. Two outcomes are common:",
      "",
      "1. **The gate command itself was broken** (wrong path, missing dep, can't run inside the worktree).",
      "   In this case the AGENT'S CODE may actually be correct — verdict should be `pass` and you should",
      "   note in `reasoning` that the project's gate command needs fixing.",
      "2. **The agent genuinely couldn't fix the failures** and the work is broken. Verdict should be",
      "   `fail` or `escalate` with specific issues listed.",
      "",
      "Use your tools to independently verify the work. Trust your own judgment over the executor's suspicion.",
      "",
      "### Executor notes",
      "```",
      opts.executorNotes,
      "```",
    );
  }

  userParts.push(
    "",
    "Review the diff above, then use your tools to independently verify the acceptance criteria are satisfied.",
  );

  const user = userParts.join("\n");

  if (opts.projectConventions) {
    return { system: system + "\n\n## Project Conventions\n" + opts.projectConventions, user };
  }

  return { system, user };
}

// ─── Milestone Verification Prompt ──────────────────────────────────────────

export function buildMilestoneVerificationPrompt(opts: {
  milestoneTitle: string;
  milestoneVerification: string;
  completedTaskSummaries: string;
  projectState: string;
}): { system: string; user: string } {
  const system = [
    "You are evaluating whether a project milestone has been achieved.",
    "Review the verification criteria against the current project state and completed work.",
    "",
    "Output your verdict:",
    "",
    "```verdict",
    "result: pass | fail",
    "confidence: 0.0-1.0",
    "issues:",
    "  - [list any issues, or 'none']",
    "reasoning: [explanation]",
    "```",
  ].join("\n");

  const user = [
    `# Milestone: ${opts.milestoneTitle}`,
    "",
    "## Verification Criteria",
    opts.milestoneVerification,
    "",
    "## Completed Tasks",
    opts.completedTaskSummaries,
    "",
    "## Current Project State",
    opts.projectState.slice(0, 15000),
  ].join("\n");

  return { system, user };
}

// ─── Corrective Planning Prompt ─────────────────────────────────────────────

export function buildCorrectivePlanningPrompt(opts: {
  directiveContext: string;
  failedTaskTitle: string;
  failedTaskDescription: string;
  errorMessage: string;
  retryCount: number;
}): { system: string; user: string } {
  const system = [
    "You are a project director. A task has failed after multiple retries.",
    "Analyze the failure and decide how to proceed.",
    "",
    "You may:",
    "1. Generate a corrective task (simpler approach, different strategy)",
    "2. Generate a task that undoes partial work and tries fresh",
    "3. Recommend escalation to human review (if the failure is beyond automated fixing)",
    "",
    "If generating tasks, use the ```next_tasks format.",
    "If recommending escalation, output:",
    "",
    "```escalate",
    "reason: [why human intervention is needed]",
    "question: [what to ask the human]",
    "```",
  ].join("\n");

  const user = [
    opts.directiveContext,
    "",
    "---",
    "",
    `# Failed Task: ${opts.failedTaskTitle}`,
    "",
    "## Original Description",
    opts.failedTaskDescription,
    "",
    `## Error (after ${opts.retryCount} retries)`,
    opts.errorMessage,
    "",
    "Analyze this failure and generate a corrective plan.",
  ].join("\n");

  return { system, user };
}
