/**
 * Static analysis pre-scan — runs deterministic tools to produce compact
 * metadata about the codebase. Used by the analysis scout to plan work groups.
 *
 * Tools: madge (dependency graph), ts-morph (code metrics), git log (churn)
 */

import { spawnSync } from "child_process";
import { getChurnLog } from "./git-helpers";
import { resolve, relative } from "path";
import { readdirSync, readFileSync } from "fs";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DepGraph {
  files: Record<string, string[]>;
  circular: string[][];
}

export interface FunctionMetric {
  name: string;
  lines: number;
  params: number;
}

export interface FileMetrics {
  path: string;
  lines: number;
  functions: FunctionMetric[];
  exports: string[];
}

export interface GitChurnEntry {
  path: string;
  changeCount: number;
  lastChanged: string;
}

export interface DeadExport {
  file: string;
  symbol: string;
}

export interface StaticScanResult {
  depGraph: DepGraph;
  metrics: FileMetrics[];
  churn: GitChurnEntry[];
  deadExports: DeadExport[];
  summary: {
    totalFiles: number;
    totalFunctions: number;
    avgFunctionLines: number;
    circularDeps: number;
    deadExportCount: number;
    highChurnFiles: number;
  };
}

// ─── Dependency Graph (madge) ───────────────────────────────────────────────

function scanDependencyGraph(workdir: string): DepGraph {
  try {
    const result = spawnSync("npx", ["madge", "--json", "--ts-config", "tsconfig.json", "src"], {
      cwd: workdir,
      encoding: "utf-8",
      timeout: 30_000,
      shell: true,
    });
    const files = result.stdout ? JSON.parse(result.stdout) as Record<string, string[]> : {};

    // Also get circular deps
    const circResult = spawnSync("npx", ["madge", "--circular", "--json", "--ts-config", "tsconfig.json", "src"], {
      cwd: workdir,
      encoding: "utf-8",
      timeout: 30_000,
      shell: true,
    });
    const circular = circResult.stdout ? JSON.parse(circResult.stdout) as string[][] : [];

    return { files, circular };
  } catch (err) {
    console.error("Static scan: madge failed:", err);
    return { files: {}, circular: [] };
  }
}

// ─── Code Metrics (lightweight — no ts-morph, just file scanning) ───────────

function scanCodeMetrics(workdir: string): FileMetrics[] {
  const metrics: FileMetrics[] = [];
  // Start from src/ if it exists, otherwise the workdir itself
  const srcDir = resolve(workdir, "src");
  const startDir = readdirSync(workdir).includes("src") ? srcDir : workdir;

  function walk(dir: string) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const fullPath = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
          if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue;
          try {
            const content = readFileSync(fullPath, "utf-8");
            const relPath = relative(workdir, fullPath).replace(/\\/g, "/");
            const lines = content.split("\n").length;

            // Extract function names and approximate line counts
            const functions: FunctionMetric[] = [];
            const fnRegex = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g;
            let match;
            while ((match = fnRegex.exec(content)) !== null) {
              const params = match[2].split(",").filter(p => p.trim()).length;
              // Rough line count: find the next function or end of file
              const startLine = content.slice(0, match.index).split("\n").length;
              functions.push({ name: match[1], lines: 0, params }); // lines filled below
            }

            // Also catch arrow functions assigned to const
            const arrowRegex = /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*\w[^=]*)?=>/g;
            while ((match = arrowRegex.exec(content)) !== null) {
              functions.push({ name: match[1], lines: 0, params: 0 });
            }

            // Extract exports
            const exports: string[] = [];
            const exportRegex = /export\s+(?:async\s+)?(?:function|const|class|interface|type|enum)\s+(\w+)/g;
            while ((match = exportRegex.exec(content)) !== null) {
              exports.push(match[1]);
            }

            metrics.push({ path: relPath, lines, functions, exports });
          } catch { /* skip unreadable files */ }
        }
      }
    } catch { /* skip unreadable dirs */ }
  }

  walk(startDir);
  return metrics;
}

// ─── Git Churn ──────────────────────────────────────────────────────────────

function scanGitChurn(workdir: string): GitChurnEntry[] {
  try {
    const output = getChurnLog(workdir, 90);
    if (!output) return [];
    const result = { stdout: output };

    const churnMap = new Map<string, { count: number; lastDate: string }>();
    let currentDate = "";

    for (const line of result.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Date lines from --format=%aI
      if (trimmed.match(/^\d{4}-\d{2}-\d{2}T/)) {
        currentDate = trimmed;
        continue;
      }

      // Numstat lines: <added>\t<removed>\t<file>
      const parts = trimmed.split("\t");
      if (parts.length >= 3 && parts[2]) {
        const file = parts[2];
        const existing = churnMap.get(file);
        if (existing) {
          existing.count++;
          if (currentDate > existing.lastDate) existing.lastDate = currentDate;
        } else {
          churnMap.set(file, { count: 1, lastDate: currentDate });
        }
      }
    }

    return [...churnMap.entries()]
      .map(([path, { count, lastDate }]) => ({ path, changeCount: count, lastChanged: lastDate }))
      .sort((a, b) => b.changeCount - a.changeCount);
  } catch {
    return [];
  }
}

// ─── Dead Exports ───────────────────────────────────────────────────────────

function findDeadExports(metrics: FileMetrics[], depGraph: DepGraph): DeadExport[] {
  // Build a set of all imported symbols (rough — based on file imports, not symbol-level)
  // This is approximate: if a file is imported, we assume all its exports are used
  const importedFiles = new Set<string>();
  for (const deps of Object.values(depGraph.files)) {
    for (const dep of deps) {
      importedFiles.add(dep);
    }
  }

  const dead: DeadExport[] = [];
  for (const file of metrics) {
    // Normalize path to match madge output (relative from src, no extension)
    const madgePath = file.path.replace(/^src\//, "").replace(/\.tsx?$/, "");
    if (!importedFiles.has(madgePath) && !file.path.includes("index.ts")) {
      // Entire file is not imported — all exports are dead
      for (const symbol of file.exports) {
        dead.push({ file: file.path, symbol });
      }
    }
  }

  return dead;
}

// ─── Main Export ────────────────────────────────────────────────────────────

export async function runStaticScan(workdir: string): Promise<StaticScanResult> {
  console.log("Analysis: running static pre-scan...");
  const start = Date.now();

  const depGraph = scanDependencyGraph(workdir);
  const metrics = scanCodeMetrics(workdir);
  const churn = scanGitChurn(workdir);
  const deadExports = findDeadExports(metrics, depGraph);

  const totalFunctions = metrics.reduce((sum, f) => sum + f.functions.length, 0);
  const totalFunctionLines = metrics.reduce((sum, f) => sum + f.functions.reduce((s, fn) => s + fn.lines, 0), 0);

  const result: StaticScanResult = {
    depGraph,
    metrics,
    churn,
    deadExports,
    summary: {
      totalFiles: metrics.length,
      totalFunctions,
      avgFunctionLines: totalFunctions > 0 ? Math.round(totalFunctionLines / totalFunctions) : 0,
      circularDeps: depGraph.circular.length,
      deadExportCount: deadExports.length,
      highChurnFiles: churn.filter(c => c.changeCount >= 5).length,
    },
  };

  const elapsed = Date.now() - start;
  const sizeKb = Math.round(JSON.stringify(result).length / 1024);
  console.log(`Analysis: static scan complete in ${elapsed}ms (${sizeKb}KB, ${result.summary.totalFiles} files, ${result.summary.totalFunctions} functions)`);

  return result;
}
