# Architecture Documentation

Documentation for the Open-SWE autonomous software engineering system.

> **Start with [CLAUDE.md](../../CLAUDE.md)** for the current system overview. These docs cover the foundational architecture in detail.

## Contents

### Core Architecture (original pipeline system)
0. **[How It Works](00-how-it-works.md)** — The big picture: from idea to PR, how agents are controlled
1. **[System Overview](01-system-overview.md)** — Frontend, API, pipeline, external services
2. **[Pipeline Stages](02-pipeline-stages.md)** — Scout → Implement → Build Gate → Test-Write → Test Gate → Review → GitOps
3. **[Review Lenses](03-review-lenses.md)** — 11 focused review passes with cache-friendly prompt structure
4. **[Issue Lifecycle](04-issue-lifecycle.md)** — Planning, epics, statuses, decomposition
5. **[Data Model](05-data-model.md)** — Database tables and relationships
6. **[Voice Pipeline](06-voice-pipeline.md)** — Speech-to-speech: Whisper STT → LLM → Piper TTS
7. **[Resilience](07-resilience.md)** — Timeouts, crash recovery, gates, guardrails
8. **[Agent Harness](08-agent-harness.md)** — Tool provisioning, prompt strategy, isolation

### Systems added since original docs (see CLAUDE.md for details)
- **Director** — High-level autonomy: directives → milestones → task batches
- **Foreman** — Event-driven task dispatch with machine type routing
- **ComfyUI** — Art/music/SFX generation with presets, feedback, and human review
- **Machine Manager** — Lease-based access control replacing ad-hoc exclusion
- **Persistent Memory** — `.swe/` directory with episodic, semantic, procedural, conventions
- **MemSearch** — Semantic search over markdown memories via memsearch CLI
- **Web Terminal** — Claude CLI via PTY WebSocket (xterm.js frontend)

## Quick Start Concepts

**Directive** — A high-level goal ("build a game"). The Director decomposes it into milestones and tasks.

**Foreman Task** — A unit of work dispatched to a machine. Types: code, art, music, sfx, review, content.

**Machine** — An LLM or ComfyUI server endpoint. Managed via the Machine Manager lease system.

**Machine Type** — `inference` (code tasks via Ollama/OpenRouter) or `comfyui` (art/audio via ComfyUI).

**Review Lens** — A focused review pass. 11 lenses available. Reviews use cache-friendly prompt structure for ~77% token savings across lenses.

**Pipeline** — Original single-issue flow: scout → implement → build gate → test → review → PR. Still functional but Director+Foreman is the primary system.

**Memory** — `.swe/` directory with conventions (rules), semantic (knowledge), procedural (workflows), and episodic (auto-logged activity). Searched via memsearch.
