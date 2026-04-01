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
│  Machine Manager     Lease-based access control         │
│  ├─ Director lease   Conversation, planning, verify     │
│  ├─ Foreman lease    Task execution                     │
│  └─ Pipeline lease   Full issue pipeline                │
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
  ├─ Inference (Ollama/OpenRouter/llama.cpp) → code tasks
  └─ ComfyUI (ROCm/CUDA)                     → art/music/sfx
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
├── machine-manager.ts  # Centralized lease system
├── terminal.ts         # PTY WebSocket for Claude CLI
├── schema.ts           # Drizzle ORM (SQLite)
├── db.ts               # Database + migrations
├── api.ts              # Express routes
├── stats.ts            # Token speed tracking
└── git.ts              # Worktree, commit, PR operations

src/frontend/
├── Dashboard.tsx       # Main layout + view routing
├── Sidebar.tsx         # Navigation, stats, toggles
├── DirectorDashboard.tsx    # Directive list + machine selector
├── DirectorConversation.tsx # Chat UI with retry
├── ForemanDashboard.tsx     # Task queue
├── ForemanTaskDetail.tsx    # Task detail + asset preview
├── Terminal.tsx        # xterm.js Claude CLI
└── api.ts              # Frontend API client
```

## Database

SQLite with WAL mode. Drizzle ORM for schema, raw SQL for complex queries.
Migrations in `db.ts` `migrate()` method — add `ALTER TABLE` statements there.

Key tables: `projects`, `machines`, `issues`, `runs`, `llm_requests`, `foreman_tasks`, `foreman_runs`, `foreman_config`, `director_directives`, `director_milestones`, `director_reviews`, `director_conversations`, `director_messages`.

## Machine Manager

All machine access goes through `machine-manager.ts`. Consumers acquire leases:
- `acquireLease(db, "director", label, { preferredMachineId })`
- `releaseLease(leaseId)` in finally block
- Leases expire automatically (5min director, 30min foreman)
- `hasCapacity(machine)` respects `max_concurrent`

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
- Zod for tool parameter schemas
- Express routes with explicit error handling
- Git worktrees for task isolation
- Event-driven scheduling (nudge pattern, no polling timers)
- Crash recovery on startup (reset stuck states)

## Testing

Jest, 711+ tests across 41 suites. Run with `npx jest`.
Tests use in-memory SQLite databases and temp directories.

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
- Don't bypass the machine manager — always use `acquireLease`/`releaseLease`
- Don't make the Director write project files — it has read-only filesystem access
- Don't skip `shell: false` in spawn calls — prevents injection and special char issues
- Don't add `shell: true` to memsearch or other subprocess calls
