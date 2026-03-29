/**
 * Filesystem + shell tools for agent pipelines.
 *
 * Tool sets are created at call time, bound to a specific working directory.
 * Each issue/task gets its own working directory (e.g. a git worktree).
 *
 * Ported from mastra-react/src/agents/tools.ts
 * Adapted to use AI SDK tool() format.
 */

import { z } from "zod";
import { tool } from "ai";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  statSync,
  appendFileSync,
  unlinkSync,
  renameSync,
} from "fs";
import { spawnSync } from "child_process";
import { join, dirname, resolve, isAbsolute, sep, relative } from "path";
import { ContextBudget } from "./context-budget";

// ─── Full tool set (read + write + run) ───────────────────────────────────────

export function makeFilesystemTools(workdir: string, budget?: ContextBudget) {
  /** Normalize Windows \r\n to \n for consistent text handling across platforms */
  const normalizeEol = (text: string) => text.replace(/\r\n/g, "\n");

  /** Track recent tool calls for loop detection */
  const recentCalls: string[] = [];
  /** Reset read tracking for a file after it's been modified (used by replaceInFile/writeFile) */
  function resetFileReadCount(_path: string) {
    // No-op — read tracking removed, but callers still reference this
  }

  /** Return an error result */
  function trackResult(result: string): string {
    return result;
  }

  function trackSuccess(): void {
    // no-op — error tracking removed
  }

  /** Track a tool result — no truncation. */
  function cap(result: string): string {
    trackSuccess();
    return result;
  }

  /** Detect and break tool call loops */
  function loopGuard(
    toolName: string,
    args: Record<string, unknown>
  ): string | null {
    const sorted = Object.keys(args)
      .sort()
      .reduce(
        (o, k) => {
          o[k] = args[k] ?? null;
          return o;
        },
        {} as Record<string, unknown>
      );
    const key = `${toolName}:${JSON.stringify(sorted)}`;
    recentCalls.push(key);
    if (recentCalls.length > 30) recentCalls.shift();

    // Consecutive repeats
    let consecutive = 0;
    for (let i = recentCalls.length - 1; i >= 0; i--) {
      if (recentCalls[i] === key) consecutive++;
      else break;
    }
    if (consecutive >= 3) {
      return `ERROR: You have called ${toolName} with the same arguments ${consecutive} times in a row. Stop and try a completely different approach.`;
    }

    // Cycling detection — same call appearing too often even when interleaved with others
    const recent = recentCalls.slice(-15);
    const freq = recent.filter(c => c === key).length;
    if (freq >= 4) {
      return `ERROR: You have called ${toolName} with these arguments ${freq} times in the last ${recent.length} calls. You appear to be stuck in a loop. Stop and try a fundamentally different approach — do not repeat these same calls.`;
    }

    return null;
  }

  const resolvedWorkdir = resolve(workdir);

  /**
   * Normalise a user-supplied path to be safely relative to workdir.
   * Handles the common LLM mistake of passing the full absolute worktree path.
   */
  function cleanPath(
    raw: string
  ): { ok: true; cleaned: string } | { ok: false; error: string } {
    if (!raw || !raw.trim()) return { ok: true, cleaned: "." };
    let p = raw;
    if (isAbsolute(p)) {
      const resolved = resolve(p);
      if (resolved === resolvedWorkdir) return { ok: true, cleaned: "." };
      if (
        resolved.startsWith(resolvedWorkdir + sep) ||
        resolved.startsWith(resolvedWorkdir + "/")
      ) {
        p = resolved.slice(resolvedWorkdir.length + 1);
      } else {
        return {
          ok: false,
          error: `Absolute path "${raw}" is outside the working directory. Use relative paths like "src/index.ts".`,
        };
      }
    }
    p = p.replace(/^\.\//, "").replace(/^\.\\/, "");
    const full = resolve(join(resolvedWorkdir, p));
    if (!full.startsWith(resolvedWorkdir + sep) && full !== resolvedWorkdir) {
      return {
        ok: false,
        error: `Path "${raw}" escapes the working directory. Use relative paths like "src/index.ts".`,
      };
    }
    return { ok: true, cleaned: p };
  }

  // ─── Tool definitions ─────────────────────────────────────────────────────

  const readFile = tool({
    description:
      "Read a file relative to the working directory. For large files, use offset and limit to read specific line ranges.",
    parameters: z.object({
      path: z
        .string()
        .describe('File path relative to workdir (e.g. "src/index.ts")'),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Start reading from this line number (0-based)."),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Maximum number of lines to read."),
    }),
    execute: async ({ path, offset, limit }) => {
      const loopMsg = loopGuard("readFile", { path, offset, limit });
      if (loopMsg) return trackResult(loopMsg);
      try {
        const result = cleanPath(path);
        if (!result.ok) return trackResult(result.error);
        const fullPath = join(resolvedWorkdir, result.cleaned);
        const content = normalizeEol(readFileSync(fullPath, "utf-8"));
        const lines = content.split("\n");

        if (offset !== undefined || limit !== undefined) {
          const start = offset ?? 0;
          const end = limit ? start + limit : lines.length;
          const slice = lines.slice(start, end).join("\n");
          const header = `[lines ${start + 1}-${Math.min(end, lines.length)} of ${lines.length}]\n`;
          return cap(header + slice);
        }

        return cap(content);
      } catch (e) {
        const err = e as { code?: string };
        if (err.code === "ENOENT")
          return trackResult(`File not found: "${path}".`);
        if (err.code === "EISDIR")
          return trackResult(
            `"${path}" is a directory. Use listDirectory instead.`
          );
        return trackResult(`Error reading file: ${e}`);
      }
    },
  });

  const writeFile = tool({
    description: "Write content to a file (creates directories as needed).",
    parameters: z.object({
      path: z.string().describe("File path relative to workdir"),
      content: z.string().describe("File content"),
    }),
    execute: async ({ path, content }) => {
      try {
        const result = cleanPath(path);
        if (!result.ok) return trackResult(result.error);
        const fullPath = join(resolvedWorkdir, result.cleaned);
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, content, "utf-8");
        resetFileReadCount(result.cleaned);
        trackSuccess();
        console.log(`[writeFile] ${result.cleaned} (${content.length} bytes)`);
        return `Wrote ${content.length} bytes to ${result.cleaned}`;
      } catch (e) {
        return trackResult(`Error writing file: ${e}`);
      }
    },
  });

  const listDirectory = tool({
    description:
      'List files in a directory. Use "." for the project root. max_depth controls recursion (0 = flat, max 4).',
    parameters: z.object({
      path: z
        .string()
        .default(".")
        .describe('Directory path relative to workdir (e.g. "." or "src")'),
      max_depth: z
        .number()
        .int()
        .min(0)
        .max(4)
        .optional()
        .default(0)
        .describe("Recursion depth. 0 = flat, 1-4 = recursive tree."),
    }),
    execute: async ({ path, max_depth }) => {
      const loopMsg = loopGuard("listDirectory", { path, max_depth });
      if (loopMsg) return trackResult(loopMsg);
      try {
        const result = cleanPath(path || ".");
        if (!result.ok) return trackResult(result.error);
        const fullPath = join(resolvedWorkdir, result.cleaned);
        // Verify root path exists before scanning
        try {
          const stat = statSync(fullPath);
          if (!stat.isDirectory()) {
            return trackResult(`"${path}" is a file, not a directory. Use readFile to read it.`);
          }
        } catch (e) {
          const err = e as { code?: string };
          if (err.code === "ENOENT") return trackResult(`Directory not found: "${path}".`);
          return trackResult(`Error: ${e}`);
        }
        const lines: string[] = [];
        const visitedDirs = new Set<string>();
        function scan(dir: string, prefix: string, depth: number) {
          // Guard against symlink loops by tracking real paths
          let realDir: string;
          try {
            realDir = require("fs").realpathSync(dir);
          } catch {
            return; // Broken symlink — skip
          }
          if (visitedDirs.has(realDir)) return;
          visitedDirs.add(realDir);

          const entries = readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            if (e.name === "node_modules" || e.name === ".git") continue;
            lines.push(
              `${prefix}${e.isDirectory() ? "[dir]" : "[file]"} ${e.name}`
            );
            if (e.isDirectory() && depth < max_depth) {
              scan(join(dir, e.name), prefix + "  ", depth + 1);
            }
          }
        }
        scan(fullPath, "", 0);
        if (lines.length > 500)
          return cap(
            lines.slice(0, 500).join("\n") +
              `\n... (${lines.length - 500} more entries truncated)`
          );
        return cap(lines.join("\n") || "(empty directory)");
      } catch (e) {
        const err = e as { code?: string };
        if (err.code === "ENOENT")
          return trackResult(`Directory not found: "${path}".`);
        if (err.code === "ENOTDIR")
          return trackResult(
            `"${path}" is a file, not a directory. Use readFile to read it.`
          );
        return trackResult(`Error listing directory: ${e}`);
      }
    },
  });

  const runCommand = tool({
    description:
      "Run a shell command in the project working directory. Each invocation is an isolated shell — no persistent state between calls.",
    parameters: z.object({
      command: z
        .string()
        .describe(
          "Shell command to run. Already in the project directory — never use cd."
        ),
    }),
    execute: async ({ command }) => {
      console.log(`[runCommand] executing: ${command.slice(0, 100)}`);
      let command_to_run = command;
      while (/^\s*cd\s+/.test(command_to_run)) {
        const stripped = command_to_run
          .replace(/^\s*cd\s+"[^"]*"\s*(?:&&|;)\s*/, "")
          .replace(/^\s*cd\s+\S+\s*(?:&&|;)\s*/, "");
        if (stripped === command_to_run) {
          return "No need to cd — commands already run in the project working directory.";
        }
        command_to_run = stripped;
      }
      const loopMsg = loopGuard("runCommand", { command: command_to_run });
      if (loopMsg) return trackResult(loopMsg);
      const result = spawnSync(command_to_run, {
        cwd: resolvedWorkdir,
        encoding: "utf-8",
        timeout: 60_000,
        shell: true,
      });
      const out = [result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n")
        .trim();
      if (result.status !== 0) {
        const errOutput = `Exit ${result.status ?? 1}: ${out || result.error?.message || "unknown error"}`;
        return errOutput;
      }
      return cap(out || "(no output)");
    },
  });

  const searchFiles = tool({
    description:
      "Search for a pattern across files. Use context_lines to see surrounding code. Use files_only for a quick scan.",
    parameters: z.object({
      pattern: z.string().describe("Text or regex pattern to search for"),
      glob: z
        .string()
        .optional()
        .describe('File glob to restrict search, e.g. "*.ts" or "src/**/*.py"'),
      context_lines: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .default(0)
        .describe("Lines of context around each match."),
      files_only: z
        .boolean()
        .optional()
        .default(false)
        .describe("Return only file paths, not matching lines."),
      fixed_string: z
        .boolean()
        .optional()
        .default(false)
        .describe("Treat pattern as a fixed string, not a regex."),
      case_sensitive: z.boolean().optional().default(true),
    }),
    execute: async ({
      pattern,
      glob: globPattern,
      context_lines,
      files_only,
      fixed_string,
      case_sensitive,
    }) => {
      const loopMsg = loopGuard("searchFiles", {
        pattern,
        glob: globPattern,
        context_lines,
        files_only,
        fixed_string,
        case_sensitive,
      });
      if (loopMsg) return trackResult(loopMsg);

      // Try ripgrep first, fall back to grep, then pure-JS fallback.
      // All external commands use spawnSync with an args array (no shell)
      // to prevent command injection via pattern or glob values.
      const tryRg = () => {
        const args = [
          files_only ? "--files-with-matches" : "--line-number",
          ...(!case_sensitive ? ["--ignore-case"] : []),
          ...(fixed_string ? ["--fixed-strings"] : []),
          ...(context_lines ? [`--context=${context_lines}`] : []),
          ...(globPattern ? [`--glob=${globPattern}`] : []),
          "--",
          pattern,
          ".",
        ];
        const result = spawnSync("rg", args, {
          cwd: resolvedWorkdir,
          encoding: "utf-8",
          timeout: 30_000,
        });
        if (result.error) throw { status: null, stderr: '', message: result.error.message };
        if (result.status !== 0) {
          throw { status: result.status, stderr: result.stderr ?? '', message: '' };
        }
        return result.stdout;
      };

      const tryGrep = () => {
        const args = [
          "-r",
          files_only ? "-l" : "-n",
          ...(!case_sensitive ? ["-i"] : []),
          ...(fixed_string ? ["-F"] : []),
          ...(context_lines ? ["-C", String(context_lines)] : []),
          "--exclude-dir=.git",
          "--exclude-dir=node_modules",
          "--exclude-dir=dist",
          "--exclude-dir=build",
          "--exclude-dir=.next",
          ...(globPattern ? [`--include=${globPattern}`] : []),
          "--",
          pattern,
          ".",
        ];
        const result = spawnSync("grep", args, {
          cwd: resolvedWorkdir,
          encoding: "utf-8",
          timeout: 30_000,
        });
        if (result.error) throw { status: null, stderr: '', message: result.error.message };
        if (result.status !== 0 && result.status !== 1) {
          throw { status: result.status, stderr: result.stderr ?? '', message: '' };
        }
        return result.stdout;
      };

      // Pure-JS fallback when neither rg nor grep is available (e.g. Windows)
      const tryJsSearch = (): string => {
        const SKIP = new Set([
          ".git",
          "node_modules",
          "dist",
          "build",
          ".next",
        ]);
        const re = fixed_string
          ? new RegExp(
              pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
              case_sensitive ? "" : "i"
            )
          : new RegExp(pattern, case_sensitive ? "" : "i");
        const globRe = globPattern
          ? new RegExp(
              globPattern.startsWith("**/") || !globPattern.includes("/")
                ? globPattern
                    .replace(/\*\*\//g, "")
                    .replace(/\*/g, "[^/]*")
                    .replace(/\./g, "\\.") + "$"
                : "^(./)?" +
                    globPattern
                      .replace(/\*\*\//g, "(.+/)?")
                      .replace(/\*/g, "[^/]*")
                      .replace(/\./g, "\\.") +
                    "$"
            )
          : null;
        const results: string[] = [];
        const maxResults = files_only ? 500 : 200;

        function walk(dir: string) {
          if (results.length >= maxResults) return;
          let entries: { name: string; isDirectory(): boolean }[];
          try {
            entries = readdirSync(dir, { withFileTypes: true }) as unknown as { name: string; isDirectory(): boolean }[];
          } catch {
            return;
          }
          for (const e of entries) {
            if (results.length >= maxResults) return;
            if (SKIP.has(e.name)) continue;
            const full = join(dir, e.name);
            if (e.isDirectory()) {
              walk(full);
              continue;
            }
            const rel =
              "./" + relative(resolvedWorkdir, full).replace(/\\/g, "/");
            if (globRe && !globRe.test(rel) && !globRe.test(e.name)) continue;
            let content: string;
            try {
              content = normalizeEol(readFileSync(full, "utf-8"));
            } catch {
              continue;
            }
            if (content.includes("\0")) continue; // Skip binary files
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (re.test(lines[i])) {
                if (files_only) {
                  results.push(rel);
                  break;
                }
                if (context_lines && context_lines > 0) {
                  const start = Math.max(0, i - context_lines);
                  const end = Math.min(lines.length, i + context_lines + 1);
                  for (let j = start; j < end; j++) {
                    const s = j === i ? ":" : "-";
                    results.push(`${rel}${s}${j + 1}${s}${lines[j]}`);
                  }
                  results.push("--");
                } else {
                  results.push(`${rel}:${i + 1}:${lines[i]}`);
                }
              }
            }
          }
        }

        walk(resolvedWorkdir);
        return results.join("\n");
      };

      const isNotFound = (err: {
        status?: number;
        stderr?: string;
        message?: string;
      }) =>
        err.message?.includes("ENOENT") ||
        err.message?.includes("not recognized") ||
        err.message?.includes("not found") ||
        err.message?.includes("No such file") ||
        (err.stderr && /not (recognized|found)|no such file/i.test(err.stderr));

      try {
        let output: string;
        try {
          output = tryRg();
        } catch (rgErr: unknown) {
          const rgError = rgErr as {
            status?: number;
            stderr?: string;
            message?: string;
          };
          if (
            rgError.status === 1 &&
            !rgError.stderr?.trim() &&
            !isNotFound(rgError)
          )
            return "No matches found";
          try {
            output = tryGrep();
          } catch {
            output = tryJsSearch();
          }
        }

        if (!output.trim()) return "No matches found";
        const lines = output.trim().split("\n");
        const searchLimit = files_only ? 500 : 200;
        if (lines.length > searchLimit) {
          return cap(
            lines.slice(0, searchLimit).join("\n") +
              `\n... (${lines.length - searchLimit} more lines truncated)`
          );
        }
        return cap(output.trim());
      } catch (e) {
        return trackResult(`Search error: ${e}`);
      }
    },
  });

  const getFileInfo = tool({
    description:
      "Get metadata about a file: size, line count, and last modified time.",
    parameters: z.object({
      path: z.string().describe("File path relative to workdir"),
    }),
    execute: async ({ path }) => {
      try {
        const result = cleanPath(path);
        if (!result.ok) return trackResult(result.error);
        const fullPath = join(resolvedWorkdir, result.cleaned);
        const stat = statSync(fullPath);
        const content = normalizeEol(readFileSync(fullPath, "utf-8"));
        const lines = content.split("\n").length;
        return cap(`${result.cleaned}: ${stat.size} bytes, ${lines} lines, modified ${stat.mtime.toISOString()}`);
      } catch (e) {
        return trackResult(`Error: ${e}`);
      }
    },
  });

  const gitStatus = tool({
    description:
      "Show working-tree status (git status --short). Use to see which files were added, modified, or deleted.",
    parameters: z.object({}),
    execute: async () => {
      try {
        const result = spawnSync("git", ["status", "--short"], {
          cwd: resolvedWorkdir,
          encoding: "utf-8",
          timeout: 10_000,
        });
        const out = result.stdout ?? "";
        trackSuccess();
        return out.trim() || "Nothing to commit, working tree clean";
      } catch (e) {
        return trackResult(`git status error: ${e}`);
      }
    },
  });

  const gitDiff = tool({
    description:
      "Show git diff of working-tree or staged changes. Capped at 200 lines.",
    parameters: z.object({
      staged: z
        .boolean()
        .optional()
        .default(false)
        .describe("Show staged (--cached) diff instead of unstaged"),
      path: z
        .string()
        .optional()
        .describe("Limit diff to this path (relative to workdir)"),
    }),
    execute: async ({ staged, path: diffPath }) => {
      try {
        // Sanitize diffPath through cleanPath to prevent injection
        let safeDiffPath: string | undefined;
        if (diffPath) {
          const cleaned = cleanPath(diffPath);
          if (!cleaned.ok) return trackResult(cleaned.error);
          safeDiffPath = cleaned.cleaned;
        }
        const args = [
          "diff",
          ...(staged ? ["--cached"] : []),
          ...(safeDiffPath ? ["--", safeDiffPath] : []),
        ];
        const result = spawnSync("git", args, {
          cwd: resolvedWorkdir,
          encoding: "utf-8",
          timeout: 15_000,
        });
        const out = result.stdout ?? "";
        trackSuccess();
        if (!out.trim())
          return staged ? "No staged changes" : "No unstaged changes";
        const lines = out.split("\n");
        if (lines.length > 200)
          return (
            lines.slice(0, 200).join("\n") +
            `\n... (${lines.length - 200} more lines truncated)`
          );
        return out.trim();
      } catch (e) {
        return trackResult(`git diff error: ${e}`);
      }
    },
  });

  const appendToFile = tool({
    description:
      "Append text to the end of a file (creates the file if it does not exist).",
    parameters: z.object({
      path: z.string().describe("File path relative to workdir"),
      content: z.string().describe("Text to append"),
    }),
    execute: async ({ path, content }) => {
      try {
        const result = cleanPath(path);
        if (!result.ok) return trackResult(result.error);
        const fullPath = join(resolvedWorkdir, result.cleaned);
        mkdirSync(dirname(fullPath), { recursive: true });
        appendFileSync(fullPath, content, "utf-8");
        resetFileReadCount(result.cleaned);
        trackSuccess();
        return `Appended ${content.length} bytes to ${result.cleaned}`;
      } catch (e) {
        return trackResult(`Error appending to file: ${e}`);
      }
    },
  });

  const deleteFile = tool({
    description: "Delete a file. Can be restored via git if previously committed.",
    parameters: z.object({
      path: z.string().describe("File path relative to workdir"),
    }),
    execute: async ({ path }) => {
      try {
        const result = cleanPath(path);
        if (!result.ok) return trackResult(result.error);
        const fullPath = join(resolvedWorkdir, result.cleaned);
        unlinkSync(fullPath);
        resetFileReadCount(result.cleaned);
        trackSuccess();
        return `Deleted ${result.cleaned}`;
      } catch (e) {
        return trackResult(`Error deleting file: ${e}`);
      }
    },
  });

  const moveFile = tool({
    description: "Move or rename a file within the working directory.",
    parameters: z.object({
      from: z.string().describe("Source path relative to workdir"),
      to: z.string().describe("Destination path relative to workdir"),
    }),
    execute: async ({ from, to }) => {
      try {
        const fromResult = cleanPath(from);
        if (!fromResult.ok) return trackResult(fromResult.error);
        const toResult = cleanPath(to);
        if (!toResult.ok) return trackResult(toResult.error);
        const fromFull = join(resolvedWorkdir, fromResult.cleaned);
        const toFull = join(resolvedWorkdir, toResult.cleaned);
        mkdirSync(dirname(toFull), { recursive: true });
        renameSync(fromFull, toFull);
        resetFileReadCount(fromResult.cleaned);
        resetFileReadCount(toResult.cleaned);
        trackSuccess();
        return `Moved ${fromResult.cleaned} → ${toResult.cleaned}`;
      } catch (e) {
        return trackResult(`Error moving file: ${e}`);
      }
    },
  });

  const replaceInFile = tool({
    description:
      "Replace an exact string in a file. Prefer this over writeFile for targeted edits.",
    parameters: z.object({
      path: z.string().describe("File path relative to workdir"),
      old_str: z
        .string()
        .describe(
          "Exact string to replace — must appear exactly once in the file"
        ),
      new_str: z.string().describe("Replacement string"),
    }),
    execute: async ({ path, old_str, new_str }) => {
      try {
        const result = cleanPath(path);
        if (!result.ok) return trackResult(result.error);
        const fullPath = join(resolvedWorkdir, result.cleaned);
        const content = normalizeEol(readFileSync(fullPath, "utf-8"));
        let normalizedOldStr = normalizeEol(old_str);
        let normalizedNewStr = normalizeEol(new_str);

        // Fix double-escaped sequences — some models send \\n, \\t, \\" etc. in tool args
        const hasDoubleEscapes = (s: string) => /\\[nrt"'\\]/.test(s);
        if (hasDoubleEscapes(normalizedOldStr) && !hasDoubleEscapes(content)) {
          const unescape = (s: string) =>
            s.replace(/\\(["'\\/bfnrt])/g, (_, ch) => {
              const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "\\": "\\", "/": "/", '"': '"', "'": "'" };
              return map[ch as string] ?? ch;
            });
          normalizedOldStr = unescape(normalizedOldStr);
          normalizedNewStr = unescape(normalizedNewStr);
        }

        let count = content.split(normalizedOldStr).length - 1;

        // Retry with normalised indentation when exact match fails
        let searchStr = normalizedOldStr;
        if (count === 0) {
          const normalise = (s: string) =>
            s.replace(/^[ \t]+/gm, "").replace(/[ \t]+$/gm, "");
          const normContent = normalise(content);
          const normOld = normalise(normalizedOldStr);
          if (normContent.includes(normOld)) {
            const lines = content.split("\n");
            const normLines = lines.map((l: string) =>
              l.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "")
            );
            const oldLines = normalizedOldStr
              .split("\n")
              .map((l: string) =>
                l.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "")
              );
            const start = normLines.findIndex((_: string, i: number) =>
              oldLines.every(
                (ol: string, j: number) => normLines[i + j] === ol
              )
            );
            if (start !== -1) {
              searchStr = lines.slice(start, start + oldLines.length).join("\n");
              count = 1;
            }
          }
        }

        // Retry by stripping line number prefixes (e.g. "  42: ", "42| ", " 7→ ")
        // from old_str — the scout report includes these but the actual file doesn't
        if (count === 0) {
          const stripLineNumbers = (s: string) =>
            s.replace(/^\s*\d+[\s]*[:|→|│|\|]\s?/gm, "");
          const strippedOld = stripLineNumbers(normalizedOldStr);
          if (strippedOld !== normalizedOldStr) {
            // Try exact match with stripped version
            const strippedCount = content.split(strippedOld).length - 1;
            if (strippedCount === 1) {
              searchStr = strippedOld;
              count = 1;
            } else if (strippedCount === 0) {
              // Try indentation-normalized match with stripped version
              const normalise = (s: string) =>
                s.replace(/^[ \t]+/gm, "").replace(/[ \t]+$/gm, "");
              const normContent = normalise(content);
              const normStripped = normalise(strippedOld);
              if (normContent.includes(normStripped)) {
                const lines = content.split("\n");
                const normLines = lines.map((l: string) =>
                  l.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "")
                );
                const oldLines = strippedOld
                  .split("\n")
                  .map((l: string) =>
                    l.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "")
                  );
                const start = normLines.findIndex((_: string, i: number) =>
                  oldLines.every(
                    (ol: string, j: number) => normLines[i + j] === ol
                  )
                );
                if (start !== -1) {
                  searchStr = lines.slice(start, start + oldLines.length).join("\n");
                  count = 1;
                }
              }
            }
          }
        }

        if (count === 0) {
          console.log(`[replaceInFile] FAILED — string not found in ${path}`);
          return trackResult(`Error: string not found in ${path}`);
        }
        if (count > 1) {
          console.log(`[replaceInFile] FAILED — string appears ${count} times in ${path}`);
          return trackResult(
            `Error: string appears ${count} times in ${path} — make old_str more specific`
          );
        }
        writeFileSync(fullPath, content.replace(searchStr, normalizedNewStr), "utf-8");
        resetFileReadCount(path);
        trackSuccess();
        console.log(`[replaceInFile] ${path}`);
        return `Replaced 1 occurrence in ${path}`;
      } catch (e) {
        return trackResult(`Error: ${e}`);
      }
    },
  });

  return {
    readFile,
    writeFile,
    listDirectory,
    runCommand,
    searchFiles,
    getFileInfo,
    gitStatus,
    gitDiff,
    appendToFile,
    deleteFile,
    moveFile,
    replaceInFile,
  };
}

// ─── Restricted tool sets ──────────────────────────────────────────────────────

/** Read-only: for scout/analysis — no writes, no arbitrary shell execution */
export function makeReadOnlyTools(workdir: string, budget?: ContextBudget) {
  const { readFile, listDirectory, searchFiles, getFileInfo } =
    makeFilesystemTools(workdir, budget);
  return { readFile, listDirectory, searchFiles, getFileInfo };
}

/** Test-write tools: read + search + write + run, no git — prevents wasting steps on git commands */
export function makeTestWriteTools(workdir: string, budget?: ContextBudget) {
  const {
    readFile,
    listDirectory,
    searchFiles,
    writeFile: wf,
    appendToFile: af,
    replaceInFile,
    runCommand,
    gitStatus,
    gitDiff,
    getFileInfo,
  } = makeFilesystemTools(workdir, budget);
  return {
    readFile,
    listDirectory,
    searchFiles,
    writeFile: wf,
    appendToFile: af,
    replaceInFile,
    runCommand,
    gitStatus,
    gitDiff,
    getFileInfo,
  };
}

/** Verify tools: read + search + shell + git status/diff, no writes — verify agents must not modify code */
export function makeVerifyTools(workdir: string, budget?: ContextBudget) {
  const { readFile, listDirectory, searchFiles, runCommand, gitStatus, gitDiff, getFileInfo } =
    makeFilesystemTools(workdir, budget);
  return { readFile, listDirectory, searchFiles, runCommand, gitStatus, gitDiff, getFileInfo };
}
