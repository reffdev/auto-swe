/**
 * PCM ↔ WAV conversion helpers.
 * WAV header is 44 bytes, standard RIFF/WAVE format.
 */

export function pcmToWav(
  pcm: Buffer,
  sampleRate: number,
  channels = 1,
  bitDepth = 16
): Buffer {
  const byteRate = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);

  // RIFF header
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);

  // fmt sub-chunk
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);          // sub-chunk size
  header.writeUInt16LE(1, 20);           // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);

  // data sub-chunk
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

export function wavToPcm(wav: Buffer): { pcm: Buffer; sampleRate: number; channels: number; bitDepth: number } {
  // Verify RIFF header
  const riff = wav.toString("ascii", 0, 4);
  if (riff !== "RIFF") {
    // No WAV header — assume raw PCM
    return { pcm: wav, sampleRate: 16000, channels: 1, bitDepth: 16 };
  }

  // Parse fmt chunk
  const sampleRate = wav.readUInt32LE(24);
  const channels = wav.readUInt16LE(22);
  const bitDepth = wav.readUInt16LE(34);

  // Find data chunk (may not be at offset 36 if there are extra chunks)
  let offset = 12;
  while (offset < wav.length - 8) {
    const chunkId = wav.toString("ascii", offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      return { pcm: wav.subarray(offset + 8, offset + 8 + chunkSize), sampleRate, channels, bitDepth };
    }
    offset += 8 + chunkSize;
  }

  // Fallback: skip the standard 44-byte header
  return { pcm: wav.subarray(44), sampleRate, channels, bitDepth };
}
