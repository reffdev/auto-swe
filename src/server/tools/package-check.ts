/**
 * Quick package version lookup — avoids hallucinated imports.
 */

import { z } from "zod";
import { tool } from "ai";
import { spawnSync } from "child_process";

export function makePackageCheckTool(workdir: string) {
  return {
    checkPackage: tool({
      description: 'Check if a package is installed and what version. Returns the version string or "not installed".',
      parameters: z.object({
        name: z.string().describe("Package name, e.g. 'drizzle-orm', 'express', 'zod'"),
      }),
      execute: async ({ name }) => {
        const result = spawnSync("npm", ["ls", name, "--depth=0", "--json"], {
          cwd: workdir,
          encoding: "utf-8",
          timeout: 15_000,
          shell: true,
        });

        try {
          const parsed = JSON.parse(result.stdout || "{}");
          const version = parsed.dependencies?.[name]?.version;
          if (version) return `${name}@${version}`;
        } catch { /* parse failed */ }

        // Fallback: check node_modules directly
        try {
          const pkgResult = spawnSync("node", ["-e", `console.log(require('${name}/package.json').version)`], {
            cwd: workdir,
            encoding: "utf-8",
            timeout: 5_000,
            shell: true,
          });
          const ver = pkgResult.stdout?.trim();
          if (ver && pkgResult.status === 0) return `${name}@${ver}`;
        } catch { /* not found */ }

        return "not installed";
      },
    }),
  };
}
