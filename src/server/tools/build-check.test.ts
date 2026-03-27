import { runAndExtractErrors } from "./build-check";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "build-check-test-"));
});

afterEach(() => {
  try { rmSync(workdir, { recursive: true, force: true }); } catch {}
});

describe("runAndExtractErrors", () => {
  it('returns "success" for exit code 0', () => {
    const result = runAndExtractErrors("echo ok", workdir);
    expect(result).toBe("success");
  });

  it("extracts TypeScript-style errors", () => {
    writeFileSync(join(workdir, "errors.txt"),
      'src/file.ts(10,5): error TS2304: Cannot find name "foo".\nother noise\nsrc/bar.ts(3,1): error TS1005: expected ;');
    const result = runAndExtractErrors(`cat ${join(workdir, "errors.txt")} && exit 1`, workdir);
    expect(result).toContain("error TS2304");
    expect(result).toContain("error TS1005");
    expect(result).not.toContain("other noise");
  });

  it("extracts Jest failure lines", () => {
    writeFileSync(join(workdir, "errors.txt"),
      'PASS src/ok.test.ts\nFAIL src/bad.test.ts\n  ✕ should work (5ms)\n  Expected: 1\n  Received: 2\n\nTest Suites: 1 failed, 1 passed');
    const result = runAndExtractErrors(`cat ${join(workdir, "errors.txt")} && exit 1`, workdir);
    expect(result).toContain("FAIL");
    expect(result).toContain("Expected: 1");
    expect(result).toContain("Received: 2");
    expect(result).toContain("1 failed");
    expect(result).not.toContain("PASS");
  });

  it("falls back to last 30 lines when no patterns match", () => {
    const result = runAndExtractErrors("echo 'some weird output' && exit 1", workdir);
    expect(result).toMatch(/^Exit 1:/);
    expect(result).toContain("some weird output");
  });

  it("handles command that produces no output", () => {
    const result = runAndExtractErrors("exit 1", workdir);
    expect(result).toMatch(/^Exit 1/);
  });
});
