import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Db } from "./db";
import {
  acquireLease,
  releaseLease,
  hasCapacity,
  getActiveLeases,
  getLeaseCount,
  getLeasedMachineIds,
  clearAllLeases,
} from "./machine-manager";

let db: Db;
let dbPath: string;
let machineId: string;

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), "mm-test-")), "test.db");
  db = new Db(dbPath);
  clearAllLeases();
  const machine = db.createMachine({ base_url: "http://test/v1", name: "test-machine" });
  machineId = machine.id;
});

afterEach(() => {
  db.close();
  try { rmSync(dbPath, { force: true }); } catch {}
});

describe("acquireLease", () => {
  it("acquires a lease on an available machine", () => {
    const result = acquireLease(db, "foreman", "test task");
    expect(result).not.toBeNull();
    expect(result!.machine.id).toBe(machineId);
    expect(result!.lease.consumer).toBe("foreman");
    expect(result!.lease.label).toBe("test task");
    releaseLease(result!.lease.id);
  });

  it("returns null when machine is at capacity", () => {
    const first = acquireLease(db, "foreman", "task 1");
    expect(first).not.toBeNull();

    const second = acquireLease(db, "foreman", "task 2");
    expect(second).toBeNull();

    releaseLease(first!.lease.id);
  });

  it("respects max_concurrent", () => {
    db.updateMachine(machineId, { max_concurrent: 3 });

    const leases = [];
    for (let i = 0; i < 3; i++) {
      const result = acquireLease(db, "foreman", `task ${i}`);
      expect(result).not.toBeNull();
      leases.push(result!);
    }

    const fourth = acquireLease(db, "foreman", "task 3");
    expect(fourth).toBeNull();

    for (const l of leases) releaseLease(l.lease.id);
  });

  it("uses preferred machine when available", () => {
    const m2 = db.createMachine({ base_url: "http://test2/v1", name: "preferred" });
    const result = acquireLease(db, "director", "planning", { preferredMachineId: m2.id });
    expect(result).not.toBeNull();
    expect(result!.machine.id).toBe(m2.id);
    releaseLease(result!.lease.id);
  });

  it("falls back when preferred machine is at capacity", () => {
    const m2 = db.createMachine({ base_url: "http://test2/v1", name: "preferred" });
    const block = acquireLease(db, "foreman", "blocker", { preferredMachineId: m2.id });
    expect(block).not.toBeNull();

    // Should fall back to the other machine
    const fallback = acquireLease(db, "director", "planning", { preferredMachineId: m2.id });
    expect(fallback).not.toBeNull();
    expect(fallback!.machine.id).toBe(machineId);

    releaseLease(block!.lease.id);
    releaseLease(fallback!.lease.id);
  });

  it("filters by machine type", () => {
    db.updateMachine(machineId, { machine_type: "comfyui" });
    const result = acquireLease(db, "foreman", "code task", { machineType: "inference" });
    expect(result).toBeNull(); // only comfyui machine exists
  });

  it("preferred machine skips enabled check", () => {
    db.updateMachine(machineId, { enabled: 0 });
    const result = acquireLease(db, "director", "planning", { preferredMachineId: machineId });
    expect(result).not.toBeNull();
    releaseLease(result!.lease.id);
  });

  it("non-preferred path requires enabled", () => {
    db.updateMachine(machineId, { enabled: 0 });
    const result = acquireLease(db, "foreman", "task");
    expect(result).toBeNull();
  });
});

describe("releaseLease", () => {
  it("frees capacity after release", () => {
    const first = acquireLease(db, "foreman", "task 1");
    expect(acquireLease(db, "foreman", "task 2")).toBeNull();

    releaseLease(first!.lease.id);

    const after = acquireLease(db, "foreman", "task 2");
    expect(after).not.toBeNull();
    releaseLease(after!.lease.id);
  });

  it("is idempotent — releasing twice doesn't crash", () => {
    const result = acquireLease(db, "foreman", "task");
    releaseLease(result!.lease.id);
    releaseLease(result!.lease.id); // should not throw
    expect(getLeaseCount(machineId)).toBe(0);
  });
});

describe("hasCapacity", () => {
  it("returns true when no leases", () => {
    const machine = db.getMachine(machineId)!;
    expect(hasCapacity(machine)).toBe(true);
  });

  it("returns false when at capacity", () => {
    const lease = acquireLease(db, "foreman", "task");
    const machine = db.getMachine(machineId)!;
    expect(hasCapacity(machine)).toBe(false);
    releaseLease(lease!.lease.id);
  });
});

describe("getActiveLeases", () => {
  it("returns all active leases", () => {
    const l1 = acquireLease(db, "foreman", "task 1");
    db.createMachine({ base_url: "http://test2/v1" });
    const l2 = acquireLease(db, "director", "planning");

    const leases = getActiveLeases();
    expect(leases).toHaveLength(2);

    releaseLease(l1!.lease.id);
    releaseLease(l2!.lease.id);
  });

  it("returns empty after clearAllLeases", () => {
    acquireLease(db, "foreman", "task");
    clearAllLeases();
    expect(getActiveLeases()).toHaveLength(0);
  });
});

describe("getLeaseCount", () => {
  it("tracks per-machine count", () => {
    db.updateMachine(machineId, { max_concurrent: 3 });
    expect(getLeaseCount(machineId)).toBe(0);

    const l1 = acquireLease(db, "foreman", "task 1");
    expect(getLeaseCount(machineId)).toBe(1);

    const l2 = acquireLease(db, "foreman", "task 2");
    expect(getLeaseCount(machineId)).toBe(2);

    releaseLease(l1!.lease.id);
    expect(getLeaseCount(machineId)).toBe(1);

    releaseLease(l2!.lease.id);
    expect(getLeaseCount(machineId)).toBe(0);
  });
});

describe("getLeasedMachineIds", () => {
  it("returns machine IDs with active leases", () => {
    const lease = acquireLease(db, "director", "planning");
    expect(getLeasedMachineIds()).toContain(machineId);
    releaseLease(lease!.lease.id);
  });

  it("filters by consumer", () => {
    const lease = acquireLease(db, "director", "planning");
    expect(getLeasedMachineIds("director")).toContain(machineId);
    expect(getLeasedMachineIds("foreman")).not.toContain(machineId);
    releaseLease(lease!.lease.id);
  });
});

describe("fallbackMachineTypes", () => {
  it("uses fallback type when primary has no machines", () => {
    db.updateMachine(machineId, { machine_type: "npu" });
    // Try inference (no machines) with npu fallback
    const result = acquireLease(db, "director", "extraction", {
      machineType: "inference",
      fallbackMachineTypes: ["npu"],
    });
    expect(result).not.toBeNull();
    expect(result!.machine.machine_type).toBe("npu");
    releaseLease(result!.lease.id);
  });

  it("prefers primary type over fallback", () => {
    const npu = db.createMachine({ base_url: "http://npu/v1", name: "npu", machine_type: "npu" });
    // machineId is inference (default), should be preferred
    const result = acquireLease(db, "director", "extraction", {
      machineType: "inference",
      fallbackMachineTypes: ["npu"],
    });
    expect(result).not.toBeNull();
    expect(result!.machine.id).toBe(machineId); // inference, not npu
    releaseLease(result!.lease.id);
  });

  it("falls through multiple fallback types in order", () => {
    db.updateMachine(machineId, { machine_type: "comfyui" }); // not inference or npu
    const npu = db.createMachine({ base_url: "http://npu/v1", name: "npu", machine_type: "npu" });
    const result = acquireLease(db, "director", "task", {
      machineType: "inference",
      fallbackMachineTypes: ["npu", "comfyui"],
    });
    expect(result).not.toBeNull();
    expect(result!.machine.machine_type).toBe("npu"); // first fallback
    releaseLease(result!.lease.id);
  });

  it("returns null when no type has capacity", () => {
    // Fill the only machine
    const block = acquireLease(db, "foreman", "blocker");
    const result = acquireLease(db, "director", "task", {
      machineType: "inference",
      fallbackMachineTypes: ["npu", "comfyui"],
    });
    expect(result).toBeNull();
    releaseLease(block!.lease.id);
  });

  it("logs when falling back to a different type", () => {
    db.updateMachine(machineId, { machine_type: "npu" });
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    const result = acquireLease(db, "director", "task", {
      machineType: "inference",
      fallbackMachineTypes: ["npu"],
    });
    expect(result).not.toBeNull();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("fallback npu"));
    spy.mockRestore();
    releaseLease(result!.lease.id);
  });
});

describe("npu machine type", () => {
  it("acquires lease on npu machine", () => {
    db.updateMachine(machineId, { machine_type: "npu" });
    const result = acquireLease(db, "director", "extraction", { machineType: "npu" });
    expect(result).not.toBeNull();
    expect(result!.machine.machine_type).toBe("npu");
    releaseLease(result!.lease.id);
  });

  it("does not return npu machine when requesting inference", () => {
    db.updateMachine(machineId, { machine_type: "npu" });
    const result = acquireLease(db, "foreman", "code task", { machineType: "inference" });
    expect(result).toBeNull();
  });
});

describe("host colocation", () => {
  it("blocks inference when comfyui is active on same host", () => {
    // Both on same IP, different ports
    db.updateMachine(machineId, { base_url: "http://192.168.1.10:8080/v1", machine_type: "inference" });
    const comfy = db.createMachine({ base_url: "http://192.168.1.10:8188", machine_type: "comfyui", name: "comfy" });

    // Lease comfyui first
    const comfyLease = acquireLease(db, "foreman", "art task", { machineType: "comfyui" });
    expect(comfyLease).not.toBeNull();

    // Inference on same host should be blocked
    const inferLease = acquireLease(db, "foreman", "code task", { machineType: "inference" });
    expect(inferLease).toBeNull();

    releaseLease(comfyLease!.lease.id);

    // Now inference should work
    const afterRelease = acquireLease(db, "foreman", "code task", { machineType: "inference" });
    expect(afterRelease).not.toBeNull();
    releaseLease(afterRelease!.lease.id);
  });

  it("blocks comfyui when inference is active on same host", () => {
    db.updateMachine(machineId, { base_url: "http://192.168.1.10:8080/v1", machine_type: "inference" });
    const comfy = db.createMachine({ base_url: "http://192.168.1.10:8188", machine_type: "comfyui", name: "comfy" });

    // Lease inference first
    const inferLease = acquireLease(db, "foreman", "code task", { machineType: "inference" });
    expect(inferLease).not.toBeNull();

    // ComfyUI should be blocked — never two GPU types active on same host
    const comfyLease = acquireLease(db, "foreman", "art task", { machineType: "comfyui" });
    expect(comfyLease).toBeNull();

    releaseLease(inferLease!.lease.id);

    // Now comfyui should work
    const afterRelease = acquireLease(db, "foreman", "art task", { machineType: "comfyui" });
    expect(afterRelease).not.toBeNull();
    releaseLease(afterRelease!.lease.id);
  });

  it("does NOT block NPU by colocated inference", () => {
    db.updateMachine(machineId, { base_url: "http://192.168.1.10:8080/v1", machine_type: "inference" });
    const npu = db.createMachine({ base_url: "http://192.168.1.10:52625/v1", machine_type: "npu", name: "npu", model_id: "small" });

    // Lease inference
    const inferLease = acquireLease(db, "foreman", "code task", { machineType: "inference" });
    expect(inferLease).not.toBeNull();

    // NPU should NOT be blocked — separate chip
    const npuLease = acquireLease(db, "director", "extraction", { machineType: "npu" });
    expect(npuLease).not.toBeNull();

    releaseLease(inferLease!.lease.id);
    releaseLease(npuLease!.lease.id);
  });

  it("does NOT block NPU by colocated comfyui", () => {
    const comfy = db.createMachine({ base_url: "http://192.168.1.10:8188", machine_type: "comfyui", name: "comfy" });
    const npu = db.createMachine({ base_url: "http://192.168.1.10:52625/v1", machine_type: "npu", name: "npu", model_id: "small" });

    const comfyLease = acquireLease(db, "foreman", "art", { machineType: "comfyui" });
    expect(comfyLease).not.toBeNull();

    const npuLease = acquireLease(db, "director", "extraction", { machineType: "npu" });
    expect(npuLease).not.toBeNull();

    releaseLease(comfyLease!.lease.id);
    releaseLease(npuLease!.lease.id);
  });

  it("does not block machines on different hosts", () => {
    db.updateMachine(machineId, { base_url: "http://192.168.1.10:8080/v1", machine_type: "inference" });
    const comfy = db.createMachine({ base_url: "http://192.168.1.20:8188", machine_type: "comfyui", name: "comfy" });

    const comfyLease = acquireLease(db, "foreman", "art", { machineType: "comfyui" });
    expect(comfyLease).not.toBeNull();

    // Different host — should not be blocked
    const inferLease = acquireLease(db, "foreman", "code", { machineType: "inference" });
    expect(inferLease).not.toBeNull();

    releaseLease(comfyLease!.lease.id);
    releaseLease(inferLease!.lease.id);
  });

  it("preferred machine respects colocation blocking", () => {
    db.updateMachine(machineId, { base_url: "http://192.168.1.10:8080/v1", machine_type: "inference" });
    const comfy = db.createMachine({ base_url: "http://192.168.1.10:8188", machine_type: "comfyui", name: "comfy" });
    const other = db.createMachine({ base_url: "http://192.168.1.20:8080/v1", machine_type: "inference", name: "other" });

    // ComfyUI active on .10
    const comfyLease = acquireLease(db, "foreman", "art", { machineType: "comfyui" });
    expect(comfyLease).not.toBeNull();

    // Preferred inference on .10 should be blocked, falls back to .20
    const inferLease = acquireLease(db, "director", "planning", {
      machineType: "inference",
      preferredMachineId: machineId,
    });
    expect(inferLease).not.toBeNull();
    expect(inferLease!.machine.id).toBe(other.id); // fell back to other host

    releaseLease(comfyLease!.lease.id);
    releaseLease(inferLease!.lease.id);
  });
});

describe("lease expiry", () => {
  it("expired leases are cleaned up on next acquire", () => {
    // Acquire with a very short timeout
    const result = acquireLease(db, "foreman", "expiring", { timeoutMs: 1 });
    expect(result).not.toBeNull();

    // Wait for expiry
    const start = Date.now();
    while (Date.now() - start < 10) { /* busy wait */ }

    // Next acquire should succeed because the expired lease was cleaned
    const consoleSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const after = acquireLease(db, "foreman", "after expiry");
    expect(after).not.toBeNull();
    consoleSpy.mockRestore();

    releaseLease(after!.lease.id);
  });
});
