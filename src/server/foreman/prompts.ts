/**
 * Foreman prompt construction for task execution.
 */

export function buildForemanSystemPrompt(opts: {
  projectName: string;
  projectWorkdir: string;
  taskType: string;
  targetFiles: string[];
  codeConventions?: string;
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
    "- After completing the task, verify your work meets all acceptance criteria.",
  ];

  if (opts.targetFiles.length > 0) {
    parts.push("", "Target files to create/modify:", ...opts.targetFiles.map(f => `  - ${f}`));
  }

  if (opts.codeConventions) {
    parts.push("", "Code conventions:", opts.codeConventions);
  }

  return parts.join("\n");
}

export function buildForemanUserPrompt(opts: {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  previousError?: string;
  previousOutput?: string;
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

  if (opts.previousError) {
    parts.push(
      "",
      "## Previous Attempt Failed",
      "",
      "The previous attempt failed with the following error. Analyze what went wrong and try a different approach:",
      "",
      opts.previousError,
    );
  }

  if (opts.previousOutput) {
    parts.push(
      "",
      "## Previous Attempt Output",
      "",
      opts.previousOutput,
    );
  }

  return parts.join("\n");
}
