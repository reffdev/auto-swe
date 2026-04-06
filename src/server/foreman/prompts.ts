/**
 * Foreman prompt construction for task execution.
 */

export function buildForemanSystemPrompt(opts: {
  projectName: string;
  projectWorkdir: string;
  taskType: string;
  targetFiles: string[];
  /**
   * Pre-formatted memory context: project brief + relevant conventions + index
   * of available conventions. Already markdown-formatted by formatMemoryContext().
   */
  memoryContext?: string;
  designDoc?: string;
  milestoneContext?: string;
  directiveText?: string;
}): string {
  const parts: string[] = [
    `You are an autonomous developer working on the "${opts.projectName}" project.`,
    `Working directory: ${opts.projectWorkdir}`,
    "",
    "You have tools to read, write, search, and list files in the project.",
    "You also have tools to run build/lint checks and look up library documentation.",
    "",
    "Complete the task described in the user prompt. Follow these rules:",
    "- Read existing code before modifying it to understand patterns and conventions.",
    "- Create all files listed in target_files if they don't exist.",
    "- Write clean, production-quality code.",
    "- Follow the design document and milestone specifications exactly — paths, filenames, API routes, and conventions specified there are authoritative.",
    "- When you're done, call submitResult with your changed files and summary.",
    "- submitResult will automatically run build/test/lint checks. If any fail, you'll get the errors back — fix them and call submitResult again.",
    "- Do NOT call checkBuild/checkTests/checkLint manually before submitting — submitResult handles this.",
  ];

  if (opts.directiveText) {
    parts.push("", "## Project Directive", "", opts.directiveText);
  }

  if (opts.designDoc) {
    parts.push("", "## Design Document", "", opts.designDoc);
  }

  if (opts.milestoneContext) {
    parts.push("", "## Current Milestone", "", opts.milestoneContext);
  }

  if (opts.targetFiles.length > 0) {
    parts.push("", "Target files to create/modify:", ...opts.targetFiles.map(f => `  - ${f}`));
  }

  if (opts.memoryContext) {
    parts.push("", opts.memoryContext);
  }

  return parts.join("\n");
}

export function buildForemanUserPrompt(opts: {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  previousError?: string;
  previousOutput?: string;
  rebaseResetContext?: string;
}): string {
  const parts: string[] = [
    `# Task: ${opts.title}`,
    "",
    opts.description,
  ];

  if (opts.acceptanceCriteria.length > 0) {
    parts.push("", "## Acceptance Criteria", "");
    opts.acceptanceCriteria.forEach((c, i) => {
      parts.push(`${i + 1}. ${c}`);
    });
  }

  if (opts.rebaseResetContext) {
    parts.push("", opts.rebaseResetContext);
  }

  if (opts.previousError) {
    const isHumanFeedback = opts.previousError.includes("Human feedback:") || opts.previousError.startsWith("Rejected:");
    parts.push(
      "",
      isHumanFeedback
        ? "## IMPORTANT: Previous Attempt Rejected by Reviewer"
        : "## Previous Attempt Failed",
      "",
      "A previous attempt at this task has already been made. Your code from that attempt is still in the worktree.",
      "Do NOT start over from scratch.",
      "",
      isHumanFeedback
        ? "The following reviewer feedback is your PRIMARY objective. Address it directly — everything else in this task is context. The reviewer has seen your work and is telling you exactly what needs to change:"
        : "Read the error below and fix ONLY the specific issues:",
      "",
      opts.previousError,
    );
  }

  if (opts.previousOutput) {
    parts.push(
      "",
      "## What You Did Last Time",
      "",
      "Summary of your previous actions (your files are still in the worktree):",
      "",
      opts.previousOutput,
    );
  }

  return parts.join("\n");
}
