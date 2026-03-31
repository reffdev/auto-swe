import { validateAcceptanceCriteria } from "./validator";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "validator-test-"));
});

afterEach(() => {
  try { rmSync(workdir, { recursive: true, force: true }); } catch {}
});

describe("validateAcceptanceCriteria", () => {
  describe("file existence checks", () => {
    it("passes when file exists", async () => {
      writeFileSync(join(workdir, "hello.txt"), "content");
      const result = await validateAcceptanceCriteria(workdir, ["File hello.txt exists"], []);
      expect(result.allPassed).toBe(true);
      expect(result.results[0].passed).toBe(true);
    });

    it("fails when file does not exist", async () => {
      const result = await validateAcceptanceCriteria(workdir, ["File missing.txt exists"], []);
      expect(result.allPassed).toBe(false);
      expect(result.results[0].passed).toBe(false);
      expect(result.results[0].output).toContain("NOT found");
    });

    it("handles nested file paths", async () => {
      mkdirSync(join(workdir, "engine", "autoloads"), { recursive: true });
      writeFileSync(join(workdir, "engine", "autoloads", "manager.gd"), "extends Node");
      const result = await validateAcceptanceCriteria(
        workdir,
        ["File engine/autoloads/manager.gd exists"],
        [],
      );
      expect(result.allPassed).toBe(true);
    });
  });

  describe("shell command checks", () => {
    it("passes on exit code 0", async () => {
      const result = await validateAcceptanceCriteria(workdir, ["$ echo ok"], []);
      expect(result.allPassed).toBe(true);
      expect(result.results[0].output).toContain("ok");
    });

    it("fails on non-zero exit code", async () => {
      const result = await validateAcceptanceCriteria(workdir, ["$ exit 1"], []);
      expect(result.allPassed).toBe(false);
    });

    it("rejects dangerous commands", async () => {
      const result = await validateAcceptanceCriteria(workdir, ["$ rm -rf /"], []);
      expect(result.allPassed).toBe(false);
      expect(result.results[0].output).toContain("rejected");
    });
  });

  describe("grep-based checks", () => {
    it("finds function names in target files", async () => {
      writeFileSync(join(workdir, "test.gd"), "func register_currency(def: CurrencyDef) -> void:\n\tpass");
      const result = await validateAcceptanceCriteria(
        workdir,
        ["function register_currency exists"],
        ["test.gd"],
      );
      expect(result.allPassed).toBe(true);
    });

    it("finds signal names", async () => {
      writeFileSync(join(workdir, "test.gd"), "signal currency_changed(id: StringName, amount: float)");
      const result = await validateAcceptanceCriteria(
        workdir,
        ["signal currency_changed is defined"],
        ["test.gd"],
      );
      expect(result.allPassed).toBe(true);
    });

    it("fails when function not found", async () => {
      writeFileSync(join(workdir, "test.gd"), "func other_func():\n\tpass");
      const result = await validateAcceptanceCriteria(
        workdir,
        ["function missing_func exists"],
        ["test.gd"],
      );
      expect(result.allPassed).toBe(false);
    });
  });

  describe("type hint checks", () => {
    it("passes when all functions have type hints", async () => {
      writeFileSync(join(workdir, "test.gd"), "func add(a: float, b: float) -> float:\n\treturn a + b\n");
      const result = await validateAcceptanceCriteria(
        workdir,
        ["All functions have type hints"],
        ["test.gd"],
      );
      expect(result.allPassed).toBe(true);
    });

    it("fails when functions lack return type hints", async () => {
      writeFileSync(join(workdir, "test.gd"), "func add(a: float, b: float):\n\treturn a + b\n");
      const result = await validateAcceptanceCriteria(
        workdir,
        ["All functions have type hints"],
        ["test.gd"],
      );
      expect(result.allPassed).toBe(false);
      expect(result.results[0].output).toContain("missing return type");
    });
  });

  describe("multiple criteria", () => {
    it("all must pass for allPassed = true", async () => {
      writeFileSync(join(workdir, "hello.txt"), "content");
      const result = await validateAcceptanceCriteria(
        workdir,
        ["File hello.txt exists", "File missing.txt exists"],
        [],
      );
      expect(result.allPassed).toBe(false);
      expect(result.results[0].passed).toBe(true);
      expect(result.results[1].passed).toBe(false);
    });

    it("handles empty criteria array", async () => {
      const result = await validateAcceptanceCriteria(workdir, [], []);
      expect(result.allPassed).toBe(true);
      expect(result.results).toHaveLength(0);
    });
  });

  describe("default grep fallback", () => {
    it("searches for key terms in target files", async () => {
      writeFileSync(join(workdir, "test.gd"), "class_name CurrencyDef extends Resource");
      const result = await validateAcceptanceCriteria(
        workdir,
        ["CurrencyDef exists as a Resource class"],
        ["test.gd"],
      );
      expect(result.allPassed).toBe(true);
    });
  });
});
