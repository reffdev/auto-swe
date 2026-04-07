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
    "You have access to tools for research and persistent memory.",
    "",
    "## Research Tools",
    "- **webSearch**: Search the web for current information",
    "- **fetchUrl**: Read a specific web page",
    "- **lookupDocs**: Look up library/framework documentation",
    "",
    "## Memory System",
    "",
    "You have a persistent memory system designed for autonomous agents. It is organized so",
    "that the right knowledge surfaces at the right time without overflowing context.",
    "",
    "### How memory is consumed",
    "",
    "- The **PROJECT BRIEF** is the only thing always injected into every agent context.",
    "  It must be small (under ~3000 chars) and capture project identity: tech stack,",
    "  key architectural decisions, critical rules. Use `updateProjectBrief` to maintain it.",
    "",
    "- **Conventions, semantic memory, and procedures** are NOT all loaded at once. They",
    "  are surfaced via semantic search when relevant to the current task or planning",
    "  context. Write freely — search handles relevance — but use clear, specific filenames",
    "  so search can find what's needed.",
    "",
    "### What goes where",
    "",
    "- **`updateProjectBrief`** — The single always-injected identity document. Project",
    "  name, tech stack, key invariants. Keep it tight. Don't append; replace.",
    "",
    "- **`writeConvention`** — Detailed knowledge agents need when working on a specific area:",
    "  system specifications, style guides, format definitions, reference material.",
    "  ONE topic per file. Examples: `currency-manager-spec.md`, `art-guidelines.md`,",
    "  `gdscript-naming.md`. NOT for status updates, completion notes, or debug findings.",
    "",
    "- **`writeSemanticMemory`** — Facts, learnings, and discoveries you want to remember",
    "  but don't need in every task: task outcomes, debug findings, milestone status,",
    "  user preferences, architectural decisions worth recalling.",
    "",
    "- **`writeProcedure`** — Step-by-step workflows. How to add a new game, how to set up",
    "  a new system. Procedures answer 'how do I do X?'.",
    "",
    "- **Episodic** — Auto-generated daily activity logs. You don't write these directly,",
    "  but they're searchable.",
    "",
    "### Tools",
    "",
    "- `updateProjectBrief` — maintain the always-injected project identity",
    "- `writeConvention` / `writeSemanticMemory` / `writeProcedure` — save knowledge",
    "- `searchMemory` — semantic search across everything",
    "- `listMemories` — browse files in a category (use 'convention' to list conventions)",
    "- `readMemoryFile` — read a specific file before updating",
    "- `editMemory` / `deleteMemory` — refine or remove existing memories",
    "",
    "### When to write what",
    "",
    "- Learned a critical project-wide rule? → Update the **project brief**",
    "- Specifying a system, format, or detailed style guide? → **Convention**",
    "- Recording status, findings, or learnings? → **Semantic memory**",
    "- Documenting a multi-step process? → **Procedure**",
    "- 'Status update' is NEVER a convention. 'Task complete' is NEVER a convention.",
    "",
    "Always check existing memories first (search or list) to update rather than duplicate.",
    "Use search proactively when planning to find relevant prior work and decisions.",
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
}): { system: string; user: string } {
  const systemParts = [
    "You are a project director generating tasks for autonomous execution.",
    "Each task is executed independently by an AI agent with filesystem access.",
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
  ];

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

  const userParts = [
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
    userParts.push(
      "",
      "## CORRECTIVE PLANNING — Milestone Verification Failed",
      "",
      "The milestone was verified and the following issues were found. You MUST generate tasks to fix these specific errors.",
      "Do NOT regenerate tasks that already exist — create NEW fix tasks with DIFFERENT titles.",
      "Use the read-only tools to investigate the root cause before generating tasks.",
      "",
      "**Verification errors:**",
      ...opts.verificationIssues.map(issue => `- ${issue}`),
    );
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
