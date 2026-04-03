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
  directiveContext: string;   // assembled by memory.ts
  milestoneTitle: string;
  milestoneVerification: string;
  workflowSummary?: string | null;
  /** Machine types that are idle and need tasks. */
  idleMachineTypes?: string[];
  /** Whether the project has a locked art style */
  styleLocked?: boolean;
}): { system: string; user: string } {
  const systemParts = [
    "You are a project director generating the next batch of tasks for autonomous execution.",
    "",
    "You have access to persistent memory tools. Before generating tasks, use searchMemory to check",
    "for relevant conventions, past decisions, and workflows. After planning, save any new insights:",
    "- **writeConvention**: Save new project rules discovered during planning",
    "- **writeSemanticMemory**: Save stable facts (e.g., 'sprite resolution is 64x64')",
    "- **writeProcedure**: Save repeatable workflows you establish",
    "",
    "Each task you generate will be executed independently by an AI coding agent with access to",
    "the project's filesystem, build tools, and documentation lookup.",
    "",
    "Rules:",
    "- Generate 1-5 tasks that make progress toward the current milestone",
    "- Each task must be independently executable (no shared state between tasks)",
    "- Each task must have concrete, verifiable acceptance criteria",
    "- Do NOT regenerate tasks that already exist (check Recent Task Results)",
    "- Do NOT generate tasks for work that's already done (check the project state)",
    "- Tasks should be appropriately sized: a single system or feature, not an entire module",
    "- Set needs_human_review: true for tasks involving aesthetic/design choices",
    "- **Maximize parallelism across machine types.** Code tasks run on inference machines",
    "  and art/music/sfx tasks run on separate ComfyUI machines. Whenever possible, include",
    "  BOTH code and art tasks in the same batch so both machines stay busy. Art assets that",
    "  will eventually be needed (sprites, backgrounds, icons, UI elements, audio) can be",
    "  generated early — they don't need to wait for the code that uses them.",
    "",
    "## Task Types",
    "",
    "- **code**: Programming tasks executed by an AI coding agent",
    "- **art**: Visual asset generation via ComfyUI (sprites, backgrounds, icons, UI, etc.)",
    "- **music**: Music generation via ComfyUI (ACE-Step) — NOT YET VERIFIED. Do not generate music tasks unless the user confirms audio models are set up.",
    "- **sfx**: Sound effect generation via ComfyUI (AudioGen) — NOT YET VERIFIED. Do not generate sfx tasks unless the user confirms audio models are set up.",
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
    "These tasks will always go through human review.",
    "The target_files should list the output path for the generated asset.",
    "",
    "**ComfyUI Prompt Guidelines:**",
    "- Each prompt generates ONE image of ONE subject — not sheets, grids, or collections",
    "- Be descriptive and specific: subject, style, colors, lighting, composition",
    "- Good: 'pixel art golden coin with skull emblem, dark fantasy, purple glow, transparent background'",
    "- Bad: 'coin icon' (too vague) or 'several coins in different styles' (multiple subjects)",
    "- Include 'transparent background' for sprites/icons that need alpha",
    "- Include resolution hints matching the preset ('64x64 pixel art' for pixel_sprite)",
    "- For music: describe genre, mood, tempo, instruments (e.g., 'ambient dark fantasy loop, slow tempo, deep strings and chimes')",
    "- For sfx: describe the sound precisely (e.g., 'short magical sparkle chime, high pitch, 2 seconds')",
    "",
    "Available asset types and their built-in presets:",
    "- sprite → pixel_sprite (SDXL + pixel art LoRA, 1024x1024)",
    "- icon → icon (SDXL + pixel art LoRA, 512x512)",
    "- tileset → pixel_sprite",
    "- portrait → portrait (SDXL, 768x1024)",
    "- background → background (SDXL, 1024x768)",
    "- concept → concept (SDXL, 1024x1024, high quality, 25 steps)",
    "- ui → icon",
    "",
    "Additional presets (use via [asset_type:] hint or explicit [preset:] tag):",
    "- game_asset → game_asset (SDXL + game assets LoRA — items, props, sprites with clean backgrounds)",
    "- fast_draft → fast_draft (SDXL, 12 steps — quick previews and iterations)",
    "",
    "The system will automatically select the correct preset based on [asset_type:].",
    "You can also force a specific preset with `[preset: game_asset]` in the description.",
    "No workflow template files are required — just provide the hints above.",
    "",
    "### Style Exploration",
    "",
    "- **style_exploration**: Generate multiple style variations for the user to choose from.",
    "  Use type `style_exploration` with `[variation_count: 6]` in the description.",
    "",
    "  **IMPORTANT**: The prompt must describe a SINGLE representative scene or object — NOT a style sheet,",
    "  NOT a grid of assets, NOT multiple items on one image. The selected image becomes the IP-Adapter",
    "  reference that conditions all future art generation. IP-Adapter works best with one cohesive image",
    "  that captures the target palette, shading style, and mood.",
    "",
    "  Good prompts: 'pixel art treasure chest in a dark dungeon, glowing purple runes, gold trim'",
    "  Bad prompts: 'style sheet with multiple sprites showing different approaches'",
    "",
    "  Each variation uses a different random seed, so 6 prompts of the same subject produce 6 different",
    "  visual interpretations. The user picks the one whose overall aesthetic they want applied everywhere.",
    "",
    "  Example description hints:",
    "    [preset: concept]",
    "    [prompt: pixel art ancient spellbook on a stone altar, dark fantasy, deep purples and midnight blues, gold arcane symbols, glowing cyan accents]",
    "    [variation_count: 6]",
    "    [output: .swe/art/style_exploration/]",
  ];

  // Style lock awareness
  if (opts.styleLocked === false) {
    systemParts.push(
      "",
      "**⚠️ ART STYLE NOT ESTABLISHED**: This project does not have a locked art style yet.",
      "Before generating any `art` tasks, you SHOULD generate a `style_exploration` task first",
      "so the user can approve a visual style. You may still generate art tasks — they will just",
      "lack style consistency until a style is locked. Prioritize style exploration early.",
    );
  } else if (opts.styleLocked === true) {
    systemParts.push(
      "",
      "**✓ Art style is locked.** All art tasks automatically use IP-Adapter conditioning",
      "with the approved reference image. Generate art tasks freely.",
    );
  }

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
    "Based on the project state, design document, and progress above,",
    "generate the next 1-5 tasks to make progress toward this milestone.",
    "Include a mix of code and art/audio tasks when possible to keep all machines busy.",
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
