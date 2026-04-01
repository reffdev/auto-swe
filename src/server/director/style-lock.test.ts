import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  lockStyle,
  getStyleLock,
  isStyleLocked,
  getStyleReferencePath,
  unlockStyle,
  type StyleLockConfig,
} from "./style-lock";

function makeTempProject(): string {
  const dir = join(tmpdir(), `style-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeTestImage(projectDir: string): string {
  const imgPath = join(projectDir, "test-ref.png");
  writeFileSync(imgPath, Buffer.from("fake-png-data"));
  return imgPath;
}

const baseConfig: StyleLockConfig = {
  checkpoint: "sd_xl_base_1.0.safetensors",
  preset: "pixel_sprite",
  prompt_style_prefix: "16-bit dark fantasy pixel art, limited palette",
  reference_image: "",
  ip_adapter_model: "ip-adapter-plus_sdxl_vit-h.safetensors",
  ip_adapter_weight: 0.75,
  locked_at: new Date().toISOString(),
};

describe("style-lock", () => {
  let projectDir: string;

  beforeEach(() => { projectDir = makeTempProject(); });
  afterEach(() => { try { rmSync(projectDir, { recursive: true, force: true }); } catch {} });

  it("isStyleLocked returns false when no lock exists", () => {
    expect(isStyleLocked(projectDir)).toBe(false);
  });

  it("getStyleLock returns null when no lock exists", () => {
    expect(getStyleLock(projectDir)).toBeNull();
  });

  it("getStyleReferencePath returns null when no reference exists", () => {
    expect(getStyleReferencePath(projectDir)).toBeNull();
  });

  it("lockStyle creates config and copies reference image", () => {
    const imgPath = makeTestImage(projectDir);
    lockStyle(projectDir, { ...baseConfig }, imgPath);

    expect(isStyleLocked(projectDir)).toBe(true);

    const config = getStyleLock(projectDir);
    expect(config).not.toBeNull();
    expect(config!.checkpoint).toBe("sd_xl_base_1.0.safetensors");
    expect(config!.preset).toBe("pixel_sprite");
    expect(config!.ip_adapter_weight).toBe(0.75);
    expect(config!.reference_image).toContain("style-reference.png");
  });

  it("reference image is copied to .swe/art/", () => {
    const imgPath = makeTestImage(projectDir);
    lockStyle(projectDir, { ...baseConfig }, imgPath);

    const refPath = getStyleReferencePath(projectDir);
    expect(refPath).not.toBeNull();
    expect(existsSync(refPath!)).toBe(true);
    expect(readFileSync(refPath!, "utf-8")).toBe("fake-png-data");
  });

  it("unlockStyle removes lock and reference", () => {
    const imgPath = makeTestImage(projectDir);
    lockStyle(projectDir, { ...baseConfig }, imgPath);
    expect(isStyleLocked(projectDir)).toBe(true);

    unlockStyle(projectDir);
    expect(isStyleLocked(projectDir)).toBe(false);
    expect(getStyleLock(projectDir)).toBeNull();
    expect(getStyleReferencePath(projectDir)).toBeNull();
  });

  it("lockStyle overwrites previous lock", () => {
    const img1 = makeTestImage(projectDir);
    lockStyle(projectDir, { ...baseConfig, preset: "first" }, img1);

    const img2 = join(projectDir, "test-ref-2.png");
    writeFileSync(img2, "second-image");
    lockStyle(projectDir, { ...baseConfig, preset: "second" }, img2);

    const config = getStyleLock(projectDir);
    expect(config!.preset).toBe("second");
    expect(readFileSync(getStyleReferencePath(projectDir)!, "utf-8")).toBe("second-image");
  });

  it("unlockStyle is idempotent", () => {
    unlockStyle(projectDir); // no lock exists — should not throw
    expect(isStyleLocked(projectDir)).toBe(false);
  });

  it("preserves post_process config", () => {
    const imgPath = makeTestImage(projectDir);
    lockStyle(projectDir, {
      ...baseConfig,
      post_process: { targetWidth: 64, targetHeight: 64, stripMetadata: true, nearestNeighbor: true },
    }, imgPath);

    const config = getStyleLock(projectDir);
    expect(config!.post_process).toEqual({
      targetWidth: 64,
      targetHeight: 64,
      stripMetadata: true,
      nearestNeighbor: true,
    });
  });
});
