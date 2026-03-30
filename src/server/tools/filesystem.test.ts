import { makeFilesystemTools, makeReadOnlyTools, makeVerifyTools, makeTestWriteTools } from "./filesystem";
import { ContextBudget } from "./context-budget";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "fs-tools-test-"));
  writeFileSync(join(workdir, "hello.txt"), "line1\nline2\nline3\n");
  writeFileSync(join(workdir, "crlf.txt"), "line1\r\nline2\r\nline3\r\n");
  mkdirSync(join(workdir, "sub"));
  writeFileSync(join(workdir, "sub", "nested.ts"), "export const x = 1;\nexport const y = 2;\n");
});

afterEach(() => {
  try { rmSync(workdir, { recursive: true, force: true }); } catch {}
});

// ─── readFile ─────────────────────────────────────────────────────────────────

describe("readFile", () => {
  it("reads a file", async () => {
    const tools = makeFilesystemTools(workdir);
    const result = await tools.readFile.execute({ path: "hello.txt" }, { toolCallId: "t1", messages: [] });
    expect(result).toContain("line1");
    expect(result).toContain("line3");
  });

  it("normalizes CRLF to LF", async () => {
    const tools = makeFilesystemTools(workdir);
    const result = await tools.readFile.execute({ path: "crlf.txt" }, { toolCallId: "t1", messages: [] });
    expect(result).not.toContain("\r");
    expect(result).toContain("line1\nline2\nline3");
  });

  it("reads with offset and limit", async () => {
    const tools = makeFilesystemTools(workdir);
    const result = await tools.readFile.execute({ path: "hello.txt", offset: 1, limit: 1 }, { toolCallId: "t1", messages: [] });
    expect(result).toContain("line2");
    expect(result).not.toContain("line1");
  });

  it("returns error for nonexistent file", async () => {
    const tools = makeFilesystemTools(workdir);
    const result = await tools.readFile.execute({ path: "nope.txt" }, { toolCallId: "t1", messages: [] });
    expect(result).toMatch(/not found/i);
  });

  it("returns error for directory path", async () => {
    const tools = makeFilesystemTools(workdir);
    const result = await tools.readFile.execute({ path: "sub" }, { toolCallId: "t1", messages: [] });
    expect(result).toMatch(/directory/i);
  });

  it("rejects absolute paths outside workdir", async () => {
    const tools = makeFilesystemTools(workdir);
    const result = await tools.readFile.execute({ path: "/etc/passwd" }, { toolCallId: "t1", messages: [] });
    expect(result).toMatch(/outside|escapes/i);
  });

  it("rejects path traversal", async () => {
    const tools = makeFilesystemTools(workdir);
    const result = await tools.readFile.execute({ path: "../../../etc/passwd" }, { toolCallId: "t1", messages: [] });
    expect(result).toMatch(/escapes/i);
  });
});

// ─── writeFile ────────────────────────────────────────────────────────────────

describe("writeFile", () => {
  it("writes a new file", async () => {
    const tools = makeFilesystemTools(workdir);
    const result = await tools.writeFile.execute({ path: "new.txt", content: "hello" }, { toolCallId: "t1", messages: [] });
    expect(result).toMatch(/wrote/i);
    expect(readFileSync(join(workdir, "new.txt"), "utf-8")).toBe("hello");
  });

  it("creates parent directories", async () => {
    const tools = makeFilesystemTools(workdir);
    await tools.writeFile.execute({ path: "a/b/c.txt", content: "deep" }, { toolCallId: "t1", messages: [] });
    expect(readFileSync(join(workdir, "a", "b", "c.txt"), "utf-8")).toBe("deep");
  });

  it("overwrites existing file", async () => {
    const tools = makeFilesystemTools(workdir);
    await tools.writeFile.execute({ path: "hello.txt", content: "overwritten" }, { toolCallId: "t1", messages: [] });
    expect(readFileSync(join(workdir, "hello.txt"), "utf-8")).toBe("overwritten");
  });

  it("resets read count after write", async () => {
    const tools = makeFilesystemTools(workdir);
    const opts = { toolCallId: "t1", messages: [] };
    // Read the file with varying offsets to avoid loop detection
    await tools.readFile.execute({ path: "hello.txt" }, opts);
    await tools.readFile.execute({ path: "hello.txt", offset: 0, limit: 10 }, opts);
    await tools.readFile.execute({ path: "hello.txt", offset: 1, limit: 5 }, opts);
    // Write to reset the read count
    await tools.writeFile.execute({ path: "hello.txt", content: "new content" }, opts);
    // Should be able to read again without hitting the "already read" limit
    const result = await tools.readFile.execute({ path: "hello.txt" }, opts);
    expect(result).toContain("new content");
    expect(result).not.toMatch(/already read/i);
  });
});

// ─── replaceInFile ────────────────────────────────────────────────────────────

describe("replaceInFile", () => {
  it("replaces exact match", async () => {
    const tools = makeFilesystemTools(workdir);
    const result = await tools.replaceInFile.execute(
      { path: "hello.txt", old_str: "line2", new_str: "replaced" },
      { toolCallId: "t1", messages: [] }
    );
    expect(result).toMatch(/replaced 1/i);
    expect(readFileSync(join(workdir, "hello.txt"), "utf-8")).toContain("replaced");
  });

  it("handles CRLF files with LF search strings", async () => {
    const tools = makeFilesystemTools(workdir);
    // The agent sends \n but the file has \r\n — should still match after normalization
    const result = await tools.replaceInFile.execute(
      { path: "crlf.txt", old_str: "line1\nline2", new_str: "replaced" },
      { toolCallId: "t1", messages: [] }
    );
    expect(result).toMatch(/replaced 1/i);
  });

  it("returns error when string not found", async () => {
    const tools = makeFilesystemTools(workdir);
    const result = await tools.replaceInFile.execute(
      { path: "hello.txt", old_str: "nonexistent", new_str: "x" },
      { toolCallId: "t1", messages: [] }
    );
    expect(result).toMatch(/not found/i);
  });

  it("returns error when string appears multiple times", async () => {
    writeFileSync(join(workdir, "dups.txt"), "foo bar foo baz foo");
    const tools = makeFilesystemTools(workdir);
    const result = await tools.replaceInFile.execute(
      { path: "dups.txt", old_str: "foo", new_str: "x" },
      { toolCallId: "t1", messages: [] }
    );
    expect(result).toMatch(/appears.*times/i);
  });

  it("handles indentation normalization", async () => {
    writeFileSync(join(workdir, "indent.ts"), "  function foo() {\n    return 1;\n  }\n");
    const tools = makeFilesystemTools(workdir);
    // Agent sends with no indentation — normalization should find it
    const result = await tools.replaceInFile.execute(
      { path: "indent.ts", old_str: "function foo() {\nreturn 1;\n}", new_str: "function bar() {\nreturn 2;\n}" },
      { toolCallId: "t1", messages: [] }
    );
    expect(result).toMatch(/replaced 1/i);
  });

  it("strips line number prefixes with colon format (42: code)", async () => {
    writeFileSync(join(workdir, "numbered.ts"), "function hello() {\n  return 'world';\n}\n");
    const tools = makeFilesystemTools(workdir);
    const result = await tools.replaceInFile.execute(
      { path: "numbered.ts", old_str: "1: function hello() {\n2:   return 'world';\n3: }", new_str: "function goodbye() {\n  return 'earth';\n}" },
      { toolCallId: "t1", messages: [] }
    );
    expect(result).toMatch(/replaced 1/i);
    expect(readFileSync(join(workdir, "numbered.ts"), "utf-8")).toContain("goodbye");
  });

  it("strips line number prefixes with pipe format (42| code)", async () => {
    writeFileSync(join(workdir, "piped.ts"), "const x = 1;\nconst y = 2;\n");
    const tools = makeFilesystemTools(workdir);
    const result = await tools.replaceInFile.execute(
      { path: "piped.ts", old_str: "10| const x = 1;\n11| const y = 2;", new_str: "const x = 10;\nconst y = 20;" },
      { toolCallId: "t1", messages: [] }
    );
    expect(result).toMatch(/replaced 1/i);
    expect(readFileSync(join(workdir, "piped.ts"), "utf-8")).toContain("const x = 10;");
  });

  it("strips line number prefixes with arrow format (42→ code)", async () => {
    writeFileSync(join(workdir, "arrow.ts"), "export default 42;\n");
    const tools = makeFilesystemTools(workdir);
    const result = await tools.replaceInFile.execute(
      { path: "arrow.ts", old_str: "  1→ export default 42;", new_str: "export default 99;" },
      { toolCallId: "t1", messages: [] }
    );
    expect(result).toMatch(/replaced 1/i);
    expect(readFileSync(join(workdir, "arrow.ts"), "utf-8")).toContain("99");
  });

  it("strips line numbers with indentation normalization combined", async () => {
    writeFileSync(join(workdir, "both.ts"), "  if (true) {\n    doStuff();\n  }\n");
    const tools = makeFilesystemTools(workdir);
    // Agent copies from scout report: line numbers + different indentation
    const result = await tools.replaceInFile.execute(
      { path: "both.ts", old_str: "5: if (true) {\n6:   doStuff();\n7: }", new_str: "  if (false) {\n    doNothing();\n  }" },
      { toolCallId: "t1", messages: [] }
    );
    expect(result).toMatch(/replaced 1/i);
    expect(readFileSync(join(workdir, "both.ts"), "utf-8")).toContain("doNothing");
  });
});

// ─── listDirectory ────────────────────────────────────────────────────────────

describe("listDirectory", () => {
  it("lists root directory", async () => {
    const tools = makeFilesystemTools(workdir);
    const result = await tools.listDirectory.execute({ path: ".", max_depth: 0 }, { toolCallId: "t1", messages: [] });
    expect(result).toContain("hello.txt");
    expect(result).toContain("[dir] sub");
  });

  it("lists recursively with max_depth", async () => {
    const tools = makeFilesystemTools(workdir);
    const result = await tools.listDirectory.execute({ path: ".", max_depth: 1 }, { toolCallId: "t1", messages: [] });
    expect(result).toContain("nested.ts");
  });

  it("returns error for nonexistent directory", async () => {
    const tools = makeFilesystemTools(workdir);
    const result = await tools.listDirectory.execute({ path: "totally_nonexistent_dir_xyz", max_depth: 0 }, { toolCallId: "t1", messages: [] });
    expect(result).toMatch(/not found|not a directory|error/i);
  });

  it("skips node_modules and .git", async () => {
    mkdirSync(join(workdir, "node_modules"));
    writeFileSync(join(workdir, "node_modules", "pkg.js"), "x");
    mkdirSync(join(workdir, ".git"));
    const tools = makeFilesystemTools(workdir);
    const result = await tools.listDirectory.execute({ path: ".", max_depth: 1 }, { toolCallId: "t1", messages: [] });
    expect(result).not.toContain("node_modules");
    expect(result).not.toContain(".git");
  });
});

// ─── searchFiles ──────────────────────────────────────────────────────────────

describe("searchFiles", () => {
  it("finds a pattern in files", async () => {
    const tools = makeFilesystemTools(workdir);
    const result = await tools.searchFiles.execute(
      { pattern: "line2", glob: undefined, context_lines: 0, files_only: false, fixed_string: false, case_sensitive: true },
      { toolCallId: "t1", messages: [] }
    );
    expect(result).toContain("line2");
    expect(result).toContain("hello.txt");
  });

  it("returns file paths only with files_only", async () => {
    const tools = makeFilesystemTools(workdir);
    const result = await tools.searchFiles.execute(
      { pattern: "export", glob: undefined, context_lines: 0, files_only: true, fixed_string: false, case_sensitive: true },
      { toolCallId: "t1", messages: [] }
    );
    expect(result).toContain("nested.ts");
    // Should not contain the actual line content
    expect(result).not.toContain("const x");
  });

  it("returns no matches for absent pattern", async () => {
    const tools = makeFilesystemTools(workdir);
    const result = await tools.searchFiles.execute(
      { pattern: "zzzznonexistent", glob: undefined, context_lines: 0, files_only: false, fixed_string: false, case_sensitive: true },
      { toolCallId: "t1", messages: [] }
    );
    expect(result).toMatch(/no matches/i);
  });

  it("respects case_sensitive=false", async () => {
    const tools = makeFilesystemTools(workdir);
    const result = await tools.searchFiles.execute(
      { pattern: "LINE2", glob: undefined, context_lines: 0, files_only: false, fixed_string: false, case_sensitive: false },
      { toolCallId: "t1", messages: [] }
    );
    expect(result).toContain("line2");
  });
});

// ─── runCommand ───────────────────────────────────────────────────────────────

describe("runCommand", () => {
  it("runs a command and returns output", async () => {
    const tools = makeFilesystemTools(workdir);
    const result = await tools.runCommand.execute({ command: "echo hello" }, { toolCallId: "t1", messages: [] });
    expect(result).toContain("hello");
  });

  it("strips cd commands", async () => {
    const tools = makeFilesystemTools(workdir);
    const result = await tools.runCommand.execute({ command: "cd /tmp && echo works" }, { toolCallId: "t1", messages: [] });
    expect(result).toContain("works");
  });

  it("allows piped commands like head in pipelines", async () => {
    const tools = makeFilesystemTools(workdir);
    const result = await tools.runCommand.execute({ command: "echo hello | head -1" }, { toolCallId: "t1", messages: [] });
    expect(result).toContain("hello");
  });

  it("returns exit code on failure", async () => {
    const tools = makeFilesystemTools(workdir);
    const result = await tools.runCommand.execute({ command: "exit 1" }, { toolCallId: "t1", messages: [] });
    expect(result).toMatch(/exit 1/i);
  });
});

// ─── getFileInfo ──────────────────────────────────────────────────────────────

describe("getFileInfo", () => {
  it("returns file metadata", async () => {
    const tools = makeFilesystemTools(workdir);
    const result = await tools.getFileInfo.execute({ path: "hello.txt" }, { toolCallId: "t1", messages: [] });
    expect(result).toMatch(/hello\.txt/);
    expect(result).toMatch(/bytes/);
    expect(result).toMatch(/lines/);
    expect(result).toMatch(/modified/);
  });

  it("returns error for nonexistent file", async () => {
    const tools = makeFilesystemTools(workdir);
    const result = await tools.getFileInfo.execute({ path: "nope.txt" }, { toolCallId: "t1", messages: [] });
    expect(result).toMatch(/error/i);
  });
});

// ─── appendToFile ─────────────────────────────────────────────────────────────

describe("appendToFile", () => {
  it("appends to existing file", async () => {
    const tools = makeFilesystemTools(workdir);
    await tools.appendToFile.execute({ path: "hello.txt", content: "line4\n" }, { toolCallId: "t1", messages: [] });
    expect(readFileSync(join(workdir, "hello.txt"), "utf-8")).toContain("line4");
  });

  it("creates file if it doesn't exist", async () => {
    const tools = makeFilesystemTools(workdir);
    await tools.appendToFile.execute({ path: "brand-new.txt", content: "first" }, { toolCallId: "t1", messages: [] });
    expect(readFileSync(join(workdir, "brand-new.txt"), "utf-8")).toBe("first");
  });
});

// ─── deleteFile ───────────────────────────────────────────────────────────────

describe("deleteFile", () => {
  it("deletes a file", async () => {
    const tools = makeFilesystemTools(workdir);
    const result = await tools.deleteFile.execute({ path: "hello.txt" }, { toolCallId: "t1", messages: [] });
    expect(result).toMatch(/deleted/i);
    expect(existsSync(join(workdir, "hello.txt"))).toBe(false);
  });

  it("returns error for nonexistent file", async () => {
    const tools = makeFilesystemTools(workdir);
    const result = await tools.deleteFile.execute({ path: "nope.txt" }, { toolCallId: "t1", messages: [] });
    expect(result).toMatch(/error/i);
  });
});

// ─── moveFile ─────────────────────────────────────────────────────────────────

describe("moveFile", () => {
  it("moves a file", async () => {
    const tools = makeFilesystemTools(workdir);
    const result = await tools.moveFile.execute({ from: "hello.txt", to: "moved.txt" }, { toolCallId: "t1", messages: [] });
    expect(result).toMatch(/moved/i);
    expect(existsSync(join(workdir, "hello.txt"))).toBe(false);
    expect(existsSync(join(workdir, "moved.txt"))).toBe(true);
  });

  it("creates parent directories for target", async () => {
    const tools = makeFilesystemTools(workdir);
    await tools.moveFile.execute({ from: "hello.txt", to: "deep/dir/moved.txt" }, { toolCallId: "t1", messages: [] });
    expect(existsSync(join(workdir, "deep", "dir", "moved.txt"))).toBe(true);
  });
});

// ─── gitStatus / gitDiff ──────────────────────────────────────────────────────

describe("gitStatus and gitDiff", () => {
  // These need a git repo
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require("child_process");
    execSync("git init", { cwd: workdir });
    execSync("git config user.email test@test.com", { cwd: workdir });
    execSync("git config user.name Test", { cwd: workdir });
    execSync("git add -A && git commit -m init", { cwd: workdir });
  });

  it("gitStatus shows clean tree", async () => {
    const tools = makeFilesystemTools(workdir);
    const result = await tools.gitStatus.execute({}, { toolCallId: "t1", messages: [] });
    expect(result).toMatch(/nothing to commit|clean/i);
  });

  it("gitStatus shows modified files", async () => {
    writeFileSync(join(workdir, "hello.txt"), "changed");
    const tools = makeFilesystemTools(workdir);
    const result = await tools.gitStatus.execute({}, { toolCallId: "t1", messages: [] });
    expect(result).toContain("hello.txt");
  });

  it("gitDiff shows changes", async () => {
    writeFileSync(join(workdir, "hello.txt"), "changed");
    const tools = makeFilesystemTools(workdir);
    const result = await tools.gitDiff.execute({ staged: false }, { toolCallId: "t1", messages: [] });
    expect(result).toContain("changed");
  });

  it("gitDiff staged shows nothing when not staged", async () => {
    writeFileSync(join(workdir, "hello.txt"), "changed");
    const tools = makeFilesystemTools(workdir);
    const result = await tools.gitDiff.execute({ staged: true }, { toolCallId: "t1", messages: [] });
    expect(result).toMatch(/no staged/i);
  });
});

// ─── Tool set factories ───────────────────────────────────────────────────────

describe("tool set factories", () => {
  it("makeReadOnlyTools excludes write tools", () => {
    const tools = makeReadOnlyTools(workdir);
    expect(tools.readFile).toBeDefined();
    expect(tools.listDirectory).toBeDefined();
    expect(tools.searchFiles).toBeDefined();
    expect(tools.getFileInfo).toBeDefined();
    expect((tools as Record<string, unknown>).writeFile).toBeUndefined();
    expect((tools as Record<string, unknown>).runCommand).toBeUndefined();
    expect((tools as Record<string, unknown>).deleteFile).toBeUndefined();
  });

  it("makeTestWriteTools includes write, run, replace, and git read tools", () => {
    const tools = makeTestWriteTools(workdir);
    expect(tools.readFile).toBeDefined();
    expect(tools.writeFile).toBeDefined();
    expect(tools.replaceInFile).toBeDefined();
    expect(tools.runCommand).toBeDefined();
    expect(tools.gitStatus).toBeDefined();
    expect(tools.gitDiff).toBeDefined();
  });

  it("makeVerifyTools includes run and git but not write", () => {
    const tools = makeVerifyTools(workdir);
    expect(tools.readFile).toBeDefined();
    expect(tools.runCommand).toBeDefined();
    expect(tools.gitStatus).toBeDefined();
    expect(tools.gitDiff).toBeDefined();
    expect((tools as Record<string, unknown>).writeFile).toBeUndefined();
    expect((tools as Record<string, unknown>).deleteFile).toBeUndefined();
  });

  it("budget is optional", () => {
    const tools = makeFilesystemTools(workdir); // no budget
    expect(tools.readFile).toBeDefined();
  });

  it("budget parameter is accepted without error", async () => {
    const budget = new ContextBudget(1000);
    const tools = makeFilesystemTools(workdir, budget);
    const result = await tools.readFile.execute({ path: "hello.txt" }, { toolCallId: "t1", messages: [] });
    expect(result).toContain("line1");
    // Budget tracking is disabled — cap() no longer truncates or tracks
    expect(budget.usage).toBe(0);
  });
});

// ─── Loop detection ───────────────────────────────────────────────────────────

describe("loop detection", () => {
  it("blocks repeated identical calls", async () => {
    const tools = makeFilesystemTools(workdir);
    const opts = { toolCallId: "t1", messages: [] };
    await tools.readFile.execute({ path: "hello.txt" }, opts);
    await tools.readFile.execute({ path: "hello.txt" }, opts);
    const third = await tools.readFile.execute({ path: "hello.txt" }, opts);
    expect(third).toMatch(/same arguments/i);
  });
});
