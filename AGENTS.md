# AGENTS.md — Open SWE

## What This Is

An autonomous software engineering orchestration system. It takes high-level directives ("build a game"), decomposes them into milestones and tasks, dispatches work to AI agents on separate machines, handles code review, and generates art/music/SFX assets via ComfyUI — all with human oversight at configurable gates.

It operates at two levels:

1. **Director + Foreman** (primary): High-level directives decomposed into milestones and tasks, dispatched to inference and ComfyUI machines for code + art + music + SFX generation, with human-in-the-loop review gates.
2. **Issues Pipeline** (single-issue): Scout → implement → build/test gates → review (11 lenses) → GitOps for standalone issues.

## How To Run

```bash
npm install
npm run dev          # Express server (:3001) + Vite frontend (:5173)
npm run dev:server   # server only
npm run dev:dashboard # frontend only
npm run build        # Production build
npm test             # Jest test suite
npx tsc --noEmit     # Type check
```

The Vite dev server proxies `/api` to `localhost:3001`.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Frontend (React, Vite)     :5173 (dev) / static (prod) │
│  Dashboard, Director, Foreman, Terminal, Asset Preview  │
└──────────────────────┬──────────────────────────────────┘
                       │ /api/*
┌──────────────────────▼──────────────────────────────────┐
│  Express Server                              :3001      │
│  ├─ /api/*           CRUD + pipeline control            │
│  ├─ /api/director/*  Directives, conversations, reviews │
│  ├─ /api/foreman/*   Task queue, config, asset preview  │
│  ├─ /api/planner/*   Interactive issue planning         │
│  ├─ /ws/terminal     PTY WebSocket (Claude CLI)         │
│  └─ SSE /api/console Log streaming                      │
├─────────────────────────────────────────────────────────┤
│  Logical Models      First-class entities (models.ts)   │
│  ├─ models           Logical model registry             │
│  ├─ machine_models   Bindings: machine ↔ model + provider_id │
│  ├─ Director slot    foreman_config.director_model_id   │
│  └─ Foreman code slot foreman_config.foreman_code_model_id │
├─────────────────────────────────────────────────────────┤
│  Machine Manager     Lease-based access control         │
│  ├─ Director lease   Conversation, planning, verify     │
│  ├─ Foreman lease    Task execution                     │
│  ├─ Issues lease     Full issues pipeline               │
│  └─ withLlmSession   Public dispatch (llm-dispatch.ts)  │
├─────────────────────────────────────────────────────────┤
│  Director            High-level autonomy                │
│  ├─ Conversation     Chat with user, research, plan     │
│  ├─ Decomposer       Extract design doc + milestones    │
│  ├─ Planner          Generate task batches per milestone│
│  ├─ Verifier         LLM review of completed tasks      │
│  ├─ Memory           .swe/ persistent knowledge         │
│  └─ MemSearch        Semantic search via memsearch CLI  │
├─────────────────────────────────────────────────────────┤
│  Foreman             Task-level execution               │
│  ├─ Scheduler        Event-driven dispatch              │
│  ├─ Executor         LLM agent in git worktree          │
│  ├─ ComfyUI Executor Preset/template workflow dispatch  │
│  ├─ Validator        Acceptance criteria checks         │
│  ├─ Art Feedback     LLM-revised prompts on rejection   │
│  └─ Routing          Task type → machine type mapping   │
├─────────────────────────────────────────────────────────┤
│  Issues Pipeline     Multi-stage issue processing       │
│  ├─ Scout → Implement → Build → Test → Review → GitOps  │
│  └─ Review caching   Shared context across lenses       │
├─────────────────────────────────────────────────────────┤
│  Infrastructure                                         │
│  ├─ SQLite (WAL)     Single DB, Drizzle ORM             │
│  ├─ Git              Worktree isolation, PR creation    │
│  └─ Stats            Token speed, machine utilization   │
└─────────────────────────────────────────────────────────┘

  Machines:
  ├─ Inference (Ollama/OpenRouter/llama.cpp) → code tasks (logical-model dispatch)
  ├─ ComfyUI (ROCm/CUDA)                     → art/music/sfx (preset dispatch)
  └─ NPU (small fast models)                 → light helpers (withLightLlmSession)
```

## Director Flow

1. User creates **Directive** → conversation phase (LLM chat with research tools)
2. User approves plan → **Decomposition** (design doc + milestones)
3. For each milestone → **Planner** generates 1-5 tasks (mixed code + art)
4. **Foreman** dispatches tasks to machines by type
5. Tasks execute in isolated git worktrees (code) or via ComfyUI API (art)
6. **Verification** → auto-review (code) or human review (art)
7. On completion → next milestone. Idle machine types trigger top-up planning.

## Key Directories

```
src/server/
├── director/           # High-level autonomy
│   ├── scheduler.ts    # Event-driven directive processing
│   ├── planner.ts      # Task generation with LLM
│   ├── conversation.ts # Streaming LLM chat
│   ├── verifier.ts     # Task/milestone verification
│   ├── memory.ts       # Context assembly
│   ├── persistent-memory.ts  # .swe/ file management
│   ├── memsearch.ts    # Semantic search integration
│   ├── art-task-processor.ts # Inject ComfyUI tags
│   └── episodic-extractor.ts # Extract patterns before pruning
├── foreman/            # Task execution
│   ├── scheduler.ts    # Dispatch loop
│   ├── executor.ts     # LLM agent runner
│   ├── comfyui-executor.ts   # ComfyUI task handler
│   ├── comfyui-workflows.ts  # Programmatic workflow builders
│   ├── comfyui.ts      # ComfyUI REST client
│   ├── art-feedback.ts # LLM-revised prompts on rejection
│   ├── routing.ts      # Task type → machine type
│   └── validator.ts    # Acceptance criteria
├── pipeline/           # Multi-stage issue pipeline
│   ├── nodes.ts        # Scout, implement, review, gitops
│   └── run-stage.ts    # Shared LLM executor
├── prompts/            # All LLM prompts
│   ├── review.ts       # Cache-friendly review structure
│   └── lenses.ts       # 11 review focus areas
├── tools/              # Agent tool definitions
│   ├── filesystem.ts   # Read/write/search/run
│   ├── web-search.ts   # DuckDuckGo search
│   ├── fetch.ts        # URL fetcher
│   └── context7.ts     # Library docs lookup
├── machine-manager.ts  # Centralized lease system + acquireLease/strictPreferred
├── models.ts           # Logical models: CRUD, resolveInferenceCandidates, resolveLightNpuExecution
├── llm-dispatch.ts     # PUBLIC dispatch: withLlmSession / withLightLlmSession / withLightOrFallbackLlmSession
├── llm.ts              # AI SDK wrapper: instantiateLlm(execution), warmUpLlm
├── terminal.ts         # PTY WebSocket for Claude CLI
├── schema.ts           # Drizzle ORM (SQLite)
├── db.ts               # Database + migrations (incl. logical-models refactor)
├── api.ts              # Express routes (incl. /api/models, /api/machines/:id/bindings)
├── stats.ts            # Token speed tracking
└── git.ts              # Worktree, commit, PR operations

src/frontend/
├── Dashboard.tsx       # Main layout + view routing
├── Sidebar.tsx         # Navigation, stats, toggles
├── ModelsPage.tsx      # Logical-model registry (CRUD + bindings overview)
├── DirectorDashboard.tsx    # Directive list
├── DirectorConversation.tsx # Chat UI with retry
├── ForemanDashboard.tsx     # Task queue
├── ForemanTaskDetail.tsx    # Task detail + asset preview
├── ForemanConfig.tsx        # Scheduler config + Director/Foreman model slot pickers
├── MachineDetail.tsx        # Machine settings + MachineBindings sub-component
├── Terminal.tsx        # xterm.js Claude CLI
└── api.ts              # Frontend API client
```

## File Reference

### Backend (src/server/)

| File | Purpose |
|------|---------|
| `index.ts` | Express app entry point. Initializes DB, mounts routes, graceful shutdown. |
| `orchestrator.ts` | Single entry point for all background services. Manages startup/shutdown ordering for Machine Manager, Stats, Analysis, Director, Foreman. |
| `machine-manager.ts` | Lease-based machine access control with priority queuing and auto-expiry. |
| `llm.ts` | Unified LLM client with resilient fetch, retry logic, stream inactivity detection, prompt caching hints. |
| `llm-dispatch.ts` | PUBLIC dispatch: `withLlmSession` / `withLightLlmSession` / `withLightOrFallbackLlmSession`. The only legal entry points for LLM calls. |
| `models.ts` | Logical model resolver: CRUD, `resolveInferenceCandidates`, `resolveLightNpuExecution`. |
| `schema.ts` | Drizzle ORM table definitions — single source of truth for the DB schema. |
| `db.ts` | Database class wrapping Drizzle + better-sqlite3. WAL mode. Auto-migration via ALTER TABLE in `migrate()`. |
| `api.ts` | Express routes (~40+ endpoints). CRUD for projects/machines/issues/models, director/foreman/planner APIs, analysis, stats, console SSE. |
| `git.ts` | Git operations: worktree lifecycle, commit, push, PR creation/merge (GitHub + Gitea). |
| `git-helpers.ts` | Synchronous git utilities: getHeadCommit, isDirty, getDiff, etc. |
| `stats.ts` | Token speed tracking and performance metrics. |
| `analysis.ts` | Multi-stage automated codebase analysis with per-lens frequency tracking. |
| `terminal.ts` | PTY WebSocket for Claude CLI access (xterm.js frontend). |
| `console-log.ts` | Console log aggregation for SSE streaming to frontend. |
| `runner.ts` | Single-agent executor for pipeline issues. Creates worktree → agent → commit → push → PR. |

### Director (src/server/director/)

| File | Purpose |
|------|---------|
| `scheduler.ts` | Event-driven directive processing loop. |
| `conversation.ts` | Multi-turn LLM chat with user. |
| `decomposer.ts` | Design doc + milestone generation. |
| `planner.ts` | Task batch generation per milestone. |
| `verifier.ts` | Task/milestone completion verification. |
| `review-gates.ts` | Human-in-the-loop escalation based on autonomy level. |
| `memory.ts` / `memory-context.ts` | Context assembly from `.swe/` directory. |
| `persistent-memory.ts` | `.swe/` file management. |
| `memsearch.ts` | Semantic search via `memsearch` CLI + memory write validators. |
| `episodic-extractor.ts` | Extract patterns before pruning episodic logs. |
| `task-knowledge-extractor.ts` | Post-task learning — extracts conventions, patterns, gotchas. |
| `style-lock.ts` | Lock approved art style (checkpoint, preset, prompt prefix, reference image). |
| `style-exploration.ts` | Generate style exploration tasks with varied prompts. |
| `art-task-processor.ts` | Inject ComfyUI tags into art task descriptions. |
| `unattributed-commits.ts` | Detect manual/external commits not linked to foreman tasks. |

### Foreman (src/server/foreman/)

| File | Purpose |
|------|---------|
| `scheduler.ts` | Event-driven task dispatch with backoff. |
| `executor.ts` | LLM agent runner in git worktree. |
| `task-types.ts` | Task type → machine type routing (inference vs comfyui). |
| `task-lifecycle.ts` | Task state machine management. |
| `routing.ts` | Model/machine selection logic. |
| `comfyui.ts` | ComfyUI REST client. |
| `comfyui-executor.ts` | ComfyUI task execution handler. |
| `comfyui-workflows.ts` | Programmatic workflow builders. |
| `comfyui-bootstrap.ts` | ComfyUI initialization and model discovery. |
| `comfyui-schema.ts` | ComfyUI schema/type definitions. |
| `circuit-breaker.ts` | Per-machine fault tolerance (closed → open → half-open). |
| `art-feedback.ts` | LLM-revised prompts on art rejection. |
| `asset-archive.ts` | Preserve generated assets across iterations. |
| `validator.ts` | Acceptance criteria checking. |
| `cleanup.ts` | Stale worktree cleanup on startup. |

### Tools (src/server/tools/)

| File | Purpose |
|------|---------|
| `filesystem.ts` | Agent filesystem tools: readFile, writeFile, replaceInFile, searchFiles, runCommand, etc. |
| `web-search.ts` | DuckDuckGo web search. |
| `fetch.ts` | URL fetcher with timeout, size limit, HTML stripping. |
| `context7.ts` | Library documentation lookup via Context7. |
| `build-check.ts` | Build/test execution tools + gated submit. |
| `package-check.ts` | Dependency presence checks. |
| `context-budget.ts` | Token budget tracking for tool outputs. |
| `task-query.ts` | Task database queries. |
| `story-context.ts` | Story/issue context extraction. |

### Frontend (src/frontend/)

| File | Purpose |
|------|---------|
| `Dashboard.tsx` | Main layout + view routing. |
| `DashboardLanding.tsx` | Landing page with machine activity panel. |
| `ProjectOverview.tsx` | Project overview with status summary, active work, recent activity. |
| `Sidebar.tsx` | Navigation, stats, toggles. |
| `ModelsPage.tsx` | Logical-model registry (CRUD + bindings overview). |
| `DirectorDashboard.tsx` | Directive list + machine selector. |
| `DirectorDetail.tsx` | Directive detail view. |
| `DirectorConversation.tsx` | Chat UI with retry. |
| `DirectorReview.tsx` | Review gate UI for human decisions. |
| `ForemanDashboard.tsx` | Task queue overview. |
| `ForemanTaskDetail.tsx` | Task detail + asset preview. |
| `ForemanConfig.tsx` | Scheduler config + Director/Foreman model slot pickers. |
| `MachineDetail.tsx` | Machine settings + MachineBindings sub-component. |
| `IssueList.tsx` | Issue table with status filter tabs. |
| `IssueDetail.tsx` | Issue detail with live agent output. |
| `AnalysisView.tsx` | Analysis results. |
| `LlmLogs.tsx` | LLM request logs/analytics. |
| `Terminal.tsx` | xterm.js Claude CLI. |
| `Planner.tsx` | Epic/issue planning UI. |
| `ManualCommits.tsx` | Unattributed commit review + knowledge extraction. |
| `PrDiffView.tsx` | PR diff viewer. |

## Database

SQLite with WAL mode. Drizzle ORM for schema, raw SQL for complex queries.
Migrations in `db.ts` `migrate()` method — add `ALTER TABLE` statements there.

Key tables: `projects`, `machines`, `models`, `machine_models`, `issues`, `runs`, `llm_requests`, `foreman_tasks`, `foreman_runs`, `foreman_config`, `director_directives`, `director_milestones`, `director_reviews`, `director_conversations`, `director_messages`, `planner_conversations`, `planner_messages`, `analysis_configs`, `analysis_runs`.

The logical-models refactor introduced a one-shot, gated, transactional rebuild
migration in `migrateLogicalModelsRefactor()`. It creates the `models` table,
backfills logical models from existing provider strings, and rebuilds
`machines`, `projects`, `foreman_config`, `foreman_tasks`, and `machine_models`
to drop dead columns and enforce FK constraints. The migration is idempotent
via a column-existence gate (`machine_models.provider_id`).

## Logical Models

A `model` (e.g. "Qwen3 Coder 30B") is a first-class entity decoupled from any
machine. A `binding` (`machine_models` row) connects a logical model to a
machine and supplies the per-machine `provider_id` (the literal string passed
to the AI SDK on that host). The same logical model can be hosted on multiple
machines with different provider strings.

**Two configured slots** in `foreman_config`:
- `director_model_id` — used by Director conversation/planner/verifier,
  issue decomposition, planner-api, and analysis runs
- `foreman_code_model_id` — used by Foreman code task executor, pipeline runs,
  and pipeline stages
- `director_machine_id` — optional preferred-machine hint for the Director slot
  (when the Director model is hosted on multiple machines)

**Per-task override:** `foreman_tasks.model_id` (FK to `models.id`, nullable).
NULL = use the Foreman code slot default.

**Resolution flow** (everyone goes through `src/server/llm-dispatch.ts` —
`models.ts` is the resolver, `llm-dispatch.ts` is the public dispatch entry).
There are exactly THREE entry points and you should never need anything else:

```ts
// Logical model dispatch (Director slot, Foreman code slot, per-task override).
// Resolves the model, picks a candidate machine, acquires the lease, releases
// colocated GPUs, warms up, builds the SDK provider, runs your callback, and
// releases on every exit path. Returns null if no machine has capacity.
const result = await withLlmSession(
  db, "foreman", taskLabel, modelId,
  async (session) => {
    // session.llm           — instantiated LLM model
    // session.machine       — the chosen machine
    // session.providerModelId
    // session.effectiveContextLimit
    return await generate(session.llm, { system, prompt });
  },
  { preferMachineId: optionalHint },  // optional preferred-machine hint
);

// NPU lightweight pathway. Used for episodic extraction, task-knowledge
// extraction, art prompt revision, etc. Returns null if no NPU machine exists.
const result = await withLightLlmSession(
  db, "director", label,
  async (session) => { ... },
);

// NPU first, fall back to a logical model if no NPU machine exists. Use this
// for lightweight workloads that should still run when the user has no NPU.
const result = await withLightOrFallbackLlmSession(
  db, "director", label, fallbackModelId,
  async (session) => { ... },
);
```

`withLlmSession` throws `ModelNotFoundError`, `NoMachineHostsModelError`, or
`ModelSlotUnconfiguredError` for terminal failures (caller should mark the
work failed) and returns `null` when all hosting machines are temporarily at
capacity (caller should defer and retry later).

**Effective context limit** = `min(machine.context_limit, binding.context_limit, model.default_context_limit)` — the smallest non-null value wins.

**NPU pathway** (lightweight helpers — episodic extractor, task knowledge
extractor, art prompt revision, art style exploration) is **not** managed by
the slot system. The dispatch helpers above (`withLightLlmSession` /
`withLightOrFallbackLlmSession`) handle it. Internally they call
`resolveLightNpuExecution(db)`, which picks any enabled NPU machine's first
enabled binding (sorted by binding `created_at` for determinism). NPU
machines are excluded from the inference resolver.

**ComfyUI dispatch** (art/music/sfx tasks) is also untouched by this layer — it
uses the preset/workflow system in `foreman/comfyui-*.ts`.

## Machine Manager

All machine access goes through `machine-manager.ts`. Most consumers should
use `withLlmSession` / `withLightLlmSession` from `llm-dispatch.ts` instead of
calling the machine manager directly. The lower-level helpers are:

- `acquireLease(db, consumer, label, { preferredMachineId, strictPreferred, machineType })`
  — used by `withLlmSession` and by ComfyUI dispatch (`machineType: "comfyui"`).
- `releaseLease(leaseId)` in finally block.
- Leases expire automatically (10min director idle, 30min foreman, 60min pipeline, 10min analysis).
- Leases auto-renew on activity (per-step in agent loops) and abort the
  in-flight stream on expiry via `setLeaseOnExpiry`.
- `hasCapacity(machine)` respects `max_concurrent`.
- `strictPreferred: true` disables type-based fallback when a specific machine
  is required (used internally by `withLlmSession` to guarantee the chosen
  machine hosts the requested logical model).

## Memory System (.swe/)

```
<project>/.swe/
├── memory/
│   ├── episodic/     # Auto-generated daily activity logs
│   └── semantic/     # Stable knowledge (agent-written)
├── conventions/
│   ├── *.md          # Project rules (highest priority in context)
│   ├── procedural/   # How-to workflows
│   └── snapshots/    # Pre-prune backups
└── comfyui-workflows/
    └── manifest.json # Auto-generated from installed models
```

- Conventions + procedural always injected into Director context
- Semantic + episodic searched via memsearch (not dumped)
- Episodic logs auto-pruned at 30 days (patterns extracted first via LLM)
- `.swe/` auto-added to `.gitignore`
- Director has tools: searchMemory, writeSemanticMemory, writeConvention, writeProcedure, editMemory, deleteMemory, listMemories, readMemoryFile
- Memory writes are validated against junk filename / body marker patterns to
  prevent ephemeral content from polluting persistent memory.

## ComfyUI Integration

Art/music/sfx tasks route to ComfyUI machines via presets:

| Preset       | Model                      | Use                      |
|--------------|----------------------------|--------------------------|
| pixel_sprite | SDXL + pixel-art-xl LoRA   | Sprites, icons           |
| background   | SDXL                       | Game backgrounds         |
| portrait     | SDXL                       | Character art            |
| concept      | FLUX.2-dev                 | High quality concept art |
| game_asset   | SDXL + game_assets_v3 LoRA | Items, props             |
| fast_draft   | Z-Image-Turbo (8 steps)    | Quick previews           |
| music        | ACE-Step 1.5               | Background music         |
| sfx          | AudioGen                   | Sound effects            |

Art tasks skip automated verification → go straight to human review.
On rejection, user feedback is processed by an LLM to intelligently revise the prompt.

## Review System

Reviews use a cache-friendly three-part prompt:
1. **System prompt** — identical across all lenses (cached)
2. **Shared context** — git diff, project files, prior outputs (cached)
3. **Lens prompt** — lens-specific instructions (only this changes)

This gives ~77% token savings on multi-lens reviews.

11 lenses: general, security, ui, performance, testing, error_handling, react, typescript, node, express, sqlite.

## Sandbox (Linux + bubblewrap)

Optional per-subprocess isolation gated by `foreman_config.sandbox_enabled`.
When enabled on Linux with `bubblewrap` installed, every agent-spawned
subprocess runs in an isolated namespace with:

- RW bind of the worktree (RO for scout / review / verify stages)
- RO bind of the project's `.git` directory (so git worktrees resolve)
- RO bind of `/usr`, `/bin`, `/lib`, `/etc/ssl`, `/snap`, etc.
- Tmpfs `/tmp` and per-task tmpfs `$HOME`
- Per-project persistent caches under `~/.swe-cache/<project_id>/`
- Per-stage network policy (implement/test-write get net; scout/review/verify don't)
- Fresh PID/IPC/UTS namespaces

The orchestrator itself is **not** sandboxed — only subprocesses spawned from
inside agent execution paths. The bwrap wrapper transparently falls through
to direct spawn on non-Linux hosts or when bwrap is missing. See
`src/server/util/sandbox.ts` and `docs/sandbox-smoke.md`.

## Key Patterns

- **Two-phase startup**: Orchestrator starts Director first, gates Foreman until Director's first tick completes.
- **Lease-based access**: All machine access via Machine Manager with priority queue, auto-renewal, and auto-expiry.
- **Circuit breakers**: Per-machine fault tolerance prevents repeated dispatch to failing machines.
- **Event-driven scheduling**: Nudge pattern — no polling timers, schedulers wake on state changes.
- **Line ending normalization**: All file-reading tools normalize `\r\n` → `\n` for Windows compat.
- **Shell safety**: `shell: false` in spawn calls prevents injection. Commit messages piped via stdin.
- **Context budget**: Tracks chars consumed by tool results. Truncates large outputs as budget fills.
- **Crash recovery**: Orchestrator clears leases and stale worktrees on startup. The Issues Pipeline resets stuck machines/runs/issues.
- **Structured live output**: Runner saves `liveSteps[]` JSON to run.output. Frontend polls and renders.
- **Task knowledge extraction**: Post-completion LLM analysis extracts reusable patterns → `.swe/semantic/`.

## Code Conventions

- TypeScript, strict mode. All files use `.ts` / `.tsx`.
- AI SDK (`ai` package) for all LLM calls — `streamText`, `generateText`, `tool()`.
- LLM dispatch always goes through `llm-dispatch.ts` (`withLlmSession`,
  `withLightLlmSession`, `withLightOrFallbackLlmSession`) — these are the only
  public entry points. They internally handle resolution via `models.ts`,
  lease acquisition, colocation release, warmup, and provider construction.
  Do not call `acquireLease`, `instantiateLlm`, `warmUpLlm`, or
  `resolveInferenceCandidates` directly from feature code.
- Zod for tool parameter schemas.
- Server types inferred from Drizzle schema (`$inferSelect`), not hand-written.
- Express routes with explicit error handling.
- Git worktrees for task isolation.
- Event-driven scheduling (nudge pattern, no polling timers).
- `shell: false` in spawn calls — prevents injection and special char issues.
- Database migrations go in `Db.migrate()` as try/catch ALTER TABLE statements.
- Tests use `:memory:` SQLite and temp directories.

## Testing

Jest, 880+ tests across 52 suites. Run with `npx jest`.
Tests use in-memory SQLite databases and temp directories. Test files are
excluded from `tsc` (per `tsconfig.json`); they're type-checked by ts-jest at
test runtime, which is more lenient about excess properties on object literals.

## What NOT To Do

- Don't add migrations by modifying the schema alone — add ALTER TABLE to `db.ts` `migrate()`.
- Don't bypass `llm-dispatch.ts` for LLM calls — always use `withLlmSession`,
  `withLightLlmSession`, or `withLightOrFallbackLlmSession`. They handle lease
  acquisition, colocation release, warmup, provider construction, and
  guaranteed cleanup. Calling `acquireLease` / `instantiateLlm` / `warmUpLlm`
  directly from feature code is how leaked leases happen.
- Don't read provider strings from machine fields (`machines.model_id` no longer
  exists). Resolution happens inside `withLlmSession` via `resolveInferenceCandidates` —
  feature code never needs to know about provider strings or bindings directly.
- Don't make the Director write project files — it has read-only filesystem access.
- Don't skip `shell: false` in spawn calls — prevents injection and special char issues.
- Don't add `shell: true` to memsearch or other subprocess calls.
