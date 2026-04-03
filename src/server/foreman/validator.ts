/**
 * Acceptance criteria validator for Foreman tasks.
 *
 * Parses human-readable criterion strings and runs the appropriate check.
 */

import { existsSync } from "fs";
import { resolve } from "path";
import { spawnSync } from "child_process";

export interface ValidationResult {
  criterion: string;
  passed: boolean;
  output: string;
}

/**
 * Validate all acceptance criteria for a completed task.
 * Each criterion runs independently — all must pass.
 */
export async function validateAcceptanceCriteria(
  projectWorkdir: string,
  criteria: string[],
  targetFiles: string[],
): Promise<{ allPassed: boolean; results: ValidationResult[] }> {
  const results: ValidationResult[] = [];

  for (const criterion of criteria) {
    const result = runSingleValidation(projectWorkdir, criterion, targetFiles);
    results.push(result);
  }

  return {
    allPassed: results.every(r => r.passed),
    results,
  };
}

function runSingleValidation(
  workdir: string,
  criterion: string,
  targetFiles: string[],
): ValidationResult {
  // Pattern: "File X exists ..."
  const fileExistsMatch = criterion.match(/^File\s+(.+?)\s+exists/i);
  if (fileExistsMatch) {
    const filePath = fileExistsMatch[1].replace(/["']/g, "");
    const fullPath = resolve(workdir, filePath);
    const exists = existsSync(fullPath);
    return {
      criterion,
      passed: exists,
      output: exists ? `File exists: ${fullPath}` : `File NOT found: ${fullPath}`,
    };
  }

  // Pattern: "$ command" or "Run: command" — run a shell command, exit 0 = pass
  // Note: commands come from YAML task files on disk (trusted source).
  // Reject obviously dangerous patterns as a safety net.
  const shellMatch = criterion.match(/^\$\s+(.+)/) ?? criterion.match(/^Run:\s+(.+)/i);
  if (shellMatch) {
    let cmd = shellMatch[1];
    // Strip trailing "returns N" expectation (e.g., "find ... | wc -l returns 15")
    const returnsMatch = cmd.match(/\s+returns?\s+(.+)$/i);
    let expectedOutput: string | null = null;
    if (returnsMatch) {
      expectedOutput = returnsMatch[1].trim();
      cmd = cmd.slice(0, -returnsMatch[0].length);
    }
    const dangerous = /rm\s+-rf|rmdir|del\s+\/|format\s|mkfs|dd\s+if=|>\s*\/dev/i;
    if (dangerous.test(cmd)) {
      return { criterion, passed: false, output: "Command rejected: contains dangerous pattern" };
    }
    const result = spawnSync(cmd, { cwd: workdir, shell: true, timeout: 60_000 });
    const output = ((result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? "")).trim();
    let passed = result.status === 0;
    // If "returns X" was specified, also check the output matches
    if (passed && expectedOutput) {
      passed = output.trim() === expectedOutput;
    }
    return {
      criterion,
      passed,
      output: output.slice(0, 2000) || `Exit code: ${result.status}`,
    };
  }

  // Pattern: mentions "parse error" or "loads without" — run Godot check if project.godot exists
  if (/parse error|syntax error|loads without|no.+error/i.test(criterion)) {
    const hasGodot = existsSync(resolve(workdir, "project.godot"));
    if (hasGodot) {
      const result = spawnSync("godot", ["--headless", "--check-only", "--path", workdir], {
        cwd: workdir, shell: true, timeout: 60_000,
      });
      const output = (result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? "");
      return {
        criterion,
        passed: result.status === 0,
        output: output.slice(0, 2000) || `Godot check exit code: ${result.status}`,
      };
    }
    // No Godot project — treat as pass with note
    return { criterion, passed: true, output: "No project.godot found — skipping Godot check" };
  }

  // Pattern: mentions "function X" or "signal X" — grep for it
  const funcMatch = criterion.match(/(?:function|func)\s+(\w+)/i);
  const signalMatch = criterion.match(/signal\s+(\w+)/i);
  const grepTarget = funcMatch?.[1] ?? signalMatch?.[1];
  if (grepTarget) {
    return grepForIdentifier(workdir, grepTarget, targetFiles, criterion);
  }

  // Pattern: mentions "type hints" — check that func declarations have return types
  if (/type\s*hints?/i.test(criterion)) {
    return checkTypeHints(workdir, targetFiles, criterion);
  }

  // Default: grep for key terms from the criterion in target files
  return grepForKeyTerms(workdir, criterion, targetFiles);
}

function grepForIdentifier(
  workdir: string,
  identifier: string,
  targetFiles: string[],
  criterion: string,
): ValidationResult {
  const searchPaths = targetFiles.length > 0 ? targetFiles.map(f => resolve(workdir, f)) : [workdir];
  for (const searchPath of searchPaths) {
    const result = spawnSync("grep", ["-rn", identifier, searchPath], { timeout: 10_000 });
    if (result.status === 0 && result.stdout?.toString().trim()) {
      return { criterion, passed: true, output: result.stdout.toString().slice(0, 1000) };
    }
  }
  return { criterion, passed: false, output: `"${identifier}" not found in target files` };
}

function checkTypeHints(workdir: string, targetFiles: string[], criterion: string): ValidationResult {
  if (targetFiles.length === 0) {
    return { criterion, passed: true, output: "No target files to check" };
  }

  const issues: string[] = [];
  for (const f of targetFiles) {
    const fullPath = resolve(workdir, f);
    if (!existsSync(fullPath)) continue;
    // Find func declarations without -> return type (GDScript)
    const result = spawnSync("grep", ["-n", "^func ", fullPath], { timeout: 10_000 });
    const lines = result.stdout?.toString().split("\n").filter(Boolean) ?? [];
    for (const line of lines) {
      if (!line.includes("->")) {
        issues.push(line.trim());
      }
    }
  }

  if (issues.length > 0) {
    return {
      criterion,
      passed: false,
      output: `Functions missing return type hints:\n${issues.slice(0, 10).join("\n")}`,
    };
  }
  return { criterion, passed: true, output: "All functions have type hints" };
}

function grepForKeyTerms(workdir: string, criterion: string, targetFiles: string[]): ValidationResult {
  // Extract significant words (4+ chars, not common words)
  const stopWords = new Set(["with", "that", "this", "from", "have", "been", "should", "must", "does", "will", "file", "text", "code"]);
  const terms = criterion.match(/\b[a-zA-Z_]\w{3,}\b/g)?.filter(t => !stopWords.has(t.toLowerCase())) ?? [];

  if (terms.length === 0) {
    return { criterion, passed: true, output: "No checkable terms found — skipping" };
  }

  const searchPaths = targetFiles.length > 0 ? targetFiles.map(f => resolve(workdir, f)) : [workdir];
  const found: string[] = [];
  const missing: string[] = [];

  for (const term of terms.slice(0, 5)) {
    let termFound = false;
    for (const searchPath of searchPaths) {
      const result = spawnSync("grep", ["-rl", term, searchPath], { timeout: 10_000 });
      if (result.status === 0 && result.stdout?.toString().trim()) {
        termFound = true;
        break;
      }
    }
    if (termFound) found.push(term);
    else missing.push(term);
  }

  const passed = missing.length === 0 || found.length > missing.length;
  return {
    criterion,
    passed,
    output: `Found: [${found.join(", ")}]${missing.length ? `, Missing: [${missing.join(", ")}]` : ""}`,
  };
}
