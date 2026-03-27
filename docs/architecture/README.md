# Architecture Documentation

Documentation for the Open-SWE autonomous software engineering system.

## Contents

0. **[How It Works](00-how-it-works.md)** — Start here. The big picture: from idea to PR, what makes this different, and how agents are controlled.
1. **[System Overview](01-system-overview.md)** — High-level architecture: frontend, API, pipeline, external services
2. **[Pipeline Stages](02-pipeline-stages.md)** — Scout → Implement → Build Gate → Test-Write → Test Gate → Review → GitOps, tools per stage
3. **[Review Lenses](03-review-lenses.md)** — Focused review passes: general, security, UI, performance, testing, error handling
4. **[Issue Lifecycle](04-issue-lifecycle.md)** — From idea to merged PR: planning, epics, statuses, decomposition
5. **[Data Model](05-data-model.md)** — Database tables, relationships, and key fields
6. **[Voice Pipeline](06-voice-pipeline.md)** — Speech-to-speech interface: Whisper STT → LLM → Piper TTS
7. **[Resilience](07-resilience.md)** — Timeouts, cancel, crash recovery, build/test gates, coding guardrails
8. **[Agent Harness](08-agent-harness.md)** — How the harness runs agents: tool provisioning, prompt strategy, data flow, isolation, error handling

## Quick Start Concepts

**Issue** — A unit of work. Can be standalone, an epic (container), or a story (child of epic).

**Pipeline** — Automated flow: research → implement → build gate → write tests → test gate → review lenses → create PR.

**Build/Test Gates** — Server-side checks between stages. Run the project's configured build/test commands. On failure, send errors back to the implementer automatically.

**Machine** — An LLM server endpoint (llama.cpp). Machines are assigned to issues one at a time.

**Review Lens** — A focused review pass. Each lens checks the implementation through a specific concern (security, UI, etc.). Multiple lenses run sequentially.

**Planner** — Interactive AI conversation that helps refine vague ideas into structured issue specifications.

**Scout** — First pipeline stage. Explores the codebase and produces a file manifest for the implementer.

**Epic** — An issue broken into ordered stories with dependency tracking via `depends_on`.
