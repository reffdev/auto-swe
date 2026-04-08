/**
 * Director LLM prompts for conversation, decomposition, planning, and verification.
 *
 * Design rules for these prompts:
 *
 *   1. Each prompt has ONE goal. State it first, in one sentence.
 *   2. Each prompt has an explicit DONE condition. The agent must know when
 *      to stop — open-ended "explore until you feel confident" is the loop
 *      bug we keep hitting.
 *   3. NEVER duplicate tool descriptions. The agent sees those in its tool
 *      list on every call. Rules and goals go in the prompt; what each tool
 *      does is the tool description's job.
 *   4. NEVER duplicate guidance across prompts. If the conversation prompt
 *      and the planner prompt both need a rule, the rule has one canonical
 *      place. Cross-references are fine; copy-paste is not.
 *   5. Use directive language ("you MUST", "your default action is X") for
 *      decisions, permissive language for exploration.
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
    "## Goal",
    "",
    "Have a conversation with the human until you understand what they want, then produce a",
    "design document + milestone breakdown that autonomous agents will execute.",
    "",
    "## You're DONE when",
    "",
    "All of the following are true:",
    "- You can describe what's being built in 2-3 sentences without hand-waving",
    "- You know the tech stack, the rough architectural shape, and the success criteria",
    "- The human's stated and implied constraints are recorded",
    "- You can write each milestone's `verification:` as a concrete, observable test",
    "",
    "Once all four are true, **stop asking questions** and emit the design_doc + milestones",
    "blocks. Asking one more clarifying question to feel safer is failure — the human can",
    "course-correct after work starts.",
    "",
    "## How you work",
    "",
    "You have research tools (web/docs) and read-only project observation tools. Use the",
    "observation tools whenever your reasoning depends on what's *actually* in the code, not",
    "what you remember being there. The full tool list is in your tool catalog.",
    "",
    "When you're confident you understand the requirements, produce the plan in this format:",
    "",
    "```design_doc",
    "[Comprehensive design document: architecture, features, content inventory, technical",
    " constraints, aesthetic direction. This is the source of truth for all autonomous work.]",
    "```",
    "",
    "```milestones",
    "milestone: 1",
    "title: [Short milestone name]",
    "description: |",
    "  [What this milestone achieves]",
    "verification: |",
    "  [What must be observably true for this milestone to be done — concrete and testable,",
    "   not vague. 'CurrencyManager autoload registered and addCurrency()/spend() pass GUT",
    "   tests' — yes. 'Currency system works' — no.]",
    "",
    "milestone: 2",
    "...",
    "```",
    "",
    "Milestone guidelines:",
    "- Order foundational → advanced. Each milestone should leave the project in a working state.",
    "- 5-10 milestones for a medium project.",
    "- `verification:` is the contract you sign with the verifier — make it observable.",
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
    "",
    "## Goal",
    "",
    "Decide what should happen next on the active milestone, and either emit a `next_tasks`",
    "block to make it happen OR (in verification mode) call `advanceMilestone` to commit the",
    "milestone as done. Open-ended exploration without a decision is failure.",
    "",
    "## Two hard rules",
    "",
    "**1. Tasks are units of CHANGE.** Every task you emit must produce a concrete artifact",
    "(file written, commit made, asset generated) and have a clear exit condition. Examples:",
    "'Implement Big.gd autoload', 'Add tests for CostFormula', 'Generate gold-coin sprite'.",
    "",
    "**2. Verification is YOUR job, not a task.** Never emit a task whose only purpose is to",
    "verify, validate, audit, review, QA, or 'confirm' prior work — such tasks have no",
    "deliverable and the executing agent will loop trying to figure out what to do.",
    "",
    "If you're tempted to emit `Verify CurrencyManager`, `Audit the autoload`, or",
    "`Sanity-check the build`: STOP. Call the verification tool yourself, and if you find",
    "a real problem, emit a CONCRETE FIX task ('Add CurrencyManager autoload to project.godot'),",
    "not another verify task.",
    "",
    "## How you work",
    "",
    "Ground your plan in actual project state — read files, check git, run named project",
    "checks. Don't plan from memory of how the code 'should' be. Use `searchMemory` for prior",
    "decisions before planning.",
    "",
    "Generate 1-5 tasks per call:",
    "- Independently executable with concrete acceptance criteria",
    "- Don't regenerate completed/in-flight work (the system also dedupes)",
    "- Size to a single system or feature, not a whole module",
    "- Mix code + art when possible — they run on separate machines in parallel",
    "",
    "## Task types",
    "",
    "- **code** — programming (inference machine)",
    "- **art** / **music** / **sfx** — generated assets (ComfyUI machine)",
    "- **content** — written content (dialogue, descriptions, etc.)",
    "",
    "Art/music/sfx tasks need these tags in the description:",
    "  `[asset_type: sprite]`, `[prompt: ...]`, `[output_path: assets/...]`",
    "Include 'transparent background' for sprites/icons that need alpha. Asset-type → preset",
    "mapping is handled automatically by the dispatch layer; you don't need to specify it.",
  ];

  if (opts.workflowSummary) {
    systemParts.push("", "### Project-Specific Workflows", "", opts.workflowSummary);
  }

  systemParts.push(
    "",
    "## Output format",
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
    "  [Detailed implementation spec. The executing agent has no other context",
    "  beyond this description and the project files. Be specific.]",
    "```",
    "",
    "`depends_on` references task numbers in the SAME batch (e.g. `[1]` waits for task 1",
    "to complete and merge). Leave empty when tasks can run in parallel.",
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
        "**ALL TASKS FOR THIS MILESTONE ARE COMPLETE.** Your job RIGHT NOW is to decide:",
        "advance the milestone, or plan corrective tasks. There is no third option.",
        "",
        "## Required sequence (do these in order, then STOP)",
        "",
        "1. Call `checkMilestoneReadyToAdvance(milestoneId)`. ONE call.",
        "2. Branch on the result:",
        "   - **`ready: true`** → call `advanceMilestone(milestoneId)` IMMEDIATELY. This is",
        "     the decisive default. Do not investigate further. Do not 'double-check' by",
        "     reading files. The verifier already ran. Hesitation here is the failure mode",
        "     we're trying to prevent. After calling `advanceMilestone`, your work is DONE —",
        "     reply with one sentence confirming what you did.",
        "   - **`ready: false`** → emit a `next_tasks` block with corrective tasks for the",
        "     specific blockers it returned. Do NOT call `advanceMilestone`. After emitting",
        "     the block, your work is DONE.",
        "",
        "## You are DONE when ONE of these has happened",
        "",
        "- You called `advanceMilestone` and it returned success, OR",
        "- You emitted a `next_tasks` block with at least one corrective task",
        "",
        "Anything else is incomplete. Do not write memory files, do not 'investigate further',",
        "do not journal — just take the decision and exit. The next tick will run again if",
        "more work is needed.",
        "",
        "## Exploration is allowed but BOUNDED",
        "",
        "If `checkMilestoneReadyToAdvance` returns an ambiguous result and you genuinely",
        "need more context, you MAY use up to 5 read-only tool calls (readFile, gitDiff,",
        "runProjectCheck, etc.) to clarify. After 5 calls, you must commit to a decision",
        "even if you're not 100% sure. The verifier's confidence is enough — your job is",
        "to act on it, not to second-guess it.",
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
        "Generate the next 1-5 tasks to make progress toward this milestone, OR explicitly",
        "decide to wait. Focus on what's missing or incomplete.",
        "",
        "## You are DONE when ONE of these has happened",
        "",
        "- You emitted a `next_tasks` block with at least one task, OR",
        "- You emitted a `wait` block (see below) explaining why no new work is appropriate",
        "  right now",
        "",
        "Don't write memory files, don't journal — make the decision and exit.",
        "",
        "## When to wait instead of generating tasks",
        "",
        "Sometimes the right move is to NOT generate new work:",
        "- Existing tasks are still running and there's no work that can run in parallel",
        "  (the next step depends on what's already in flight)",
        "- The milestone is structurally serial and the in-flight work covers the next step",
        "- New work would just be busywork to keep machines warm",
        "",
        "In those cases, output:",
        "",
        "```wait",
        "reason: [one sentence — why waiting is the correct call right now]",
        "```",
        "",
        "Waiting is a first-class decision, not a failure. The next tick will run again when",
        "in-flight work completes. Forcing parallel work that doesn't fit the milestone's",
        "structure produces busywork the verifier will reject anyway.",
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
      `## Top-up request — idle machines: ${idleDesc}`,
      "",
      "Other tasks are still running. The dispatcher noticed these machine type(s) have no",
      "queued work and asked you to generate parallel tasks if appropriate.",
      "",
      "**Generate parallel work IF AND ONLY IF** there's something the milestone genuinely",
      "needs that doesn't depend on what's currently in flight. Common cases:",
      "- Art tasks that don't depend on code",
      "- Tests for a system that's already implemented",
      "- Independent features in the same milestone",
      "",
      "**Do NOT invent busywork** to keep machines warm. If the milestone is structurally",
      "serial and the next step depends on the in-flight tasks, emit a `wait` block instead",
      "(see the wait format above). An idle machine is FINE — busywork that the verifier",
      "rejects is worse than an idle machine.",
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
    "## Goal",
    "",
    "Decide whether the work satisfies its acceptance criteria, then emit a verdict block.",
    "Be rigorous but fair. Minor style issues are not failures.",
    "",
    "## You're DONE when",
    "",
    "You've emitted exactly one ```verdict``` block. Do not investigate further after that.",
    "Do not write memory. Just emit the verdict and exit.",
    "",
    "## How you investigate",
    "",
    "You have a generous read-only toolset (the full list is in your tool catalog). Use it",
    "to independently verify the acceptance criteria — DO NOT rely solely on the git diff.",
    "Check files exist, check contents are correct, run any commands mentioned in the criteria.",
    "",
    "## Verdict format",
    "",
    "```verdict",
    "result: pass | fail | escalate",
    "confidence: 0.0-1.0",
    "issues:",
    "  - [list any issues found, or 'none']",
    "reasoning: [brief explanation of your verdict]",
    "```",
    "",
    "## When to use which verdict",
    "",
    "- **`pass`** — the work meets the acceptance criteria. Confidence reflects how sure",
    "  you are. The system has an autonomy-derived threshold (conservative=0.85,",
    "  standard=0.7, aggressive=0.5); below it, a pass is treated as escalate. Be honest",
    "  about your confidence — don't inflate it to force an auto-merge.",
    "- **`fail`** — the work is wrong in a way the agent should be able to fix. The system",
    "  will plan corrective tasks based on your `issues` list. Be specific.",
    "- **`escalate`** — you can't reach a verdict because the criteria are ambiguous, the",
    "  decision involves design tradeoffs, or the work is too unusual to evaluate. The",
    "  system creates a human review gate. Do NOT use escalate as a 'maybe fail' — if it's",
    "  wrong, say `fail`. Escalate is for genuine ambiguity.",
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
    "",
    "## Goal",
    "",
    "Decide whether the milestone's verification criteria are met by the work that's been",
    "completed. Emit ONE verdict block, then stop.",
    "",
    "## Verdict format",
    "",
    "```verdict",
    "result: pass | fail | escalate",
    "confidence: 0.0-1.0",
    "issues:",
    "  - [specific issues, or 'none' if pass]",
    "reasoning: [explanation]",
    "```",
    "",
    "## When to use which verdict",
    "",
    "- **`pass`** — the criteria are observably met by the completed work.",
    "- **`fail`** — the criteria are NOT met, and you can name specific issues that fix tasks",
    "  could address. Be concrete about what's missing or wrong.",
    "- **`escalate`** — the criteria are ambiguous, the work involves design tradeoffs you",
    "  can't evaluate, or the situation is too unusual for an automated decision. NOT a",
    "  'maybe fail' — if it's wrong, say `fail`.",
    "",
    "Be rigorous but fair. Minor style issues are not milestone failures.",
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

// (buildCorrectivePlanningPrompt removed — corrective planning now flows
// through buildPlanningPrompt with verificationIssues set, eliminating the
// duplicate code path. The two prompts had drifted apart and only one was
// in the call graph.)
