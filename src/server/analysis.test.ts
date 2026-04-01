import { Db } from "./db";

let db: Db;

beforeEach(() => {
  db = new Db(":memory:");
});

describe("analysis configs", () => {
  let projectId: string;

  beforeEach(() => {
    const p = db.createProject({ name: "test", workdir: "/tmp" });
    projectId = p.id;
  });

  it("upsertAnalysisConfig creates a new config", () => {
    const config = db.upsertAnalysisConfig({ project_id: projectId, lens_key: "security" });
    expect(config.lens_key).toBe("security");
    expect(config.enabled).toBe(1);
    expect(config.frequency).toBe("weekly");
  });

  it("upsertAnalysisConfig updates existing config", () => {
    db.upsertAnalysisConfig({ project_id: projectId, lens_key: "security" });
    const updated = db.upsertAnalysisConfig({ project_id: projectId, lens_key: "security", enabled: 0, frequency: "daily" });
    expect(updated.enabled).toBe(0);
    expect(updated.frequency).toBe("daily");
  });

  it("upsertAnalysisConfig with no updates returns existing", () => {
    const original = db.upsertAnalysisConfig({ project_id: projectId, lens_key: "security" });
    const same = db.upsertAnalysisConfig({ project_id: projectId, lens_key: "security" });
    expect(same.id).toBe(original.id);
  });

  it("getAnalysisConfigs returns configs for a project", () => {
    db.upsertAnalysisConfig({ project_id: projectId, lens_key: "security" });
    db.upsertAnalysisConfig({ project_id: projectId, lens_key: "performance" });
    const configs = db.getAnalysisConfigs(projectId);
    expect(configs).toHaveLength(2);
  });

  it("getDueAnalyses returns configs with past or null next_run_at", () => {
    const config = db.upsertAnalysisConfig({ project_id: projectId, lens_key: "security" });
    // next_run_at is null — should be due
    const due = db.getDueAnalyses();
    expect(due.length).toBeGreaterThanOrEqual(1);
    expect(due.some(d => d.id === config.id)).toBe(true);
  });

  it("getDueAnalyses excludes disabled configs", () => {
    db.upsertAnalysisConfig({ project_id: projectId, lens_key: "security", enabled: 0 });
    const due = db.getDueAnalyses();
    expect(due).toHaveLength(0);
  });

  it("getDueAnalyses excludes configs with future next_run_at", () => {
    const config = db.upsertAnalysisConfig({ project_id: projectId, lens_key: "security" });
    const future = new Date(Date.now() + 86400000).toISOString();
    db.updateAnalysisConfig(config.id, { next_run_at: future });
    const due = db.getDueAnalyses();
    expect(due).toHaveLength(0);
  });
});

describe("analysis runs", () => {
  let projectId: string;
  let configId: string;

  beforeEach(() => {
    const p = db.createProject({ name: "test", workdir: "/tmp" });
    projectId = p.id;
    const config = db.upsertAnalysisConfig({ project_id: projectId, lens_key: "security" });
    configId = config.id;
  });

  it("creates and retrieves an analysis run", () => {
    const run = db.createAnalysisRun({ project_id: projectId, config_id: configId, lens_key: "security" });
    expect(run.id).toBeDefined();
    expect(run.status).toBe("pending");

    const fetched = db.getAnalysisRun(run.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(run.id);
  });

  it("updates analysis run status and findings", () => {
    const run = db.createAnalysisRun({ project_id: projectId, config_id: configId, lens_key: "security" });
    db.updateAnalysisRun(run.id, {
      status: "pass",
      findings: JSON.stringify([{ severity: "high", file: "test.ts", line: 1, title: "test", description: "desc", recommendation: "fix" }]),
      summary: JSON.stringify({ total: 1, critical: 0, high: 1, medium: 0, low: 0 }),
      completed_at: new Date().toISOString(),
    });

    const updated = db.getAnalysisRun(run.id);
    expect(updated!.status).toBe("pass");
    expect(JSON.parse(updated!.findings!)).toHaveLength(1);
  });

  it("getAnalysisRuns returns runs for a project", () => {
    db.createAnalysisRun({ project_id: projectId, config_id: configId, lens_key: "security" });
    db.createAnalysisRun({ project_id: projectId, config_id: configId, lens_key: "security" });
    const runs = db.getAnalysisRuns(projectId);
    expect(runs).toHaveLength(2);
  });

  it("getLatestAnalysisRun returns the most recent run", () => {
    const run1 = db.createAnalysisRun({ project_id: projectId, config_id: configId, lens_key: "security" });
    db.updateAnalysisRun(run1.id, { started_at: "2024-01-01T00:00:00Z" });
    const run2 = db.createAnalysisRun({ project_id: projectId, config_id: configId, lens_key: "security" });
    db.updateAnalysisRun(run2.id, { started_at: "2024-06-01T00:00:00Z" });

    const latest = db.getLatestAnalysisRun(configId);
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe(run2.id);
  });

  it("analysis runs count toward machine availability", () => {
    const { acquireLease, releaseLease } = require("./machine-manager");
    const m = db.createMachine({ base_url: "http://test/v1" }); // max_concurrent defaults to 1

    // Acquire a lease — machine should now be at capacity
    const lease = acquireLease(db, "analysis", "blocker", { machineType: "inference" });
    expect(lease).not.toBeNull();

    // Second lease should fail
    const second = acquireLease(db, "analysis", "second", { machineType: "inference" });
    expect(second).toBeNull();

    releaseLease(lease.lease.id);
  });
});
