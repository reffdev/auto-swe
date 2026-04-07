# Auto-SWE (Open-SWE)

## What This Is

An autonomous software engineering orchestration system. It takes high-level directives ("build a game"), decomposes them into milestones and tasks, dispatches work to AI agents on separate machines, handles code review, and generates art/music/SFX assets via ComfyUI — all with human oversight at configurable gates.

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
│  ├─ Pipeline lease   Full issue pipeline                │
│  └─ acquireLeaseForModel  Dispatch by logical model     │
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
│  Pipeline            Multi-stage issue processing       │
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
  └─ NPU (small fast models)                 → light helpers (selectLightMachine)
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
├── models.ts           # Logical models: CRUD, resolver, acquireLeaseForModel
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

## Database

SQLite with WAL mode. Drizzle ORM for schema, raw SQL for complex queries.
Migrations in `db.ts` `migrate()` method — add `ALTER TABLE` statements there.

Key tables: `projects`, `machines`, `models`, `machine_models`, `issues`, `runs`, `llm_requests`, `foreman_tasks`, `foreman_runs`, `foreman_config`, `director_directives`, `director_milestones`, `director_reviews`, `director_conversations`, `director_messages`.

The logical-models refactor (see "Logical Models" below) introduced a one-shot,
gated, transactional rebuild migration in `migrateLogicalModelsRefactor()`. It
creates the `models` table, backfills logical models from existing provider
strings, and rebuilds `machines`, `projects`, `foreman_config`, `foreman_tasks`,
and `machine_models` to drop dead columns and enforce FK constraints. The
migration is idempotent via a column-existence gate (`machine_models.provider_id`).

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

**Resolution flow** (everyone goes through `src/server/models.ts`):
```ts
// Read the configured slot
const modelId = getForemanCodeModelId(db);  // throws ModelSlotUnconfiguredError if unset

// Acquire a lease + resolved execution in one call
const result = acquireLeaseForModel(db, "foreman", taskLabel, modelId);
// returns null if all hosting machines are at capacity (caller should defer)
// throws NoMachineHostsModelError if no enabled inference machine has an enabled binding

const { lease, execution } = result;
// execution.machine, execution.providerModelId, execution.effectiveContextLimit

// Talk to the model
const llm = instantiateLlm(execution);
await warmUpLlm(execution);
const text = await generate(llm, { system, prompt });
// finally: releaseLease(lease.id)
```

**Effective context limit** = `min(machine.context_limit, binding.context_limit, model.default_context_limit)` — the smallest non-null value wins.

**NPU pathway** (lightweight helpers — episodic extractor, task knowledge
extractor, art prompt revision, art style exploration) is **not** managed by
the slot system. Use `resolveLightNpuExecution(db)` or the legacy
`selectLightMachine` shim to get any enabled NPU machine + its first enabled
binding. NPU machines are excluded from the inference resolver.

**ComfyUI dispatch** (art/music/sfx tasks) is also untouched by this layer — it
uses the preset/workflow system in `foreman/comfyui-*.ts`.

## Machine Manager

All machine access goes through `machine-manager.ts`. Consumers acquire leases:
- `acquireLease(db, "director", label, { preferredMachineId, strictPreferred })`
- `acquireLeaseForModel(db, consumer, label, modelId)` — preferred entry point
  for inference workloads (handles candidate iteration + capacity-aware fallback)
- `releaseLease(leaseId)` in finally block
- Leases expire automatically (5min director, 30min foreman, 60min pipeline, 10min analysis)
- `hasCapacity(machine)` respects `max_concurrent`
- `strictPreferred: true` disables type-based fallback when a specific machine
  is required (used by `acquireLeaseForModel` to guarantee the chosen machine
  hosts the requested logical model)

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

## Code Conventions

- TypeScript, strict mode
- AI SDK (`ai` package) for all LLM calls — `streamText`, `generateText`, `tool()`
- LLM model instances always come from `instantiateLlm(execution)` in `llm.ts`
- LLM model resolution always goes through `models.ts` (`resolveInferenceExecution`,
  `resolveLightNpuExecution`, `acquireLeaseForModel`) — never read provider strings
  directly from machine fields
- Zod for tool parameter schemas
- Express routes with explicit error handling
- Git worktrees for task isolation
- Event-driven scheduling (nudge pattern, no polling timers)
- Crash recovery on startup (reset stuck states)

## Testing

Jest, 880+ tests across 52 suites. Run with `npx jest`.
Tests use in-memory SQLite databases and temp directories. Test files are
excluded from `tsc` (per `tsconfig.json`); they're type-checked by ts-jest at
test runtime, which is more lenient about excess properties on object literals.

## Build & Run

```bash
npm install
npm run dev          # Vite dev server + tsx watch
npm run build        # Production build
npm test             # Jest test suite
npx tsc --noEmit     # Type check
```

## What NOT To Do

- Don't add migrations by modifying the schema alone — add ALTER TABLE to `db.ts` `migrate()`
- Don't bypass the machine manager — always use `acquireLease`/`releaseLease` or `acquireLeaseForModel`
- Don't read provider strings from machine fields (`machines.model_id` no longer
  exists). Always go through `models.ts` resolvers — they return the right
  binding, machine, and effective context limit in one call.
- Don't call `acquireLease` with `preferredMachineId` and expect the result to
  always be that machine — without `strictPreferred: true`, acquireLease may
  fall through to a type-based search and pick a different machine. For
  logical-model dispatch, use `acquireLeaseForModel`.
- Don't make the Director write project files — it has read-only filesystem access
- Don't skip `shell: false` in spawn calls — prevents injection and special char issues
- Don't add `shell: true` to memsearch or other subprocess calls
