/**
 * Typed frontend API client.
 *
 * All calls go to /api/... (proxied to backend in dev via Vite).
 */

// ─── Types (mirror server types) ─────────────────────────────────────────────

export interface Machine {
  id: string;
  name: string;
  base_url: string;
  model_id: string;
  enabled: number;
  status: "idle" | "working";
  current_run_id: string | null;
  context_limit: number | null;
  created_at: string;
}

export interface Project {
  id: string;
  name: string;
  workdir: string;
  git_remote: string | null;
  git_server_token: string | null;
  git_default_branch: string;
  model_id: string | null;
  created_at: string;
}

export interface Issue {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: "pending" | "approved" | "running" | "awaiting_review" | "completed" | "failed" | "epic";
  git_branch: string | null;
  git_worktree: string | null;
  git_pr_url: string | null;
  git_pr_number: number | null;
  github_issue_number: number | null;
  github_issue_url: string | null;
  review_lenses: string | null;  // JSON array string, e.g. '["general","security"]'
  parent_id: string | null;
  sequence: number | null;
  depends_on: string | null;  // JSON array of issue IDs, e.g. '["uuid1","uuid2"]'
  retry_count: number;
  created_at: string;
  completed_at: string | null;
}

export interface Run {
  id: string;
  issue_id: string;
  machine_id: string | null;
  stage: string | null;
  status: "pending" | "running" | "pass" | "fail";
  output: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  created_at: string;
}

export interface PollResponse {
  projects: Project[];
  machines: Machine[];
  issues: Issue[];
  runs: Run[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const API_TIMEOUT_MS = 30_000;

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Poll ─────────────────────────────────────────────────────────────────────

export function poll(projectId?: string): Promise<PollResponse> {
  const qs = projectId ? `?project=${projectId}` : "";
  return json(`/api/poll${qs}`);
}

// ─── Projects ─────────────────────────────────────────────────────────────────

export function createProject(data: {
  name: string;
  workdir?: string;
  git_remote?: string;
  git_server_token?: string;
  git_default_branch?: string;
  model_id?: string;
}): Promise<Project> {
  return json("/api/projects", { method: "POST", body: JSON.stringify(data) });
}

export function updateProject(id: string, data: Partial<Project>): Promise<Project> {
  return json(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(data) });
}

export function deleteProject(id: string): Promise<void> {
  return json(`/api/projects/${id}`, { method: "DELETE" });
}

// ─── Machines ─────────────────────────────────────────────────────────────────

export function createMachine(data: {
  name?: string;
  base_url: string;
  model_id: string;
}): Promise<Machine> {
  return json("/api/machines", { method: "POST", body: JSON.stringify(data) });
}

export function updateMachine(id: string, data: Partial<Machine>): Promise<Machine> {
  return json(`/api/machines/${id}`, { method: "PATCH", body: JSON.stringify(data) });
}

export function deleteMachine(id: string): Promise<void> {
  return json(`/api/machines/${id}`, { method: "DELETE" });
}

// ─── Issues ───────────────────────────────────────────────────────────────────

export function createIssue(data: {
  project_id: string;
  title: string;
  description?: string;
  review_lenses?: string[];
}): Promise<Issue> {
  return json("/api/issues", { method: "POST", body: JSON.stringify(data) });
}

export function approveIssue(id: string): Promise<{ issue: Issue; run: Run }> {
  return json(`/api/issues/${id}/approve`, { method: "POST" });
}

export function retryIssue(id: string): Promise<{ issue: Issue; run: Run }> {
  return json(`/api/issues/${id}/retry`, { method: "POST" });
}

export function approvePr(id: string): Promise<Issue> {
  return json(`/api/issues/${id}/approve-pr`, { method: "POST" });
}

export function rejectPr(id: string): Promise<Issue> {
  return json(`/api/issues/${id}/reject-pr`, { method: "POST" });
}

export function cancelIssue(id: string): Promise<{ cancelled: boolean; issue: Issue }> {
  return json(`/api/issues/${id}/cancel`, { method: "POST" });
}

export function retryStage(id: string): Promise<{ issue: Issue }> {
  return json(`/api/issues/${id}/retry-stage`, { method: "POST" });
}

// ─── Issue runs (all stages) ──────────────────────────────────────────────────

export function getIssueRuns(issueId: string): Promise<Run[]> {
  return json(`/api/issues/${issueId}/runs`);
}

// ─── Live output ──────────────────────────────────────────────────────────────

export interface StepData {
  step: number;
  text?: string;
  toolCalls?: Array<{ tool: string; args: string }>;
  toolResults?: Array<{ tool: string; result: string }>;
  tokens: { prompt: number; completion: number };
  durationMs: number;
}

export function getRunOutput(runId: string): Promise<{ status: string; output: string | null }> {
  return json(`/api/runs/${runId}/output`);
}

// ─── Issue Children (Epic → Stories) ──────────────────────────────────────────

export function getChildIssues(parentId: string): Promise<Issue[]> {
  return json(`/api/issues/${parentId}/children`);
}

// ─── Issue Decompose ──────────────────────────────────────────────────────────

export function decomposeIssue(id: string): Promise<{ epic: Issue; stories: Issue[] }> {
  return json(`/api/issues/${id}/decompose`, { method: "POST" });
}

// ─── Issue Lenses ─────────────────────────────────────────────────────────────

export function updateIssueLenses(id: string, lenses: string[]): Promise<Issue> {
  return json(`/api/issues/${id}/lenses`, { method: "PATCH", body: JSON.stringify({ lenses }) });
}

// ─── PR Diff ──────────────────────────────────────────────────────────────────

export interface DiffFile {
  filename: string;
  status: "added" | "deleted" | "modified" | "renamed";
  additions: number;
  deletions: number;
  patch: string;
}

export function getPrDiff(issueId: string): Promise<{ files: DiffFile[]; branch: string; base: string }> {
  return json(`/api/issues/${issueId}/pr-diff`);
}

// ─── Planner ──────────────────────────────────────────────────────────────────

export interface PlannerConversation {
  id: string;
  project_id: string;
  status: "active" | "approved" | "abandoned";
  issue_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlannerMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export interface PlannerPollResponse {
  messages: PlannerMessage[];
  generating: boolean;
  partialText?: string;
}

export function createPlannerConversation(projectId: string): Promise<PlannerConversation & { messages: PlannerMessage[] }> {
  return json("/api/planner/conversations", { method: "POST", body: JSON.stringify({ project_id: projectId }) });
}

export function getPlannerConversation(id: string): Promise<PlannerConversation & { messages: PlannerMessage[] }> {
  return json(`/api/planner/conversations/${id}`);
}

export function sendPlannerMessage(conversationId: string, content: string): Promise<{ message_id: string }> {
  return json(`/api/planner/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}

export function pollPlannerMessages(conversationId: string, afterId?: string): Promise<PlannerPollResponse> {
  const qs = afterId ? `?after=${afterId}` : "";
  return json(`/api/planner/conversations/${conversationId}/messages${qs}`);
}

export function approvePlannerConversation(id: string, reviewLenses?: string[]): Promise<{ issue: Issue; reviewLenses: string[] }> {
  return json(`/api/planner/conversations/${id}/approve`, {
    method: "POST",
    body: JSON.stringify({ reviewLenses }),
  });
}

export function abandonPlannerConversation(id: string): Promise<void> {
  return json(`/api/planner/conversations/${id}`, { method: "DELETE" });
}

// ─── Update & Restart ─────────────────────────────────────────────────────────

export function updateAndRestart(): Promise<{ ok: boolean }> {
  return json("/api/update-restart", { method: "POST" });
}
