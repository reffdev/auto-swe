import { resolveScoutManifest } from "./nodes";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "manifest-test-"));
  mkdirSync(join(workdir, "src/server"), { recursive: true });
  writeFileSync(join(workdir, "src/server/db.ts"), "line1\nline2\nline3\nline4\nline5\n");
  writeFileSync(join(workdir, "src/server/api.ts"), "a\nb\nc\n");
  writeFileSync(join(workdir, "package.json"), '{"name":"test"}\n');
});

afterEach(() => {
  try { rmSync(workdir, { recursive: true, force: true }); } catch {}
});

// ─── resolveScoutManifest ──────────────────────────────────────────────────

describe("resolveScoutManifest", () => {
  it("resolves a valid manifest to file list with line counts", async () => {
    const manifest = JSON.stringify({
      files: [
        { path: "src/server/db.ts", reason: "needs new method" },
        { path: "src/server/api.ts", reason: "endpoint pattern" },
      ],
      notes: "",
    });
    const result = await resolveScoutManifest(workdir, manifest);
    expect(result).toContain("src/server/db.ts");
    expect(result).toContain("6 lines"); // 5 lines + trailing newline = 6
    expect(result).toContain("needs new method");
    expect(result).toContain("src/server/api.ts");
    expect(result).toContain("4 lines");
    expect(result).toContain("endpoint pattern");
  });

  it("includes notes when present", async () => {
    const manifest = JSON.stringify({
      files: [{ path: "package.json", reason: "deps" }],
      notes: "Watch out for the circular import",
    });
    const result = await resolveScoutManifest(workdir, manifest);
    expect(result).toContain("## Notes");
    expect(result).toContain("circular import");
  });

  it("omits notes section when empty", async () => {
    const manifest = JSON.stringify({
      files: [{ path: "package.json", reason: "deps" }],
      notes: "",
    });
    const result = await resolveScoutManifest(workdir, manifest);
    expect(result).not.toContain("## Notes");
  });

  it("shows 'not found' for missing files", async () => {
    const manifest = JSON.stringify({
      files: [{ path: "nonexistent.ts", reason: "should exist" }],
      notes: "",
    });
    const result = await resolveScoutManifest(workdir, manifest);
    expect(result).toContain("nonexistent.ts");
    expect(result).toContain("not found");
  });

  it("falls back to raw string for non-JSON input", async () => {
    const raw = "This is a legacy text checkpoint with code blocks";
    const result = await resolveScoutManifest(workdir, raw);
    expect(result).toBe(raw);
  });

  it("falls back to raw string for JSON without files array", async () => {
    const json = JSON.stringify({ notes: "just notes, no files" });
    const result = await resolveScoutManifest(workdir, json);
    expect(result).toBe(json);
  });

  it("blocks path traversal attempts", async () => {
    const manifest = JSON.stringify({
      files: [
        { path: "../../etc/passwd", reason: "malicious" },
        { path: "src/server/db.ts", reason: "legit" },
      ],
      notes: "",
    });
    const result = await resolveScoutManifest(workdir, manifest);
    // Should NOT contain the traversal path
    expect(result).not.toContain("etc/passwd");
    // Should still contain the legit file
    expect(result).toContain("src/server/db.ts");
  });

  it("handles empty files array", async () => {
    const manifest = JSON.stringify({ files: [], notes: "" });
    const result = await resolveScoutManifest(workdir, manifest);
    expect(result).toContain("Relevant Files");
    // No file entries, just the header
    expect(result).not.toContain("lines)");
  });

  it("handles manifest with only invalid files", async () => {
    const manifest = JSON.stringify({
      files: [
        { path: "nope.ts", reason: "missing" },
        { path: "also-nope.ts", reason: "also missing" },
      ],
      notes: "",
    });
    const result = await resolveScoutManifest(workdir, manifest);
    expect(result).toContain("not found");
    expect(result).toContain("nope.ts");
  });
});
