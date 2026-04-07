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

  it("isStyleLocked returns false when no lock exists", async () => {
    expect(await isStyleLocked(projectDir)).toBe(false);
  });

  it("getStyleLock returns null when no lock exists", async () => {
    expect(await getStyleLock(projectDir)).toBeNull();
  });

  it("getStyleReferencePath returns null when no reference exists", async () => {
    expect(await getStyleReferencePath(projectDir)).toBeNull();
  });

  it("lockStyle creates config and copies reference image", async () => {
    const imgPath = makeTestImage(projectDir);
    await lockStyle(projectDir, { ...baseConfig }, imgPath);

    expect(await isStyleLocked(projectDir)).toBe(true);

    const config = await getStyleLock(projectDir);
    expect(config).not.toBeNull();
    expect(config!.checkpoint).toBe("sd_xl_base_1.0.safetensors");
    expect(config!.preset).toBe("pixel_sprite");
    expect(config!.ip_adapter_weight).toBe(0.75);
    expect(config!.reference_image).toContain("style-reference.png");
  });

  it("reference image is copied to .swe/art/", async () => {
    const imgPath = makeTestImage(projectDir);
    await lockStyle(projectDir, { ...baseConfig }, imgPath);

    const refPath = await getStyleReferencePath(projectDir);
    expect(refPath).not.toBeNull();
    expect(existsSync(refPath!)).toBe(true);
    expect(readFileSync(refPath!, "utf-8")).toBe("fake-png-data");
  });

  it("unlockStyle removes lock and reference", async () => {
    const imgPath = makeTestImage(projectDir);
    await lockStyle(projectDir, { ...baseConfig }, imgPath);
    expect(await isStyleLocked(projectDir)).toBe(true);

    await unlockStyle(projectDir);
    expect(await isStyleLocked(projectDir)).toBe(false);
    expect(await getStyleLock(projectDir)).toBeNull();
    expect(await getStyleReferencePath(projectDir)).toBeNull();
  });

  it("lockStyle overwrites previous lock", async () => {
    const img1 = makeTestImage(projectDir);
    await lockStyle(projectDir, { ...baseConfig, preset: "first" }, img1);

    const img2 = join(projectDir, "test-ref-2.png");
    writeFileSync(img2, "second-image");
    await lockStyle(projectDir, { ...baseConfig, preset: "second" }, img2);

    const config = await getStyleLock(projectDir);
    expect(config!.preset).toBe("second");
    expect(readFileSync((await getStyleReferencePath(projectDir))!, "utf-8")).toBe("second-image");
  });

  it("unlockStyle is idempotent", async () => {
    await unlockStyle(projectDir); // no lock exists — should not throw
    expect(await isStyleLocked(projectDir)).toBe(false);
  });

  it("preserves post_process config", async () => {
    const imgPath = makeTestImage(projectDir);
    await lockStyle(projectDir, {
      ...baseConfig,
      post_process: { targetWidth: 64, targetHeight: 64, stripMetadata: true, nearestNeighbor: true },
    }, imgPath);

    const config = await getStyleLock(projectDir);
    expect(config!.post_process).toEqual({
      targetWidth: 64,
      targetHeight: 64,
      stripMetadata: true,
      nearestNeighbor: true,
    });
  });
});
