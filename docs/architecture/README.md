# Architecture Documentation

Documentation for the Open-SWE autonomous software engineering system.

> **Start with [CLAUDE.md](../../CLAUDE.md)** for the current system overview. These docs cover the architecture in detail.

## Contents

### System Architecture
0. **[How It Works](00-how-it-works.md)** — The big picture: two-level orchestration from directive to PR
1. **[System Overview](01-system-overview.md)** — Frontend, API, orchestrator, Director, Foreman, pipeline, infrastructure
2. **[Pipeline Stages](02-pipeline-stages.md)** — Scout → Implement → Build Gate → Test-Write → Test Gate → Review → GitOps
3. **[Review Lenses](03-review-lenses.md)** — 11 focused review passes (6 core + 5 stack-specific) with cache-friendly prompts
4. **[Issue & Directive Lifecycle](04-issue-lifecycle.md)** — Directives, milestones, foreman tasks, issues, review gates
5. **[Data Model](05-data-model.md)** — All database tables and relationships (20+ tables)
6. **[Voice Pipeline](06-voice-pipeline.md)** — Speech-to-speech: pluggable STT → LLM → TTS adapters
7. **[Resilience](07-resilience.md)** — Timeouts, crash recovery, circuit breakers, lease expiry, guardrails
8. **[Agent Harness](08-agent-harness.md)** — Tool provisioning, prompt strategy, isolation (pipeline + foreman)

## Quick Start Concepts

**Directive** — A high-level goal ("build a game"). The Director decomposes it into milestones and tasks via conversation, then orchestrates execution.

**Milestone** — A sequenced phase within a directive. Each milestone has verification criteria and generates 1–5 foreman tasks.

**Foreman Task** — A unit of work dispatched to a machine. Types: `code`, `art`, `music`, `sfx`, `style_exploration`, `review`, `content`, `claude`.

**Machine** — An LLM or ComfyUI server endpoint. Managed via the Machine Manager lease system with priority queuing.

**Machine Type** — `inference` (code/review/content/claude tasks via Ollama/OpenRouter) or `comfyui` (art/music/sfx/style_exploration via ComfyUI).

**Review Lens** — A focused review pass. 11 lenses available (6 core + 5 stack-specific). Reviews use a cache-friendly prompt structure for ~77% token savings across lenses.

**Review Gate** — A human-in-the-loop checkpoint. Gates pause directives for human decisions on task verification, design choices, milestone completion, failure escalation, and style selection. Behavior controlled by autonomy level (conservative/standard/aggressive).

**Pipeline** — Single-issue execution flow: scout → implement → build gate → test → review → PR. Used for standalone issues; Director+Foreman is the primary system for directives.

**Orchestrator** — Single entry point (`orchestrator.ts`) managing startup/shutdown of all background services: Machine Manager, Stats, Analysis, Director, Foreman.

**Memory** — `.swe/` directory with conventions (rules), semantic (knowledge), procedural (workflows), and episodic (auto-logged activity). Searched via memsearch CLI. Task knowledge auto-extracted after completion.

**Circuit Breaker** — Per-machine fault tolerance (closed → open → half-open). Prevents repeated dispatch to failing machines. Threshold: 3 failures, reset after 5 minutes.

**Style Lock** — Art style consistency system. After human approval of a style exploration, the selected style's checkpoint/preset/prompt prefix/reference image are locked for all future art tasks in the directive.
