# Voice Pipeline

The voice endpoint provides a speech-to-speech interface for an ESP32/M5 StickC device. It's a general-purpose voice assistant, not tied to the issue pipeline.

## Sequence

```mermaid
sequenceDiagram
    participant ESP32 as ESP32 / Device
    participant Server as Voice Endpoint
    participant STT as Whisper (CPU)
    participant LLM as LLM Machine (GPU)
    participant TTS as Piper (CPU)

    ESP32->>Server: POST /api/voice (raw PCM)
    Server->>STT: PCM → WAV → /inference
    STT-->>Server: "Hello, what's the status?"

    Server->>LLM: Chat with session history
    Note over Server,LLM: Streams text sentence by sentence

    loop Each sentence
        LLM-->>Server: "Everything looks good."
        Server->>TTS: Text → /piper --output_raw
        TTS-->>Server: WAV audio
        Server-->>ESP32: Chunked WAV (plays immediately)
    end
```

## Architecture

| Component | Runs On | Purpose |
|-----------|---------|---------|
| Whisper.cpp | CPU (server) | Speech-to-text — systemd service on port 8080 |
| LLM | GPU (llama.cpp machine) | Text generation — shared with pipeline |
| Piper | CPU (server, CLI) | Text-to-speech — spawned per sentence |

## Audio Format

- **Input**: Raw 16-bit signed PCM, mono, 16kHz, little-endian
- **Output**: WAV per sentence (chunked transfer for streaming playback)

## Session Management

- Sessions tracked in-memory via `X-Session-Id` header
- Multi-turn conversation history maintained per session
- Auto-expire after 30 minutes of inactivity
- Max 50 messages per session (oldest trimmed)
- Concurrent request protection per session

## Configuration (env vars)

| Variable | Purpose |
|----------|---------|
| `STT_URL` | Whisper server URL |
| `VOICE_LLM_URL` | LLM server URL |
| `VOICE_MODEL_ID` | Model ID on the LLM server |
| `PIPER_PATH` | Path to piper executable |
| `PIPER_MODEL` | Path to .onnx voice model |
| `VOICE_SYSTEM_PROMPT` | Custom personality prompt |
