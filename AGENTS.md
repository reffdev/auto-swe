# AGENTS.md — Open SWE

> **For the full current architecture**, see **CLAUDE.md** and **docs/architecture/**.

## What this project is

Open SWE is an autonomous software engineering orchestration system. It operates at two levels:

1. **Director + Foreman** (primary): High-level directives decomposed into milestones and tasks, dispatched to inference and ComfyUI machines for code + art + music + SFX generation, with human-in-the-loop review gates.
2. **Pipeline** (single-issue): Scout → implement → build/test gates → review (11 lenses) → GitOps for standalone issues.

## How to run

```bash
npm run dev          # starts Express server (port 3001) + Vite frontend (port 5173)
npm run dev:server   # server only
npm run dev:dashboard # frontend only
npm test             # jest test suite (711+ tests, 41 suites)
npx tsc --noEmit     # type check
```

The Vite dev server proxies `/api` to `localhost:3001`.

## Architecture

### Backend (src/server/)

| File | Purpose |
|------|---------|
| `index.ts` | Express app entry point. Initializes DB, mounts routes, graceful shutdown. |
| `orchestrator.ts` | Single entry point for all background services. Manages startup/shutdown ordering for Machine Manager, Stats, Analysis, Director, Foreman. |
| `machine-manager.ts` | Lease-based machine access control with priority queuing, auto-expiry (5min director, 30min foreman). |
| `llm.ts` | Unified LLM client with resilient fetch, retry logic (5 server + 6 SDK retries), stream inactivity detection (20min), prompt caching hints. |
| `schema.ts` | Drizzle ORM table definitions (20+ tables) — single source of truth for the DB schema. |
| `db.ts` | Database class wrapping Drizzle + better-sqlite3. WAL mode. Auto-migration via ALTER TABLE in `migrate()`. |
| `api.ts` | Express routes (~40+ endpoints). CRUD for projects/machines/issues, director/foreman APIs, analysis, stats, console SSE. |
| `git.ts` | Git operations: worktree lifecycle, commit, push, PR creation/merge (GitHub + Gitea). Async, non-fatal. |
| `git-helpers.ts` | Synchronous git utilities: getHeadCommit, isDirty, getDiff, etc. |
| `stats.ts` | Token speed tracking and performance metrics. |
| `analysis.ts` | Multi-stage automated codebase analysis with per-lens frequency tracking. |
| `terminal.ts` | PTY WebSocket for Claude CLI access (xterm.js frontend). |
| `console-log.ts` | Console log aggregation for SSE streaming to frontend. |
| `runner.ts` | Single-agent executor for pipeline issues. Creates worktree → agent → commit → push → PR. |

### Director (src/server/director/)

| File | Purpose |
|------|---------|
| `scheduler.ts` | Event-driven directive processing loop |
| `conversation.ts` | Multi-turn LLM chat with user |
| `decomposer.ts` | Design doc + milestone generation |
| `planner.ts` | Task batch generation per milestone |
| `verifier.ts` | Task/milestone completion verification |
| `review-gates.ts` | Human-in-the-loop escalation based on autonomy level |
| `memory.ts` / `memory-context.ts` | Context assembly from .swe/ directory |
| `persistent-memory.ts` | .swe/ file management |
| `memsearch.ts` | Semantic search via memsearch CLI |
| `episodic-extractor.ts` | Extract patterns before pruning episodic logs |
| `task-knowledge-extractor.ts` | Post-task learning — extracts conventions, patterns, gotchas |
| `style-lock.ts` | Lock approved art style (checkpoint, preset, prompt prefix, reference image) |
| `style-exploration.ts` | Generate style exploration tasks with 6 varied prompts |
| `art-task-processor.ts` | Inject ComfyUI tags into art task descriptions |
| `unattributed-commits.ts` | Detect manual/external commits not linked to foreman tasks |

### Foreman (src/server/foreman/)

| File | Purpose |
|------|---------|
| `scheduler.ts` | Event-driven task dispatch with backoff |
| `executor.ts` | LLM agent runner in git worktree |
| `task-types.ts` | Task type → machine type routing (inference vs comfyui) |
| `task-lifecycle.ts` | Task state machine management |
| `routing.ts` | Model/machine selection logic |
| `comfyui.ts` | ComfyUI REST client |
| `comfyui-executor.ts` | ComfyUI task execution handler |
| `comfyui-workflows.ts` | Programmatic workflow builders |
| `comfyui-bootstrap.ts` | ComfyUI initialization and model discovery |
| `comfyui-schema.ts` | ComfyUI schema/type definitions |
| `circuit-breaker.ts` | Per-machine fault tolerance (closed → open → half-open) |
| `art-feedback.ts` | LLM-revised prompts on art rejection |
| `asset-archive.ts` | Preserve generated assets across iterations |
| `validator.ts` | Acceptance criteria checking |
| `cleanup.ts` | Stale worktree cleanup on startup |

### Tools (src/server/tools/)

| File | Purpose |
|------|---------|
| `filesystem.ts` | Agent filesystem tools: readFile, writeFile, replaceInFile, searchFiles, runCommand, etc. |
| `web-search.ts` | DuckDuckGo web search |
| `fetch.ts` | URL fetcher with timeout, size limit, HTML stripping |
| `context7.ts` | Library documentation lookup via Context7 |
| `build-check.ts` | Build/test execution tools |
| `context-budget.ts` | Token budget tracking for tool outputs |
| `task-query.ts` | Task database queries |
| `story-context.ts` | Story/issue context extraction |

### Frontend (src/frontend/)

| File | Purpose |
|------|---------|
| `Dashboard.tsx` | Main layout + view routing |
| `DashboardLanding.tsx` | Landing page |
| `ProjectOverview.tsx` | Project overview with status summary, active work, recent activity |
| `Sidebar.tsx` | Navigation, stats, toggles |
| `DirectorDashboard.tsx` | Directive list + machine selector |
| `DirectorDetail.tsx` | Directive detail view |
| `DirectorConversation.tsx` | Chat UI with retry |
| `DirectorReview.tsx` | Review gate UI for human decisions |
| `ForemanDashboard.tsx` | Task queue overview |
| `ForemanTaskDetail.tsx` | Task detail + asset preview |
| `ForemanConfig.tsx` | Foreman configuration (continuous art, etc.) |
| `IssueList.tsx` | Issue table with status filter tabs |
| `IssueDetail.tsx` | Issue detail with live agent output |
| `AnalysisView.tsx` | Analysis results |
| `LlmLogs.tsx` | LLM request logs/analytics |
| `Terminal.tsx` | xterm.js Claude CLI |
| `Planner.tsx` | Epic/issue planning UI |
| `ManualCommits.tsx` | Unattributed commit review + knowledge extraction |
| `PrDiffView.tsx` | PR diff viewer |

### Database (SQLite, WAL mode)

20+ tables defined in `schema.ts`. Key groups:

- **Core**: machines, projects, issues, runs, llm_requests
- **Director**: director_directives, director_milestones, director_reviews, director_conversations, director_messages
- **Foreman**: foreman_tasks, foreman_runs, foreman_config
- **Planning**: planner_conversations, planner_messages
- **Analysis**: analysis_configs, analysis_runs

### Key patterns

- **Two-phase startup**: Orchestrator starts Director first, gates Foreman until Director's first tick completes
- **Lease-based access**: All machine access via Machine Manager with priority queue and auto-expiry
- **Circuit breakers**: Per-machine fault tolerance prevents repeated dispatch to failing machines
- **Event-driven scheduling**: Nudge pattern — no polling timers, schedulers wake on state changes
- **Line ending normalization**: All file-reading tools normalize `\r\n` → `\n` for Windows compat
- **Shell safety**: `shell: false` in spawn calls prevents injection. Commit messages piped via stdin.
- **Context budget**: Tracks chars consumed by tool results. Truncates large outputs as budget fills.
- **Crash recovery**: Orchestrator clears leases and stale worktrees on startup. Pipeline resets stuck machines/runs/issues.
- **Structured live output**: Runner saves `liveSteps[]` JSON to run.output. Frontend polls and renders.
- **Task knowledge extraction**: Post-completion LLM analysis extracts reusable patterns → .swe/semantic/

## Testing

711+ tests across 41 suites. Run: `npx jest`

## Conventions

- TypeScript strict mode. All files use `.ts` / `.tsx`.
- AI SDK (`ai` package) for all LLM calls — `streamText`, `generateText`, `tool()`
- Zod for tool parameter schemas
- Server types inferred from Drizzle schema (`$inferSelect`), not hand-written.
- Express routes with explicit error handling.
- Git worktrees for task isolation.
- Event-driven scheduling (nudge pattern, no polling timers).
- `shell: false` in spawn calls — prevents injection and special char issues.
- Database migrations go in `Db.migrate()` as try/catch ALTER TABLE statements.
- Tests use `:memory:` SQLite and temp directories.
