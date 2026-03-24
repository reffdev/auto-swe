# AGENTS.md — Open SWE

## What this project is

Open SWE is an autonomous agent development system. Users create projects (linked to git repos), add LLM machines (OpenAI-compatible endpoints), create issues (tasks), and approve them for an agent to work on. The agent reads the codebase, makes changes, runs tests, commits, pushes a branch, and opens a PR.

## How to run

```bash
npm run dev          # starts Express server (port 3001) + Vite frontend (port 5173)
npm run dev:server   # server only
npm run dev:dashboard # frontend only
npm test             # jest test suite
```

The Vite dev server proxies `/api` to `localhost:3001`.

## Architecture

### Backend (src/server/)

| File | Purpose |
|------|---------|
| `index.ts` | Express app entry point. Initializes DB, crash recovery, mounts routes, graceful shutdown. |
| `schema.ts` | Drizzle ORM table definitions — single source of truth for the DB schema. |
| `db.ts` | Database class wrapping Drizzle + better-sqlite3. All CRUD operations. WAL mode. Auto-migration for schema changes. |
| `api.ts` | Express routes (~18 endpoints). Consolidated `/api/poll`, CRUD for projects/machines/issues, issue actions (approve/retry/approve-pr/reject-pr), live run output, LLM request logs. |
| `runner.ts` | Single-agent executor. Creates worktree → runs agent via `streamText` → commits → pushes → creates PR. Saves structured step output incrementally for live viewing. |
| `git.ts` | Git operations: worktree lifecycle, commit, push, PR creation/merge (GitHub + Gitea), remote URL parsing, authenticated URL building. All async, non-fatal. |
| `prompts.ts` | System prompt construction for the agent. Documents all available tools and expected workflows. |
| `tools/filesystem.ts` | 12 agent tools: readFile, writeFile, listDirectory, runCommand, searchFiles, getFileInfo, gitStatus, gitDiff, appendToFile, deleteFile, moveFile, replaceInFile. Includes context budget tracking, loop detection, path sandboxing, read count limiting. |
| `tools/fetch.ts` | fetchUrl tool — fetches web pages with timeout, size limit, HTML stripping. |
| `tools/context-budget.ts` | ContextBudget class — tracks token usage and dynamically limits tool output. Default 128k tokens, configurable per machine. |

### Frontend (src/frontend/)

| File | Purpose |
|------|---------|
| `Dashboard.tsx` | Root layout. Manages project/machine/issue selection. Renders Sidebar + main panel (IssueList, IssueDetail, or MachineDetail). |
| `Sidebar.tsx` | Project list, machine list. New Project and New Machine dialogs. |
| `IssueList.tsx` | Issue table with status filter tabs. New Issue dialog. |
| `IssueDetail.tsx` | Issue detail with live agent output. Uses Conversation/Message/MessageResponse AI components. Polls run output every 2s while agent is working. Action buttons for approve, retry, approve-pr, reject-pr. |
| `MachineDetail.tsx` | Machine settings form (name, base URL, model ID, context limit, enabled toggle). Save and delete. |
| `api.ts` | Typed fetch client for all API endpoints. 30s timeout via AbortController. |
| `usePoll.ts` | React hook that polls `/api/poll` every 4 seconds. |

### Database (SQLite, WAL mode)

5 tables defined in `schema.ts`:
- **machines** — LLM endpoints (base_url, model_id, context_limit, status)
- **projects** — Git repos (workdir, git_remote, git_server_token, git_default_branch)
- **issues** — Units of work (title, description, status, git_branch, git_pr_url)
- **runs** — Agent executions (status, structured JSON output, token counts, timing)
- **llm_requests** — Per-step LLM call log (input/output text, token counts including cache, timing)

### Agent execution flow

1. User clicks "Approve & Run" on an issue
2. API finds idle machine, creates run record, fires `executeIssue` async
3. Runner ensures workdir exists (re-clones if missing)
4. Creates git worktree on a new branch
5. Calls `streamText` with all filesystem tools + system prompt
6. Each step: tool calls execute, results saved incrementally to run.output as JSON
7. On completion: git add, commit (message piped via stdin), push (with auth token), create PR via API
8. Issue moves to `awaiting_review`; user can approve or reject the PR

### Key patterns

- **Line ending normalization**: All file-reading tools normalize `\r\n` → `\n` for Windows compat. `replaceInFile` normalizes both content and search strings.
- **Shell safety**: `gitSafe()` uses `spawn` with args array. `gitCommit()` pipes message via stdin (`git commit -F -`). `searchFiles` uses `spawnSync` with args array for rg/grep.
- **Context budget**: Tracks chars consumed by tool results. Truncates large outputs as budget fills. Files ≤50 lines are never truncated. Configurable per machine via `context_limit`.
- **Read count reset**: File read counters reset when the file is modified (writeFile, replaceInFile, appendToFile, deleteFile, moveFile).
- **Crash recovery**: On startup, resets stuck machines to idle, running runs to fail, running/approved issues to failed.
- **Structured live output**: Runner saves `liveSteps[]` JSON to run.output after each agent step. Frontend polls and renders as Conversation messages.

## Testing

99 tests across 5 suites:
- `db.test.ts` — CRUD, crash recovery, schema, column validation
- `api.test.ts` — All endpoints, validation, state transitions, auto-clone
- `git.test.ts` — Branch naming, remote parsing, worktree ops, commit with shell metacharacters
- `runner.test.ts` — State machine transitions on failure (uses 3s timeout against unreachable endpoint)
- `index.test.ts` — Placeholder

Run: `npx jest --no-cache`

## Conventions

- TypeScript strict mode. All files use `.ts` / `.tsx`.
- Server types are inferred from Drizzle schema (`$inferSelect`), not hand-written.
- Frontend types mirror server types in `frontend/api.ts` (not shared — keep in sync manually).
- Express 5. Async route handlers are natively supported.
- All git operations are async and non-fatal (return false/null on error, never throw).
- `shell: true` is used for git spawn calls on Windows (git found via PATH). Args are passed as arrays for safety.
- Database migrations go in `Db.migrate()` as try/catch ALTER TABLE statements.
- Tests use `:memory:` SQLite and temp directories. Runner tests use `agentTimeoutMs: 3000` for fast failure.
