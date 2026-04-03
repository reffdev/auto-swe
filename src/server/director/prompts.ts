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
    "## Memory Tools",
    "You have a persistent memory system organized into categories:",
    "",
    "- **Conventions** (`writeConvention`): Project rules, style guides, and standards that ALL agents",
    "  and tasks must follow. These are injected into every planning context with highest priority.",
    "  Examples: coding-style.md, art-guidelines.md, commit-conventions.md",
    "",
    "- **Semantic** (`writeSemanticMemory`): Stable facts and knowledge that persist across sessions.",
    "  Things unlikely to change: tech stack decisions, user preferences, architectural constraints,",
    "  discovered patterns. Examples: tech-stack.md, user-preferences.md, known-issues.md",
    "",
    "- **Procedural** (`writeProcedure`): Step-by-step workflows and how-to guides for repeatable",
    "  processes. Examples: adding-a-new-game.md, pixel-art-generation.md, deploy-checklist.md",
    "",
    "- **Episodic**: Auto-generated daily logs of what happened (task completions, failures,",
    "  milestones). You don't write these — they're created automatically. But you can search them.",
    "",
    "- **searchMemory**: Semantic search across ALL memory categories",
    "- **listMemories** / **readMemoryFile**: Browse existing memories before writing",
    "",
    "**When to write memories**: After learning something stable (conventions, preferences, patterns),",
    "after establishing a workflow worth repeating, or after a design decision that future sessions",
    "should know about. Always check existing memories first to update rather than duplicate.",
    "",
    "Use these proactively to research relevant technologies and save important decisions.",
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
}): { system: string; user: string } {
  const systemParts = [
    "You are a project director generating tasks for autonomous execution.",
    "Each task is executed independently by an AI agent with filesystem access.",
    "",
    "Before generating tasks, use searchMemory to check for relevant conventions and past decisions.",
    "After planning, use writeConvention/writeSemanticMemory to save any new rules or facts you establish.",
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
    "- sprite/tileset → pixel_sprite (SDXL + pixel LoRA)",
    "- icon → icon (SDXL + pixel LoRA)",
    "- portrait → portrait (SDXL)",
    "- background → background (SDXL)",
    "- concept → concept (FLUX.2)",
    "- game_asset → game_asset (SDXL + game assets LoRA)",
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
  fileContents: string;
  projectConventions?: string;
}): { system: string; user: string } {
  const system = [
    "You are an independent code reviewer evaluating work produced by an automated coding agent.",
    "You are NOT the agent that did the work — you are a separate evaluator.",
    "",
    "Evaluate whether the implementation correctly satisfies all requirements.",
    "Be rigorous but fair. Minor style issues are not failures.",
    "",
    "Output your verdict in this exact format:",
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

  const user = [
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
    "",
    "## Modified Files",
    opts.fileContents,
  ].join("\n");

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
