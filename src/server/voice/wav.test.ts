import { pcmToWav, wavToPcm } from "./wav";

describe("pcmToWav", () => {
  it("creates a valid WAV header", () => {
    const pcm = Buffer.alloc(100);
    const wav = pcmToWav(pcm, 16000, 1, 16);

    expect(wav.length).toBe(144); // 44 header + 100 data
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    // Sample rate at offset 24
    expect(wav.readUInt32LE(24)).toBe(16000);
    // Channels at offset 22
    expect(wav.readUInt16LE(22)).toBe(1);
    // Bit depth at offset 34
    expect(wav.readUInt16LE(34)).toBe(16);
    // Data size at offset 40
    expect(wav.readUInt32LE(40)).toBe(100);
  });

  it("handles different sample rates and channels", () => {
    const pcm = Buffer.alloc(200);
    const wav = pcmToWav(pcm, 44100, 2, 16);

    expect(wav.readUInt32LE(24)).toBe(44100);
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.readUInt32LE(40)).toBe(200);
  });
});

describe("wavToPcm", () => {
  it("round-trips through pcmToWav", () => {
    const original = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const wav = pcmToWav(original, 22050, 1, 16);
    const { pcm, sampleRate, channels, bitDepth } = wavToPcm(wav);

    expect(pcm).toEqual(original);
    expect(sampleRate).toBe(22050);
    expect(channels).toBe(1);
    expect(bitDepth).toBe(16);
  });

  it("treats non-RIFF data as raw PCM", () => {
    const raw = Buffer.from([10, 20, 30, 40]);
    const { pcm, sampleRate } = wavToPcm(raw);

    expect(pcm).toEqual(raw);
    expect(sampleRate).toBe(16000); // default assumption
  });

  it("handles empty PCM", () => {
    const wav = pcmToWav(Buffer.alloc(0), 16000);
    const { pcm } = wavToPcm(wav);
    expect(pcm.length).toBe(0);
  });
});
