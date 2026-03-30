/**
 * Shared prompt sections used across multiple pipeline stages.
 */

export function workingEnv(workingDir: string): string {
  return `You are operating in a **git worktree** at \`${workingDir}\`.

All file paths are **relative to the project root** — never use absolute paths.
Shell commands via \`runCommand\` run in an isolated shell rooted at the project directory.
Do not use shell commands to read files — use \`readFile\` instead.
You can call multiple tools in a single response — do this whenever calls are independent of each other.`;
}

export const CODING_STANDARDS = `
### Coding Standards
- Make ADDITIVE changes — add new functions, methods, and endpoints alongside existing code
- NEVER rewrite, restructure, or reorganize existing files. If you need to change more than a few lines in a function, something is wrong — stop and reconsider.
- NEVER change function signatures, constructor parameters, return types, or export shapes of existing code — other code depends on them
- NEVER remove or disconnect existing event handlers, callbacks, or interactive behavior. If a component currently responds to clicks, it must still respond to clicks after your change. Add new interactions alongside existing ones (e.g. use stopPropagation to intercept specific sub-element clicks without breaking the parent handler).
- Use \`replaceInFile\` for modifying existing files. Only use \`writeFile\` for creating brand new files.
- Read files before modifying them
- Fix root causes, not symptoms
- Maintain existing code style — match the patterns already in the file
- Write concise, clear code
- NEVER add inline comments unless a core maintainer would not understand the code without them
- After making changes, call \`checkBuild\` to verify your changes compile
- Any docstrings must be VERY concise (1 line preferred)
- Never add copyright/license headers unless requested`;
