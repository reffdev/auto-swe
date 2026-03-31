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
    "During this conversation:",
    "1. Read and understand any design documents provided below",
    "2. Ask clarifying questions about scope, priorities, constraints, and preferences",
    "3. Identify ambiguities and resolve them with the human",
    "4. Once requirements are clear, produce a structured plan",
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
  directiveContext: string;   // assembled by memory.ts
  milestoneTitle: string;
  milestoneVerification: string;
  workflowSummary?: string | null;
}): { system: string; user: string } {
  const systemParts = [
    "You are a project director generating the next batch of tasks for autonomous execution.",
    "",
    "Each task you generate will be executed independently by an AI coding agent with access to",
    "the project's filesystem, build tools, and documentation lookup.",
    "",
    "Rules:",
    "- Generate 1-3 tasks that make progress toward the current milestone",
    "- Each task must be independently executable (no shared state between tasks)",
    "- Each task must have concrete, verifiable acceptance criteria",
    "- Do NOT regenerate tasks that already exist (check Recent Task Results)",
    "- Do NOT generate tasks for work that's already done (check the project state)",
    "- Tasks should be appropriately sized: a single system or feature, not an entire module",
    "- Set needs_human_review: true for tasks involving aesthetic/design choices",
    "",
    "## Task Types",
    "",
    "- **code**: Programming tasks executed by an AI coding agent",
    "- **art**: Visual asset generation via ComfyUI (sprites, backgrounds, icons, UI, etc.)",
    "- **music**: Music generation via ComfyUI audio workflows",
    "- **sfx**: Sound effect generation via ComfyUI audio workflows",
    "- **review**: Code review tasks",
    "- **content**: Content writing tasks (dialogue, descriptions, etc.)",
    "",
    "### Art/Music/SFX Tasks",
    "",
    "For art, music, and sfx tasks, include these structured hints in the description",
    "so the system can map them to the correct ComfyUI workflow:",
    "",
    "- `[asset_type: sprite]` — the type of asset (sprite, background, icon, portrait, tileset, ui, concept, sfx, music)",
    "- `[prompt: pixel art fire symbol, 64x64, transparent background]` — the generation prompt describing what to create",
    "- `[output_path: assets/sprites/fire_symbol.png]` — where to save the generated file",
    "",
    "These tasks will always go through human review. Be specific in the prompt —",
    "include art style, dimensions, color palette, and any other relevant details.",
    "The target_files should list the output path for the generated asset.",
    "",
    "Available asset types and their built-in presets:",
    "- sprite → pixel_sprite (SDXL + pixel art LoRA, 1024x1024)",
    "- icon → icon (SDXL + pixel art LoRA, 512x512)",
    "- tileset → pixel_sprite",
    "- portrait → portrait (SDXL, 768x1024)",
    "- background → background (SDXL, 1024x768)",
    "- concept → concept (FLUX, 1024x1024, high quality)",
    "- ui → icon",
    "",
    "The system will automatically select the correct preset based on [asset_type:].",
    "No workflow template files are required — just provide the hints above.",
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

  const user = [
    opts.directiveContext,
    "",
    "---",
    "",
    `# Current Milestone: ${opts.milestoneTitle}`,
    "",
    `Verification criteria: ${opts.milestoneVerification}`,
    "",
    "Based on the project state, design document, and progress above,",
    "generate the next 1-3 tasks to make progress toward this milestone.",
    "Focus on what's missing or incomplete.",
  ].join("\n");

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
    opts.gitDiff.slice(0, 10000),
    "```",
    "",
    "## Modified Files",
    opts.fileContents.slice(0, 20000),
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
