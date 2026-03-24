# Open-SWE MVP Plan

## Goal

Bare minimum autonomous agent development system: configure a local LLM endpoint, create a project linked to a git repo, give an agent instructions, and review the resulting PR.

No multi-stage pipeline. No cloud providers. No webhooks. One agent run per issue, straight to PR.

---

## Architecture Overview

### Source of Patterns

The mastra-react project provides battle-tested implementations for most of what we need. This plan ports the minimum viable subset.

| mastra-react component | What we take | What we skip |
|---|---|---|
| `db.ts` (SQLite WAL, better-sqlite3) | Schema pattern, CRUD helpers | 90% of tables — we need 4 not 8 |
| `git.ts` (worktree lifecycle, PR creation) | setupWorktree, commitAll, pushBranch, createPullRequest, removeWorktree | mergeBranchAndPush (manual via PR review) |
| `pipeline.ts` (stage executor) | Model factory (openai-compatible), single `generateText` call | Multi-stage orchestration, agent factories, context summarization |
| `dispatcher.ts` (tick loop) | The concept of bootstrap → assign → complete | Follow-up/reflect/analysis complexity |
| `api.ts` (Express routes) | Route structure, consolidated `/api/poll` | 80% of the endpoints |
| `lib/api.ts` (frontend client) | Typed fetch helpers, polling pattern | Interactive sessions, analysis, DAG |

### Files to Create/Modify

```
src/server/
  db.ts              ← SQLite schema + typed CRUD (NEW)
  git.ts             ← Worktree + PR operations (PORT from mastra-react)
  api.ts             ← Express routes (NEW, ~15 endpoints)
  runner.ts          ← Single-agent executor (NEW, simplified pipeline.ts)
  index.ts           ← Express app bootstrap (REWRITE)
  tools/             ← Already done ✓
  prompts.ts         ← Already done ✓

src/frontend/
  Dashboard.tsx      ← Project selector, issue list, PR review (REWRITE)
  AgentPanel.tsx     ← Wire to real API (REWRITE)
  api.ts             ← Typed frontend API client (NEW)
```

### Dependencies to Add

```
better-sqlite3        ← SQLite with WAL mode
@types/better-sqlite3 ← types (devDependency)
express               ← HTTP server
@types/express        ← types (devDependency)
```

Already present: `ai`, `@ai-sdk/openai-compatible`, `zod`, `react`, `vite`.

---

## Database Schema

SQLite in WAL mode via better-sqlite3. 4 tables. All IDs are UUIDs (TEXT).

Stored at `./open-swe.db` (or `DB_PATH` env var).

### machines

Where the LLM lives. OpenAI-compatible endpoints only for MVP.

```sql
CREATE TABLE IF NOT EXISTS machines (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT '',
  base_url    TEXT NOT NULL,
  model_id    TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'idle',
  current_run_id TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- `base_url`: Full URL to OpenAI-compatible API, e.g. `http://192.168.1.50:8080/v1`
- `model_id`: Model name the server expects, e.g. `qwen2.5-coder-32b`
- `status`: `idle` | `working`
- `current_run_id`: FK to runs.id when working, null when idle

### projects

A git repo you want agents to work on.

```sql
CREATE TABLE IF NOT EXISTS projects (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  workdir           TEXT NOT NULL,
  git_remote        TEXT,
  git_server_token  TEXT,
  git_default_branch TEXT NOT NULL DEFAULT 'main',
  model_id          TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- `workdir`: Absolute path to the local clone (main working copy)
- `git_remote`: Push/pull URL (HTTPS or SSH)
- `git_server_token`: PAT for GitHub/Gitea API (PR creation, merge)
- `model_id`: Optional override — if set, use this model instead of the machine's default

### issues

A unit of work ("implement X"). One issue = one agent run = one PR.

```sql
CREATE TABLE IF NOT EXISTS issues (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'pending',
  git_branch      TEXT,
  git_worktree    TEXT,
  git_pr_url      TEXT,
  git_pr_number   INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT
);
```

- `status`: `pending` → `approved` → `running` → `awaiting_review` → `completed` | `failed`
- `git_branch`: Set on approve, format `issue/{id-prefix}-{slug}`
- `git_worktree`: Absolute path to the worktree directory
- `git_pr_url`: Set after PR creation
- `git_pr_number`: Set after PR creation

### runs

One agent execution. 1:1 with issues for MVP (no multi-stage).

```sql
CREATE TABLE IF NOT EXISTS runs (
  id                TEXT PRIMARY KEY,
  issue_id          TEXT NOT NULL REFERENCES issues(id),
  machine_id        TEXT REFERENCES machines(id),
  status            TEXT NOT NULL DEFAULT 'pending',
  output            TEXT,
  started_at        TEXT,
  completed_at      TEXT,
  duration_ms       INTEGER,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- `status`: `pending` → `running` → `pass` | `fail`
- `output`: Agent's final text output (for display in dashboard)
- Token counts populated from `generateText` usage response

---

## Server: db.ts

### Responsibilities

1. Open/create SQLite database in WAL mode
2. Auto-create tables on startup (idempotent `CREATE TABLE IF NOT EXISTS`)
3. Crash recovery: on startup, reset any machines stuck in `working` to `idle`, reset any runs stuck in `running` to `fail`
4. Typed CRUD functions for each table

### Key Functions

```typescript
// Initialization
initDb(dbPath?: string): Database

// Machines
getMachines(): Machine[]
getMachine(id: string): Machine | null
createMachine(data: { name?: string, base_url: string, model_id: string }): Machine
updateMachine(id: string, data: Partial<Machine>): void
deleteMachine(id: string): void
getIdleMachine(): Machine | null  // first enabled + idle machine

// Projects
getProjects(): Project[]
getProject(id: string): Project | null
createProject(data: { name: string, workdir: string, git_remote?: string, ... }): Project
updateProject(id: string, data: Partial<Project>): void
deleteProject(id: string): void

// Issues
getIssues(projectId?: string): Issue[]
getIssue(id: string): Issue | null
createIssue(data: { project_id: string, title: string, description?: string }): Issue
updateIssue(id: string, data: Partial<Issue>): void

// Runs
getRun(id: string): Run | null
getRunByIssueId(issueId: string): Run | null
createRun(data: { issue_id: string }): Run
updateRun(id: string, data: Partial<Run>): void

// Crash recovery
recoverFromCrash(): void
```

### Types

```typescript
interface Machine {
  id: string
  name: string
  base_url: string
  model_id: string
  enabled: number  // 0 | 1
  status: 'idle' | 'working'
  current_run_id: string | null
  created_at: string
}

interface Project {
  id: string
  name: string
  workdir: string
  git_remote: string | null
  git_server_token: string | null
  git_default_branch: string
  model_id: string | null
  created_at: string
}

interface Issue {
  id: string
  project_id: string
  title: string
  description: string
  status: 'pending' | 'approved' | 'running' | 'awaiting_review' | 'completed' | 'failed'
  git_branch: string | null
  git_worktree: string | null
  git_pr_url: string | null
  git_pr_number: number | null
  created_at: string
  completed_at: string | null
}

interface Run {
  id: string
  issue_id: string
  machine_id: string | null
  status: 'pending' | 'running' | 'pass' | 'fail'
  output: string | null
  started_at: string | null
  completed_at: string | null
  duration_ms: number | null
  prompt_tokens: number | null
  completion_tokens: number | null
  created_at: string
}
```

---

## Server: git.ts

Port from `mastra-react/src/server/git.ts`. All functions use `spawnSync`/`execSync` with the project's main workdir as cwd (except operations on the worktree itself).

### Functions to Port

#### `makeBranchName(issueId: string, title: string): string`
- Format: `issue/{id[0:8]}-{slug}`
- Slug: title lowercased, non-alphanumeric → `-`, max 50 chars, trim trailing dashes
- Example: `issue/a1b2c3d4-add-dark-mode-toggle`

#### `setupWorktree(mainWorkdir: string, worktreePath: string, branch: string): boolean`
1. `git fetch origin` in main workdir
2. `git worktree add {worktreePath} -b {branch}` from main workdir
3. Verify worktree has files (not just `.git`)
4. Return true on success, false on error

Worktree location: `{project.workdir}/../.orch-worktrees/{issue.id}/`

#### `commitAll(worktreePath: string, message: string): string | null`
1. `git add -A` in worktree
2. Check for staged changes (`git diff --cached --quiet` → exit 1 means changes exist)
3. `git commit -m "{message}"` in worktree
4. Return short commit hash, or null if no changes

#### `pushBranch(mainWorkdir: string, branch: string): boolean`
1. `git push origin {branch}` from main workdir
2. Return true on success

#### `createPullRequest(project: Project, branch: string, title: string, body: string): { url: string, number: number } | null`
1. Parse `git_remote` to extract owner/repo and host
2. Detect GitHub vs Gitea from host
3. POST to appropriate API:
   - GitHub: `https://api.github.com/repos/{owner}/{repo}/pulls`
   - Gitea: `{serverUrl}/api/v1/repos/{owner}/{repo}/pulls`
4. Body: `{ title, body, head: branch, base: project.git_default_branch }`
5. Auth: `Authorization: token {project.git_server_token}`
6. Return `{ url, number }` or null on error

#### `removeWorktree(mainWorkdir: string, worktreePath: string): boolean`
1. `git worktree remove {worktreePath} --force`
2. `git worktree prune`
3. Return true on success

#### `approvePr(project: Project, prNumber: number): boolean`
1. Parse `git_remote` to extract owner/repo and host
2. PUT to merge endpoint:
   - GitHub: `https://api.github.com/repos/{owner}/{repo}/pulls/{prNumber}/merge`
   - Gitea: `{serverUrl}/api/v1/repos/{owner}/{repo}/pulls/{prNumber}/merge`
3. Return true on success

---

## Server: runner.ts

The single-agent executor. Replaces mastra-react's entire dispatcher + multi-stage pipeline.

### Core Function

```typescript
async function executeIssue(
  machine: Machine,
  issue: Issue,
  project: Project
): Promise<void>
```

### Flow

```
1. Resolve model
   - project.model_id ?? machine.model_id
   - createOpenAICompatible({ name: machine.id, baseURL: machine.base_url })(modelId)

2. Create worktree
   - branch = makeBranchName(issue.id, issue.title)
   - worktreePath = resolve(project.workdir, '..', '.orch-worktrees', issue.id)
   - setupWorktree(project.workdir, worktreePath, branch)
   - Update issue: git_branch, git_worktree, status='running'

3. Create tools
   - budget = new ContextBudget()
   - tools = makeFilesystemTools(worktreePath, budget)
   - Also include fetchUrlTool

4. Build prompt
   - System: constructSystemPrompt({ workingDir: worktreePath, ... })
   - User: "Issue: {title}\n\n{description}"

5. Run agent
   - Update run: status='running', started_at, machine_id
   - Update machine: status='working', current_run_id
   - result = await generateText({
       model, system, tools, prompt,
       maxSteps: 60,
       temperature: 0.2,
     })
   - Update run: output, token counts

6. Git operations (on success)
   - commitAll(worktreePath, `[open-swe] ${issue.title}`)
   - pushBranch(project.workdir, branch)
   - pr = createPullRequest(project, branch, issue.title, issue.description)
   - Update issue: git_pr_url, git_pr_number, status='awaiting_review'
   - Update run: status='pass'

7. On failure (generateText throws or no changes)
   - Update issue: status='failed'
   - Update run: status='fail', output=error message

8. Cleanup (always)
   - removeWorktree(project.workdir, worktreePath)
   - Update machine: status='idle', current_run_id=null
```

### Error Handling

- Transient LLM errors (502, 503, ECONNRESET): retry up to 2 times with 5s delay
- Agent produces no file changes: mark as failed with "No changes made" message
- Git push/PR creation fails: still mark run as pass but issue stays `running` with error logged — user can retry

---

## Server: api.ts

Express router. ~15 endpoints.

### Consolidated State

```
GET /api/poll?project=<id>
```

Returns:
```json
{
  "projects": Project[],
  "machines": Machine[],
  "issues": Issue[],       // filtered by project if query param set
  "runs": Run[]            // for the returned issues
}
```

Frontend polls this every 3–5 seconds. Single request, all state.

### Project CRUD

```
GET    /api/projects
POST   /api/projects         { name, workdir, git_remote?, git_server_token?, git_default_branch?, model_id? }
PATCH  /api/projects/:id     { ...partial fields }
DELETE /api/projects/:id
```

Validation on create:
- `workdir` must be an existing directory
- `workdir` must be a git repo (contains `.git`)

### Machine CRUD

```
GET    /api/machines
POST   /api/machines          { base_url, model_id, name? }
PATCH  /api/machines/:id      { base_url?, model_id?, name?, enabled? }
DELETE /api/machines/:id       (reject if status='working')
```

Health check on create/update: `GET {base_url}/models` must respond 2xx.

### Issue Operations

```
POST   /api/issues            { project_id, title, description? }
GET    /api/issues/:id        → Issue + Run
PATCH  /api/issues/:id        { title?, description? }  (only while pending)
```

### Issue Actions

```
POST /api/issues/:id/approve
```
1. Verify issue is `pending`
2. Find idle machine (or return 409)
3. Create run record
4. Kick off `executeIssue()` asynchronously (don't await)
5. Return 202 Accepted

```
POST /api/issues/:id/retry
```
1. Verify issue is `failed`
2. Reset to `approved`-like state, create new run
3. Kick off `executeIssue()` asynchronously
4. Return 202 Accepted

```
POST /api/issues/:id/approve-pr
```
1. Verify issue is `awaiting_review` with `git_pr_number` set
2. Call `approvePr(project, prNumber)`
3. Update issue: status='completed', completed_at=now
4. Return 200

```
POST /api/issues/:id/reject-pr
```
1. Verify issue is `awaiting_review`
2. Update issue: status='failed'
3. Return 200 (PR stays open on the git server — user can close manually or retry)

---

## Server: index.ts (Rewrite)

Replace the current dev-only entry point with a real Express server.

```typescript
// 1. Initialize database
const db = initDb()

// 2. Create Express app
const app = express()
app.use(cors())
app.use(express.json())

// 3. Mount API routes
app.use('/api', createApiRouter(db))

// 4. In production, serve frontend static files from dist/
//    In dev, Vite handles frontend on its own port

// 5. Crash recovery
recoverFromCrash(db)

// 6. Start server
app.listen(PORT)

// 7. Graceful shutdown on SIGTERM/SIGINT
//    - Wait for any running executeIssue() to finish (10s timeout)
//    - Close database
//    - Exit
```

Port: 3001 (matches mastra-react convention, avoids conflict with Vite on 5173).

### Vite Dev Proxy

Add to `vite.config.ts`:
```typescript
server: {
  proxy: {
    '/api': 'http://localhost:3001'
  }
}
```

This lets the frontend call `/api/poll` without CORS issues in dev.

---

## Frontend: api.ts (New)

Typed API client. All calls go to `/api/...` (proxied to backend in dev).

```typescript
// Types (mirror server types)
export type { Machine, Project, Issue, Run }

// Consolidated poll
export async function poll(projectId?: string): Promise<PollResponse>

// Projects
export async function createProject(data: CreateProjectData): Promise<Project>
export async function updateProject(id: string, data: Partial<Project>): Promise<void>
export async function deleteProject(id: string): Promise<void>

// Machines
export async function createMachine(data: CreateMachineData): Promise<Machine>
export async function updateMachine(id: string, data: Partial<Machine>): Promise<void>
export async function deleteMachine(id: string): Promise<void>

// Issues
export async function createIssue(data: CreateIssueData): Promise<Issue>
export async function approveIssue(id: string): Promise<void>
export async function retryIssue(id: string): Promise<void>
export async function approvePr(id: string): Promise<void>
export async function rejectPr(id: string): Promise<void>
```

---

## Frontend: Dashboard.tsx (Rewrite)

Replace mock data with real API integration.

### Layout

```
┌──────────────┬──────────────────────────────────────┐
│  Projects    │  Issue List / PR Review / Settings    │
│              │                                       │
│  [+ New]     │  [Pending] [Running] [Review] [Done]  │
│              │                                       │
│  > my-app    │  ┌─────────────────────────────────┐  │
│    my-lib    │  │ Issue: Add dark mode toggle      │  │
│              │  │ Status: awaiting_review          │  │
│ ──────────── │  │ PR: github.com/owner/repo/pull/5 │  │
│  Machines    │  │ [Approve PR] [Reject PR]         │  │
│              │  └─────────────────────────────────┘  │
│  > local-gpu │  ┌─────────────────────────────────┐  │
│    (idle)    │  │ Issue: Fix login bug             │  │
│              │  │ Status: running                  │  │
│              │  │ Duration: 2m 34s                 │  │
│              │  └─────────────────────────────────┘  │
└──────────────┴──────────────────────────────────────┘
```

### Views

1. **Project Issue List** (default) — all issues for selected project, filterable by status tab
2. **PR Review** — issues in `awaiting_review`, each with PR link and approve/reject buttons
3. **Settings** — machine management (add/edit/remove), project settings (edit/delete)

### State Management

Single `useEffect` poll loop (from mastra-react's `useSystemData` pattern):

```typescript
function usePoll(projectId?: string) {
  const [data, setData] = useState<PollResponse | null>(null)

  useEffect(() => {
    const tick = () => poll(projectId).then(setData).catch(console.error)
    tick()
    const id = setInterval(tick, 4000)
    return () => clearInterval(id)
  }, [projectId])

  return data
}
```

### Dialogs

- **New Project**: form with name, workdir, git_remote, git_server_token, git_default_branch
- **New Machine**: form with name, base_url, model_id
- **New Issue**: form with title, description (markdown textarea)

All dialogs use the existing shadcn Dialog component.

---

## Frontend: AgentPanel.tsx (Rewrite)

When an issue is selected and has a run, show the run output in the existing Conversation/Message components.

- `status='running'`: show spinner + "Agent is working..."
- `status='pass'`: show agent output rendered as markdown via Streamdown
- `status='fail'`: show error output with retry button
- `status='awaiting_review'`: show output + PR link + approve/reject buttons

The existing `PromptInput` component is not used for MVP (no interactive chat with the agent — just one-shot instructions via the New Issue dialog). It can be wired up later for interactive mode.

---

## End-to-End Flow

```
1. User opens dashboard (http://localhost:5173)
2. No projects yet → clicks "New Project"
   → Enters: name="my-app", workdir="/home/me/my-app",
     git_remote="https://github.com/me/my-app.git",
     token="ghp_..."
   → POST /api/projects → project appears in sidebar

3. No machines yet → clicks "Add Machine"
   → Enters: name="local-gpu", base_url="http://192.168.1.50:8080/v1",
     model_id="qwen2.5-coder-32b"
   → POST /api/machines → machine appears in sidebar

4. Selects project "my-app" → clicks "New Issue"
   → Enters: title="Add dark mode toggle",
     description="Add a toggle in the header that switches
     between light and dark mode. Store preference in localStorage.
     Update tailwind config if needed."
   → POST /api/issues → issue appears as "pending"

5. Clicks "Approve" on the issue
   → POST /api/issues/:id/approve → returns 202
   → Backend: finds idle machine, creates worktree, starts agent run
   → Poll shows: issue "running", machine "working"

6. Agent runs (1-5 minutes depending on model/task)
   → Reads codebase via readFile, searchFiles, listDirectory
   → Makes changes via replaceInFile, writeFile
   → Runs tests via runCommand
   → Reviews via gitStatus, gitDiff

7. Agent finishes
   → Backend: git commit, push, create PR
   → Poll shows: issue "awaiting_review", PR link visible
   → Machine returns to "idle"

8. User clicks PR link → reviews changes on GitHub/Gitea
   → Clicks "Approve PR" in dashboard
   → POST /api/issues/:id/approve-pr → branch merged
   → Issue moves to "completed"

   OR: Clicks "Reject PR" → issue moves to "failed"
   → Can click "Retry" to run again
```

---

## Build Order

Implementation should proceed in this order, each step building on the last:

### Step 1: Database + Server Shell
- `db.ts`: schema, initDb, CRUD functions, crash recovery
- `index.ts`: Express app, mount routes, start server
- Verify: server starts, creates `open-swe.db`, tables exist

### Step 2: API Routes (No Runner)
- `api.ts`: all CRUD endpoints for projects, machines, issues
- `/api/poll` returns real data
- Verify: can create project/machine/issue via curl

### Step 3: Git Operations
- `git.ts`: port all 6 functions from mastra-react
- Verify: can create worktree, commit, push from a test repo

### Step 4: Runner
- `runner.ts`: executeIssue function
- Wire `POST /api/issues/:id/approve` to trigger runner
- Verify: approve an issue → agent runs → PR appears on git server

### Step 5: Frontend API Client + Polling
- `src/frontend/api.ts`: typed fetch client
- `usePoll` hook
- Verify: dashboard shows real projects/machines/issues

### Step 6: Frontend Views
- Rewrite Dashboard.tsx: project sidebar, issue list, status tabs
- New Project / New Machine / New Issue dialogs
- PR review view with approve/reject
- Wire AgentPanel to show run output

### Step 7: Polish
- Vite proxy config for dev
- Graceful shutdown
- Error handling in frontend (loading states, error messages)
- Basic input validation on API routes

---

## Out of Scope for MVP

These are intentionally excluded. They can be added incrementally later.

- Multi-stage pipeline (scout → implement → test → verify → reflect)
- Dispatcher tick loop / queue (we trigger directly on approve)
- Interactive planning sessions
- Idle analysis / code audits
- Cloud LLM providers (Anthropic, OpenAI API keys)
- GitHub/Gitea webhook ingestion (auto-create issues from GitHub issues)
- Issue dependencies (depends_on)
- Activity log table
- SSE / WebSocket (polling only)
- Authentication / multi-user
- Live streaming of agent output during execution
- Provider management table
- Stage-specific model overrides
- Pipeline mode selection (fixed vs supervisor)
- Context summarization
- Merge conflict handling
