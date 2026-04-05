import { Db } from "./db";
import { selectPlannerMachine, selectLightMachine } from "./planner-llm";

let db: Db;

beforeEach(() => {
  db = new Db(":memory:");
});

describe("selectLightMachine", () => {
  it("returns null when no machines exist", () => {
    expect(selectLightMachine(db)).toBeNull();
  });

  it("returns null when all machines are disabled", () => {
    const m = db.createMachine({ base_url: "http://test/v1", model_id: "test" });
    db.updateMachine(m.id, { enabled: 0 });
    expect(selectLightMachine(db)).toBeNull();
  });

  it("prefers NPU machine over inference", () => {
    db.createMachine({ base_url: "http://inference/v1", model_id: "big-model", machine_type: "inference", name: "inference" });
    const npu = db.createMachine({ base_url: "http://npu/v1", model_id: "small-model", machine_type: "npu", name: "npu" });

    const result = selectLightMachine(db);
    expect(result).not.toBeNull();
    expect(result!.machine.id).toBe(npu.id);
    expect(result!.modelId).toBe("small-model");
  });

  it("falls back to inference when no NPU exists", () => {
    const inf = db.createMachine({ base_url: "http://inference/v1", model_id: "big-model", machine_type: "inference" });

    const result = selectLightMachine(db);
    expect(result).not.toBeNull();
    expect(result!.machine.id).toBe(inf.id);
    expect(result!.modelId).toBe("big-model");
  });

  it("skips NPU machine without model_id", () => {
    db.createMachine({ base_url: "http://npu/v1", model_id: null, machine_type: "npu" });
    const inf = db.createMachine({ base_url: "http://inference/v1", model_id: "big-model", machine_type: "inference" });

    const result = selectLightMachine(db);
    expect(result).not.toBeNull();
    expect(result!.machine.id).toBe(inf.id);
  });

  it("does NOT use director_machine_id config (unlike selectPlannerMachine)", () => {
    const dirMachine = db.createMachine({ base_url: "http://director/v1", model_id: "director-model", machine_type: "inference", name: "director" });
    const npu = db.createMachine({ base_url: "http://npu/v1", model_id: "small-model", machine_type: "npu", name: "npu" });

    // Configure director machine in foreman config
    db.upsertForemanConfig({ director_machine_id: dirMachine.id });

    const light = selectLightMachine(db);
    expect(light).not.toBeNull();
    expect(light!.machine.id).toBe(npu.id); // NPU, not director machine

    const planner = selectPlannerMachine(db);
    expect(planner).not.toBeNull();
    expect(planner!.machine.id).toBe(dirMachine.id); // director machine
  });

  it("ignores comfyui machines", () => {
    db.createMachine({ base_url: "http://comfy/v1", model_id: "comfyui", machine_type: "comfyui" });
    expect(selectLightMachine(db)).toBeNull();
  });
});
