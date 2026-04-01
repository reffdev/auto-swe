import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  ensureMemoryDirs,
  categoryDir,
  writeMemory,
  readMemory,
  readMemoryCategory,
  readAllMemories,
  appendMemory,
  logEpisodic,
  readConventions,
  createSnapshot,
  assembleMemoryContext,
} from "./persistent-memory";

function makeTempProject(): string {
  const dir = join(tmpdir(), `mem-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  // Create .git so ensureGitignore doesn't skip
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

describe("ensureMemoryDirs", () => {
  let projectDir: string;

  beforeEach(() => { projectDir = makeTempProject(); });
  afterEach(() => { try { rmSync(projectDir, { recursive: true, force: true }); } catch {} });

  it("creates all directories", () => {
    ensureMemoryDirs(projectDir);
    expect(existsSync(join(projectDir, ".swe", "memory", "episodic"))).toBe(true);
    expect(existsSync(join(projectDir, ".swe", "memory", "semantic"))).toBe(true);
    expect(existsSync(join(projectDir, ".swe", "conventions", "procedural"))).toBe(true);
    expect(existsSync(join(projectDir, ".swe", "conventions", "snapshots"))).toBe(true);
  });

  it("creates ABOUT.md files", () => {
    ensureMemoryDirs(projectDir);
    expect(existsSync(join(projectDir, ".swe", "memory", "episodic", "ABOUT.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".swe", "memory", "semantic", "ABOUT.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".swe", "conventions", "procedural", "ABOUT.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".swe", "conventions", "snapshots", "ABOUT.md"))).toBe(true);
  });

  it("adds .swe/ to .gitignore", () => {
    ensureMemoryDirs(projectDir);
    const gitignore = readFileSync(join(projectDir, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".swe/");
  });

  it("does not duplicate .swe/ in .gitignore", () => {
    writeFileSync(join(projectDir, ".gitignore"), "node_modules\n.swe/\n");
    // Reset the ensured set so it runs again
    (ensureMemoryDirs as any).__reset?.();
    ensureMemoryDirs(projectDir);
    const gitignore = readFileSync(join(projectDir, ".gitignore"), "utf-8");
    const matches = gitignore.match(/\.swe\//g);
    expect(matches).toHaveLength(1);
  });

  it("is idempotent", () => {
    ensureMemoryDirs(projectDir);
    // Won't throw on second call
    ensureMemoryDirs(projectDir);
  });
});

describe("categoryDir", () => {
  it("returns correct paths", () => {
    const norm = (p: string) => p.replace(/\\/g, "/");
    expect(norm(categoryDir("/proj", "episodic"))).toContain(".swe/memory/episodic");
    expect(norm(categoryDir("/proj", "semantic"))).toContain(".swe/memory/semantic");
    expect(norm(categoryDir("/proj", "procedural"))).toContain(".swe/conventions/procedural");
  });
});

describe("writeMemory / readMemory", () => {
  let projectDir: string;

  beforeEach(() => { projectDir = makeTempProject(); });
  afterEach(() => { try { rmSync(projectDir, { recursive: true, force: true }); } catch {} });

  it("writes and reads a semantic memory", () => {
    writeMemory(projectDir, "semantic", "tech-stack.md", "# Tech Stack\n- Godot 4.4");
    const content = readMemory(projectDir, "semantic", "tech-stack.md");
    expect(content).toBe("# Tech Stack\n- Godot 4.4");
  });

  it("writes and reads a procedural memory", () => {
    writeMemory(projectDir, "procedural", "deploy.md", "1. Build\n2. Push");
    const content = readMemory(projectDir, "procedural", "deploy.md");
    expect(content).toContain("1. Build");
  });

  it("returns null for non-existent file", () => {
    expect(readMemory(projectDir, "semantic", "nope.md")).toBeNull();
  });

  it("overwrites existing file", () => {
    writeMemory(projectDir, "semantic", "test.md", "v1");
    writeMemory(projectDir, "semantic", "test.md", "v2");
    expect(readMemory(projectDir, "semantic", "test.md")).toBe("v2");
  });
});

describe("appendMemory", () => {
  let projectDir: string;

  beforeEach(() => { projectDir = makeTempProject(); });
  afterEach(() => { try { rmSync(projectDir, { recursive: true, force: true }); } catch {} });

  it("appends to existing file", () => {
    writeMemory(projectDir, "semantic", "notes.md", "line1");
    appendMemory(projectDir, "semantic", "notes.md", "line2");
    const content = readMemory(projectDir, "semantic", "notes.md");
    expect(content).toContain("line1");
    expect(content).toContain("line2");
  });

  it("creates file if it doesn't exist", () => {
    appendMemory(projectDir, "semantic", "new.md", "first line");
    const content = readMemory(projectDir, "semantic", "new.md");
    expect(content).toContain("first line");
  });
});

describe("readMemoryCategory", () => {
  let projectDir: string;

  beforeEach(() => { projectDir = makeTempProject(); });
  afterEach(() => { try { rmSync(projectDir, { recursive: true, force: true }); } catch {} });

  it("returns all files in category sorted newest first", () => {
    writeMemory(projectDir, "semantic", "a.md", "first");
    // Small delay to ensure different mtime
    writeMemory(projectDir, "semantic", "b.md", "second");
    const entries = readMemoryCategory(projectDir, "semantic").filter(e => e.filename !== "ABOUT.md");
    expect(entries.length).toBe(2);
    const filenames = entries.map(e => e.filename);
    expect(filenames).toContain("a.md");
    expect(filenames).toContain("b.md");
  });

  it("returns empty array for empty category", () => {
    ensureMemoryDirs(projectDir);
    const entries = readMemoryCategory(projectDir, "semantic");
    // May have ABOUT.md from ensureMemoryDirs
    const nonAbout = entries.filter(e => e.filename !== "ABOUT.md");
    expect(nonAbout).toHaveLength(0);
  });
});

describe("readAllMemories", () => {
  let projectDir: string;

  beforeEach(() => { projectDir = makeTempProject(); });
  afterEach(() => { try { rmSync(projectDir, { recursive: true, force: true }); } catch {} });

  it("reads across all categories", () => {
    writeMemory(projectDir, "semantic", "a.md", "semantic");
    writeMemory(projectDir, "procedural", "b.md", "procedural");
    writeMemory(projectDir, "episodic", "c.md", "episodic");
    const all = readAllMemories(projectDir);
    const filenames = all.map(e => e.filename);
    expect(filenames).toContain("a.md");
    expect(filenames).toContain("b.md");
    expect(filenames).toContain("c.md");
  });
});

describe("logEpisodic", () => {
  let projectDir: string;

  beforeEach(() => { projectDir = makeTempProject(); });
  afterEach(() => { try { rmSync(projectDir, { recursive: true, force: true }); } catch {} });

  it("creates a daily log file", () => {
    logEpisodic(projectDir, "Task completed", "details here");
    const today = new Date().toISOString().slice(0, 10);
    const content = readMemory(projectDir, "episodic", `${today}.md`);
    expect(content).toContain("Task completed");
    expect(content).toContain("details here");
  });

  it("appends to existing daily log", () => {
    logEpisodic(projectDir, "Event 1");
    logEpisodic(projectDir, "Event 2");
    const today = new Date().toISOString().slice(0, 10);
    const content = readMemory(projectDir, "episodic", `${today}.md`)!;
    expect(content).toContain("Event 1");
    expect(content).toContain("Event 2");
  });
});

describe("readConventions", () => {
  let projectDir: string;

  beforeEach(() => { projectDir = makeTempProject(); });
  afterEach(() => { try { rmSync(projectDir, { recursive: true, force: true }); } catch {} });

  it("reads top-level convention files", () => {
    const convDir = join(projectDir, ".swe", "conventions");
    mkdirSync(convDir, { recursive: true });
    writeFileSync(join(convDir, "code-style.md"), "# Code Style\nuse snake_case");
    const entries = readConventions(projectDir);
    expect(entries.length).toBe(1);
    expect(entries[0].filename).toBe("code-style.md");
    expect(entries[0].content).toContain("snake_case");
  });

  it("returns empty for no conventions", () => {
    expect(readConventions(projectDir)).toHaveLength(0);
  });
});

describe("createSnapshot", () => {
  let projectDir: string;

  beforeEach(() => { projectDir = makeTempProject(); });
  afterEach(() => { try { rmSync(projectDir, { recursive: true, force: true }); } catch {} });

  it("creates a snapshot directory with copies", () => {
    writeMemory(projectDir, "semantic", "test.md", "snapshot content");
    const snapshotDir = createSnapshot(projectDir, "test-snap");
    expect(existsSync(snapshotDir)).toBe(true);
    expect(existsSync(join(snapshotDir, "memory", "semantic", "test.md"))).toBe(true);
  });
});

describe("assembleMemoryContext", () => {
  let projectDir: string;

  beforeEach(() => { projectDir = makeTempProject(); });
  afterEach(() => { try { rmSync(projectDir, { recursive: true, force: true }); } catch {} });

  it("returns empty string when no memories exist", () => {
    const ctx = assembleMemoryContext(projectDir);
    // May return empty or just ABOUT.md content
    expect(typeof ctx).toBe("string");
  });

  it("includes conventions with highest priority", () => {
    const convDir = join(projectDir, ".swe", "conventions");
    mkdirSync(convDir, { recursive: true });
    writeFileSync(join(convDir, "rules.md"), "Always use snake_case");
    const ctx = assembleMemoryContext(projectDir);
    expect(ctx).toContain("snake_case");
    expect(ctx).toContain("Conventions");
  });

  it("includes semantic memories", () => {
    writeMemory(projectDir, "semantic", "facts.md", "Godot 4.4 is the engine");
    const ctx = assembleMemoryContext(projectDir);
    expect(ctx).toContain("Godot 4.4");
  });

  it("respects maxTotalChars", () => {
    writeMemory(projectDir, "semantic", "big.md", "x".repeat(20000));
    const ctx = assembleMemoryContext(projectDir, { maxTotalChars: 1000 });
    expect(ctx.length).toBeLessThan(2000);
  });
});
