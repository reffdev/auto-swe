/**
 * Quick package version lookup — avoids hallucinated imports.
 */

import { z } from "zod";
import { tool } from "ai";
import { runProcess } from "../util/async-process";
import type { SandboxProfile } from "../util/sandbox";

export function makePackageCheckTool(workdir: string, sandbox?: SandboxProfile) {
  return {
    checkPackage: tool({
      description: 'Check if a package is installed and what version. Returns the version string or "not installed".',
      parameters: z.object({
        name: z.string().describe("Package name, e.g. 'drizzle-orm', 'express', 'zod'"),
      }),
      execute: async ({ name }) => {
        const result = await runProcess("npm", ["ls", name, "--depth=0", "--json"], {
          cwd: workdir, timeoutMs: 15_000, shell: true, sandbox,
        });

        try {
          const parsed = JSON.parse(result.stdout || "{}");
          const version = parsed.dependencies?.[name]?.version;
          if (version) return `${name}@${version}`;
        } catch { /* parse failed */ }

        // Fallback: check node_modules directly
        try {
          const pkgResult = await runProcess("node", ["-e", `console.log(require('${name}/package.json').version)`], {
            cwd: workdir, timeoutMs: 5_000, shell: true, sandbox,
          });
          const ver = pkgResult.stdout?.trim();
          if (ver && pkgResult.status === 0) return `${name}@${ver}`;
        } catch { /* not found */ }

        return "not installed";
      },
    }),
  };
}
