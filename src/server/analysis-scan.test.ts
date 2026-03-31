import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { runStaticScan } from "./analysis-scan";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "scan-test-"));
  mkdirSync(join(workdir, "src"), { recursive: true });

  // Create a minimal TS project
  writeFileSync(join(workdir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2020", module: "commonjs", strict: true },
    include: ["src"],
  }));

  writeFileSync(join(workdir, "src", "main.ts"), `
export function hello(name: string): string {
  return "Hello " + name;
}

export function add(a: number, b: number): number {
  return a + b;
}

const unused = 42;
`);

  writeFileSync(join(workdir, "src", "utils.ts"), `
import { hello } from "./main";

export function greet(): string {
  return hello("world");
}

export const PI = 3.14;
`);

  // Init git repo for churn analysis
  execSync("git init", { cwd: workdir, stdio: "ignore" });
  execSync("git config user.email test@test.com", { cwd: workdir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: workdir, stdio: "ignore" });
  execSync("git add -A && git commit -m init", { cwd: workdir, stdio: "ignore" });
});

describe("runStaticScan", () => {
  it("returns a valid StaticScanResult", async () => {
    const result = await runStaticScan(workdir);

    expect(result.summary).toBeDefined();
    expect(result.summary.totalFiles).toBeGreaterThanOrEqual(2);
    expect(result.metrics).toBeInstanceOf(Array);
    expect(result.churn).toBeInstanceOf(Array);
    expect(result.depGraph).toBeDefined();
    expect(result.depGraph.files).toBeDefined();
  });

  it("detects functions in source files", async () => {
    const result = await runStaticScan(workdir);
    const mainMetrics = result.metrics.find(m => m.path.includes("main.ts"));
    expect(mainMetrics).toBeDefined();
    expect(mainMetrics!.functions.length).toBeGreaterThanOrEqual(2);
    expect(mainMetrics!.functions.some(f => f.name === "hello")).toBe(true);
    expect(mainMetrics!.functions.some(f => f.name === "add")).toBe(true);
  });

  it("detects exports", async () => {
    const result = await runStaticScan(workdir);
    const mainMetrics = result.metrics.find(m => m.path.includes("main.ts"));
    expect(mainMetrics).toBeDefined();
    expect(mainMetrics!.exports).toContain("hello");
    expect(mainMetrics!.exports).toContain("add");
  });

  it("skips test files", async () => {
    writeFileSync(join(workdir, "src", "main.test.ts"), `test("x", () => {});`);
    const result = await runStaticScan(workdir);
    expect(result.metrics.some(m => m.path.includes("main.test.ts"))).toBe(false);
  });

  it("produces compact output", async () => {
    const result = await runStaticScan(workdir);
    const size = JSON.stringify(result).length;
    expect(size).toBeLessThan(100_000); // should be well under 100KB for a tiny project
  });

  it("returns churn data (may be empty for brand-new repos)", async () => {
    const result = await runStaticScan(workdir);
    // churn is an array — may be empty if git log format doesn't match, but should not error
    expect(result.churn).toBeInstanceOf(Array);
  });
});
