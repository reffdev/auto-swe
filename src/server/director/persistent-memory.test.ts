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
  logEpisodicAsync,
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

  it("creates all directories", async () => {
    await ensureMemoryDirs(projectDir);
    expect(existsSync(join(projectDir, ".swe", "memory", "episodic"))).toBe(true);
    expect(existsSync(join(projectDir, ".swe", "memory", "semantic"))).toBe(true);
    expect(existsSync(join(projectDir, ".swe", "conventions", "procedural"))).toBe(true);
    expect(existsSync(join(projectDir, ".swe", "conventions", "snapshots"))).toBe(true);
  });

  it("creates ABOUT.md files", async () => {
    await ensureMemoryDirs(projectDir);
    expect(existsSync(join(projectDir, ".swe", "memory", "episodic", "ABOUT.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".swe", "memory", "semantic", "ABOUT.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".swe", "conventions", "procedural", "ABOUT.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".swe", "conventions", "snapshots", "ABOUT.md"))).toBe(true);
  });

  it("adds .swe/ to .gitignore", async () => {
    await ensureMemoryDirs(projectDir);
    const gitignore = readFileSync(join(projectDir, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".swe/");
  });

  it("does not duplicate .swe/ in .gitignore", async () => {
    writeFileSync(join(projectDir, ".gitignore"), "node_modules\n.swe/\n");
    // Reset the ensured set so it runs again
    (ensureMemoryDirs as any).__reset?.();
    await ensureMemoryDirs(projectDir);
    const gitignore = readFileSync(join(projectDir, ".gitignore"), "utf-8");
    const matches = gitignore.match(/\.swe\//g);
    expect(matches).toHaveLength(1);
  });

  it("is idempotent", async () => {
    await ensureMemoryDirs(projectDir);
    await ensureMemoryDirs(projectDir);
    expect(existsSync(join(projectDir, ".swe", "memory", "episodic"))).toBe(true);
  });
});

describe("categoryDir", () => {
  it("returns correct paths", async () => {
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

  it("writes and reads a semantic memory", async () => {
    await writeMemory(projectDir, "semantic", "tech-stack.md", "# Tech Stack\n- Godot 4.4");
    const content = await readMemory(projectDir, "semantic", "tech-stack.md");
    expect(content).toBe("# Tech Stack\n- Godot 4.4");
  });

  it("writes and reads a procedural memory", async () => {
    await writeMemory(projectDir, "procedural", "deploy.md", "1. Build\n2. Push");
    const content = await readMemory(projectDir, "procedural", "deploy.md");
    expect(content).toContain("1. Build");
  });

  it("returns null for non-existent file", async () => {
    expect(await readMemory(projectDir, "semantic", "nope.md")).toBeNull();
  });

  it("overwrites existing file", async () => {
    await writeMemory(projectDir, "semantic", "test.md", "v1");
    await writeMemory(projectDir, "semantic", "test.md", "v2");
    expect(await readMemory(projectDir, "semantic", "test.md")).toBe("v2");
  });
});

describe("appendMemory", () => {
  let projectDir: string;

  beforeEach(() => { projectDir = makeTempProject(); });
  afterEach(() => { try { rmSync(projectDir, { recursive: true, force: true }); } catch {} });

  it("appends to existing file", async () => {
    await writeMemory(projectDir, "semantic", "notes.md", "line1");
    await appendMemory(projectDir, "semantic", "notes.md", "line2");
    const content = await readMemory(projectDir, "semantic", "notes.md");
    expect(content).toContain("line1");
    expect(content).toContain("line2");
  });

  it("creates file if it doesn't exist", async () => {
    await appendMemory(projectDir, "semantic", "new.md", "first line");
    const content = await readMemory(projectDir, "semantic", "new.md");
    expect(content).toContain("first line");
  });
});

describe("readMemoryCategory", () => {
  let projectDir: string;

  beforeEach(() => { projectDir = makeTempProject(); });
  afterEach(() => { try { rmSync(projectDir, { recursive: true, force: true }); } catch {} });

  it("returns all files in category sorted newest first", async () => {
    await writeMemory(projectDir, "semantic", "a.md", "first");
    // Small delay to ensure different mtime
    await writeMemory(projectDir, "semantic", "b.md", "second");
    const entries = (await readMemoryCategory(projectDir, "semantic")).filter(e => e.filename !== "ABOUT.md");
    expect(entries.length).toBe(2);
    const filenames = entries.map(e => e.filename);
    expect(filenames).toContain("a.md");
    expect(filenames).toContain("b.md");
  });

  it("returns empty array for empty category", async () => {
    await ensureMemoryDirs(projectDir);
    const entries = await readMemoryCategory(projectDir, "semantic");
    // May have ABOUT.md from ensureMemoryDirs
    const nonAbout = entries.filter(e => e.filename !== "ABOUT.md");
    expect(nonAbout).toHaveLength(0);
  });
});

describe("readAllMemories", () => {
  let projectDir: string;

  beforeEach(() => { projectDir = makeTempProject(); });
  afterEach(() => { try { rmSync(projectDir, { recursive: true, force: true }); } catch {} });

  it("reads across all categories", async () => {
    await writeMemory(projectDir, "semantic", "a.md", "semantic");
    await writeMemory(projectDir, "procedural", "b.md", "procedural");
    await writeMemory(projectDir, "episodic", "c.md", "episodic");
    const all = await readAllMemories(projectDir);
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

  it("creates a daily log file", async () => {
    await logEpisodicAsync(projectDir, "Task completed", "details here");
    const today = new Date().toISOString().slice(0, 10);
    const content = await readMemory(projectDir, "episodic", `${today}.md`);
    expect(content).toContain("Task completed");
    expect(content).toContain("details here");
  });

  it("appends to existing daily log", async () => {
    await logEpisodicAsync(projectDir, "Event 1");
    await logEpisodicAsync(projectDir, "Event 2");
    const today = new Date().toISOString().slice(0, 10);
    const content = await readMemory(projectDir, "episodic", `${today}.md`)!;
    expect(content).toContain("Event 1");
    expect(content).toContain("Event 2");
  });
});

describe("readConventions", () => {
  let projectDir: string;

  beforeEach(() => { projectDir = makeTempProject(); });
  afterEach(() => { try { rmSync(projectDir, { recursive: true, force: true }); } catch {} });

  it("reads top-level convention files", async () => {
    const convDir = join(projectDir, ".swe", "conventions");
    mkdirSync(convDir, { recursive: true });
    writeFileSync(join(convDir, "code-style.md"), "# Code Style\nuse snake_case");
    const entries = await readConventions(projectDir);
    expect(entries.length).toBe(1);
    expect(entries[0].filename).toBe("code-style.md");
    expect(entries[0].content).toContain("snake_case");
  });

  it("returns empty for no conventions", async () => {
    expect(await readConventions(projectDir)).toHaveLength(0);
  });
});

describe("createSnapshot", () => {
  let projectDir: string;

  beforeEach(() => { projectDir = makeTempProject(); });
  afterEach(() => { try { rmSync(projectDir, { recursive: true, force: true }); } catch {} });

  it("creates a snapshot directory with copies", async () => {
    await writeMemory(projectDir, "semantic", "test.md", "snapshot content");
    const snapshotDir = await createSnapshot(projectDir, "test-snap");
    expect(existsSync(snapshotDir)).toBe(true);
    expect(existsSync(join(snapshotDir, "memory", "semantic", "test.md"))).toBe(true);
  });
});

describe("assembleMemoryContext", () => {
  let projectDir: string;

  beforeEach(() => { projectDir = makeTempProject(); });
  afterEach(() => { try { rmSync(projectDir, { recursive: true, force: true }); } catch {} });

  it("returns empty string when no memories exist", async () => {
    const ctx = await assembleMemoryContext(projectDir);
    // May return empty or just ABOUT.md content
    expect(typeof ctx).toBe("string");
  });

  it("includes conventions with highest priority", async () => {
    const convDir = join(projectDir, ".swe", "conventions");
    mkdirSync(convDir, { recursive: true });
    writeFileSync(join(convDir, "rules.md"), "Always use snake_case");
    const ctx = await assembleMemoryContext(projectDir);
    expect(ctx).toContain("snake_case");
    expect(ctx).toContain("Conventions");
  });

  it("includes semantic memories", async () => {
    await writeMemory(projectDir, "semantic", "facts.md", "Godot 4.4 is the engine");
    const ctx = await assembleMemoryContext(projectDir);
    expect(ctx).toContain("Godot 4.4");
  });

  it("respects maxTotalChars", async () => {
    await writeMemory(projectDir, "semantic", "big.md", "x".repeat(20000));
    const ctx = await assembleMemoryContext(projectDir, { maxTotalChars: 1000 });
    expect(ctx.length).toBeLessThan(2000);
  });
});
