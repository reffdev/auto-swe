import { ToolLoopGuard } from "./tool-loop-guard";

describe("ToolLoopGuard", () => {
  it("does not trip on first call", () => {
    const guard = new ToolLoopGuard(3);
    expect(guard.observe([{ tool: "runCommand", args: "{}" }]).looping).toBe(false);
  });

  it("trips on threshold consecutive identical calls", () => {
    const guard = new ToolLoopGuard(3);
    const sig = [{ tool: "runCommand", args: '{"cmd":"ls"}' }];
    expect(guard.observe(sig).looping).toBe(false);
    expect(guard.observe(sig).looping).toBe(false);
    const r = guard.observe(sig);
    expect(r.looping).toBe(true);
    expect(r.count).toBe(3);
    expect(r.signature).toContain("runCommand");
  });

  it("resets count when signature changes", () => {
    const guard = new ToolLoopGuard(3);
    const a = [{ tool: "runCommand", args: '{"cmd":"ls"}' }];
    const b = [{ tool: "runCommand", args: '{"cmd":"pwd"}' }];
    guard.observe(a);
    guard.observe(a);
    guard.observe(b);
    const r = guard.observe(a);
    expect(r.looping).toBe(false);
    expect(r.count).toBe(1);
  });

  it("ignores empty/missing tool calls without resetting", () => {
    const guard = new ToolLoopGuard(3);
    const sig = [{ tool: "runCommand", args: '{"cmd":"ls"}' }];
    guard.observe(sig);
    guard.observe(sig);
    expect(guard.observe(undefined).looping).toBe(false);
    expect(guard.observe([]).looping).toBe(false);
    // Counter survived the empty observations
    expect(guard.observe(sig).looping).toBe(true);
  });

  it("resets fully on reset()", () => {
    const guard = new ToolLoopGuard(3);
    const sig = [{ tool: "runCommand", args: '{"cmd":"ls"}' }];
    guard.observe(sig);
    guard.observe(sig);
    guard.reset();
    expect(guard.observe(sig).looping).toBe(false);
    expect(guard.getCount()).toBe(1);
  });

  it("treats multi-tool steps as one signature", () => {
    const guard = new ToolLoopGuard(2);
    const multi = [
      { tool: "readFile", args: '{"path":"a.ts"}' },
      { tool: "runCommand", args: '{"cmd":"build"}' },
    ];
    guard.observe(multi);
    expect(guard.observe(multi).looping).toBe(true);
  });
});
