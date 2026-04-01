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
  model_id: string | null;
  machine_type: string;
  enabled: number;
  status: "idle" | "working";
  current_run_id: string | null;
  max_concurrent: number;
  context_limit: number | null;
  api_key: string | null;
  active_issue_ids: string[];
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
  build_command: string | null;
  test_command: string | null;
  lint_command: string | null;
  created_at: string;
}

export interface Issue {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: "pending" | "approved" | "running" | "awaiting_review" | "completed" | "failed" | "cancelled" | "epic";
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
  scout_brief: string | null;
  scout_commit: string | null;
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

// ─── Analysis ───────────────────────────────────────────────────────────────

export interface AnalysisConfig {
  id: string;
  project_id: string;
  lens_key: string;
  enabled: number;
  frequency: string;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
}

export interface AnalysisFinding {
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  line: number;
  title: string;
  description: string;
  recommendation: string;
}

export interface AnalysisRun {
  id: string;
  project_id: string;
  config_id: string;
  lens_key: string;
  machine_id: string | null;
  status: string;
  findings: string | null;  // JSON array
  summary: string | null;   // JSON { critical, high, medium, low, total }
  output: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
}

export function getAnalysisConfigs(projectId: string): Promise<AnalysisConfig[]> {
  return json(`/api/projects/${projectId}/analysis/configs`);
}

export function updateAnalysisConfig(projectId: string, lensKey: string, data: { enabled?: boolean; frequency?: string }): Promise<AnalysisConfig> {
  return json(`/api/projects/${projectId}/analysis/configs/${lensKey}`, { method: "PUT", body: JSON.stringify(data) });
}

export function getAnalysisRuns(projectId: string, limit = 50): Promise<AnalysisRun[]> {
  return json(`/api/projects/${projectId}/analysis/runs?limit=${limit}`);
}

export function triggerAnalysis(projectId: string, lensKey: string): Promise<{ config: AnalysisConfig }> {
  return json(`/api/projects/${projectId}/analysis/trigger/${lensKey}`, { method: "POST" });
}

export interface PollResponse {
  projects: Project[];
  machines: Machine[];
  issues: Issue[];
  runs: Run[];
}

export interface GroupedLlmLogCall {
  id: string;
  timestamp: string;
  model: string;
  status: "success" | "error";
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  prompt_preview: string;
  response_preview: string;
}

export interface GroupedLlmLog {
  issue_id: string | null;
  issue_title: string | null;
  issue_status: string | null;
  issue_created_at: string | null;
  issue_assignee: string | null;
  last_request_at: string;
  call_count: number;
  calls: GroupedLlmLogCall[];
}

export interface GroupedLlmLogsResponse {
  groups: GroupedLlmLog[];
  totalGroups: number;
  totalCalls: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const API_TIMEOUT_MS = 30_000;

async function json<T>(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => { controller.abort(); }, init?.timeoutMs ?? API_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...Object.fromEntries(new Headers(init?.headers).entries()) },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    if (res.status === 204) return undefined as T;
    return await res.json();
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

export function getMachines(): Promise<Machine[]> {
  return json("/api/machines");
}

export function createMachine(data: {
  name?: string;
  base_url: string;
  model_id?: string;
  max_concurrent?: number;
  api_key?: string;
  machine_type?: string;
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

export function deleteIssue(id: string): Promise<{ deleted: boolean }> {
  return json(`/api/issues/${id}`, { method: "DELETE" });
}

export function clearScoutCache(id: string): Promise<{ issue: Issue }> {
  return json(`/api/issues/${id}/clear-scout`, { method: "POST" });
}

export function retryStage(id: string): Promise<{ issue: Issue }> {
  return json(`/api/issues/${id}/retry-stage`, { method: "POST" });
}

export function checkHasCheckpoint(id: string): Promise<{ hasCheckpoint: boolean }> {
  return json(`/api/issues/${id}/has-checkpoint`);
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
  prompts?: { system: string; user: string };
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
  return json(`/api/issues/${id}/decompose`, { method: "POST", timeoutMs: 120_000 });
}

// ─── Issue Lenses ─────────────────────────────────────────────────────────────

export function updateIssue(id: string, data: { title?: string; description?: string }): Promise<Issue> {
  return json(`/api/issues/${id}`, { method: "PATCH", body: JSON.stringify(data) });
}

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

// ─── Grouped LLM Logs ─────────────────────────────────────────────────────────

export function getGroupedLlmLogs(params?: {
  status?: string[];
  model?: string[];
  start_date?: string;
  end_date?: string;
  search?: string;
  page?: number;
  page_size?: number;
  project_id?: string;
}): Promise<GroupedLlmLogsResponse> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set('status', params.status.join(','));
  if (params?.model) qs.set('model', params.model.join(','));
  if (params?.start_date) qs.set('start_date', params.start_date);
  if (params?.end_date) qs.set('end_date', params.end_date);
  if (params?.search) qs.set('search', params.search);
  if (params?.page) qs.set('page', params.page.toString());
  if (params?.page_size) qs.set('page_size', params.page_size.toString());
  if (params?.project_id) qs.set('project_id', params.project_id);
  
  const query = qs.toString();
  return json(`/api/llm-logs/grouped${query ? '?' + query : ''}`);
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

// ─── Foreman ─────────────────────────────────────────────────────────────────

export interface ForemanTask {
  id: string;
  yaml_id: string | null;
  project_id: string;
  title: string;
  description: string;
  priority: number;
  type: string;
  model: string;
  target_files: string | null;
  depends_on: string | null;
  acceptance_criteria: string | null;
  status: string;
  machine_id: string | null;
  resolved_model: string | null;
  retry_count: number;
  max_retries: number;
  error_message: string | null;
  git_branch: string | null;
  git_worktree: string | null;
  git_pr_url: string | null;
  git_pr_number: number | null;
  next_retry_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  directive_id: string | null;
  milestone_id: string | null;
  created_at: string;
  yaml_synced_at: string | null;
}

export interface ForemanRun {
  id: string;
  task_id: string;
  machine_id: string | null;
  attempt: number;
  status: string;
  model_id: string | null;
  output: string | null;
  validation_output: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  created_at: string;
}

export interface ForemanConfig {
  id: string;
  enabled: number;
  project_id: string | null;
  tasks_dir: string | null;
  priority_mode: string;
  tick_interval_ms: number;
  director_machine_id: string | null;
  director_model_id: string | null;
  created_at: string;
}

export interface ForemanPollResponse {
  config: ForemanConfig | null;
  tasks: ForemanTask[];
  activeIds: string[];
}

export function foremanPoll(): Promise<ForemanPollResponse> {
  return json("/api/foreman/poll");
}

export function createForemanTask(data: {
  project_id: string; title: string; description?: string;
  priority?: number; type?: string; model?: string;
  target_files?: string[]; depends_on?: string[]; acceptance_criteria?: string[];
  max_retries?: number;
}): Promise<ForemanTask> {
  return json("/api/foreman/tasks", { method: "POST", body: JSON.stringify(data) });
}

export function updateForemanTask(id: string, data: Record<string, unknown>): Promise<ForemanTask> {
  return json(`/api/foreman/tasks/${id}`, { method: "PATCH", body: JSON.stringify(data) });
}

export function deleteForemanTask(id: string): Promise<void> {
  return json(`/api/foreman/tasks/${id}`, { method: "DELETE" });
}

export function queueForemanTask(id: string): Promise<ForemanTask> {
  return json(`/api/foreman/tasks/${id}/queue`, { method: "POST" });
}

export function cancelForemanTask(id: string): Promise<{ cancelled: boolean; task: ForemanTask }> {
  return json(`/api/foreman/tasks/${id}/cancel`, { method: "POST" });
}

export function retryForemanTask(id: string): Promise<ForemanTask> {
  return json(`/api/foreman/tasks/${id}/retry`, { method: "POST" });
}

export function rejectForemanTask(id: string, feedback: string): Promise<ForemanTask> {
  return json(`/api/foreman/tasks/${id}/reject`, { method: "POST", body: JSON.stringify({ feedback }) });
}

export function completeForemanTask(id: string): Promise<ForemanTask> {
  return json(`/api/foreman/tasks/${id}/complete`, { method: "POST" });
}

export function queueAllForemanTasks(): Promise<{ queued: number }> {
  return json("/api/foreman/queue-all", { method: "POST" });
}

export function getForemanTaskRuns(taskId: string): Promise<ForemanRun[]> {
  return json(`/api/foreman/tasks/${taskId}/runs`);
}

export function getForemanRun(runId: string): Promise<ForemanRun> {
  return json(`/api/foreman/runs/${runId}`);
}

export function syncForemanYaml(): Promise<{ imported: number; updated: number; errors: string[] }> {
  return json("/api/foreman/sync", { method: "POST" });
}

export function cleanupWorktrees(): Promise<{ cleaned: number; errors: string[] }> {
  return json("/api/foreman/cleanup-worktrees", { method: "POST" });
}

export function getForemanConfig(): Promise<ForemanConfig | null> {
  return json("/api/foreman/config");
}

export function updateForemanConfig(data: Partial<ForemanConfig>): Promise<ForemanConfig> {
  return json("/api/foreman/config", { method: "PATCH", body: JSON.stringify(data) });
}

// ─── Director ────────────────────────────────────────────────────────────────

export interface DirectorDirective {
  id: string;
  project_id: string;
  directive: string;
  design_docs: string | null;
  design_doc_path: string | null;
  autonomy_level: string;
  status: string;
  conversation_id: string | null;
  progress: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface DirectorMilestone {
  id: string;
  directive_id: string;
  sequence: number;
  title: string;
  description: string;
  verification: string | null;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface DirectorReview {
  id: string;
  directive_id: string;
  task_id: string | null;
  milestone_id: string | null;
  review_type: string;
  question: string;
  context: string;
  options: string | null;
  response: string | null;
  status: string;
  created_at: string;
  responded_at: string | null;
}

export interface DirectorMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export interface DirectorPollResponse {
  directive: DirectorDirective;
  milestones: DirectorMilestone[];
  tasks: ForemanTask[];
  reviews: DirectorReview[];
}

export function getDirectorDirectives(projectId?: string): Promise<DirectorDirective[]> {
  const qs = projectId ? `?project_id=${projectId}` : "";
  return json(`/api/director/directives${qs}`);
}

export function createDirectorDirective(data: {
  project_id: string; directive: string; design_docs?: string[]; autonomy_level?: string;
}): Promise<DirectorDirective> {
  return json("/api/director/directives", { method: "POST", body: JSON.stringify(data) });
}

export function getDirectorDirective(id: string): Promise<{ directive: DirectorDirective; milestones: DirectorMilestone[]; pendingReviews: DirectorReview[] }> {
  return json(`/api/director/directives/${id}`);
}

export function directorPoll(id: string): Promise<DirectorPollResponse> {
  return json(`/api/director/directives/${id}/poll`);
}

export function pauseDirective(id: string): Promise<DirectorDirective> {
  return json(`/api/director/directives/${id}/pause`, { method: "POST" });
}

export function resumeDirective(id: string): Promise<DirectorDirective> {
  return json(`/api/director/directives/${id}/resume`, { method: "POST" });
}

export function createDirectorConversation(directiveId: string): Promise<{ conversation: { id: string }; messages: DirectorMessage[] }> {
  return json(`/api/director/directives/${directiveId}/conversations`, { method: "POST" });
}

export function getDirectorConversation(id: string): Promise<{ conversation: { id: string; status: string }; messages: DirectorMessage[] }> {
  return json(`/api/director/conversations/${id}`);
}

export function sendDirectorMessage(conversationId: string, content: string): Promise<{ message_id: string }> {
  return json(`/api/director/conversations/${conversationId}/messages`, { method: "POST", body: JSON.stringify({ content }) });
}

export function pollDirectorMessages(conversationId: string, afterId?: string): Promise<{ messages: DirectorMessage[]; generating: boolean; partialText?: string }> {
  const qs = afterId ? `?after=${afterId}` : "";
  return json(`/api/director/conversations/${conversationId}/messages${qs}`);
}

export function approveDirectorConversation(conversationId: string): Promise<{ directive: DirectorDirective; milestones: DirectorMilestone[] }> {
  return json(`/api/director/conversations/${conversationId}/approve`, { method: "POST", timeoutMs: 120_000 });
}

export function getDirectorReviews(status?: string): Promise<DirectorReview[]> {
  const qs = status ? `?status=${status}` : "";
  return json(`/api/director/reviews${qs}`);
}

export function respondToReview(reviewId: string, response: string): Promise<DirectorReview> {
  return json(`/api/director/reviews/${reviewId}/respond`, { method: "POST", body: JSON.stringify({ response }) });
}

export function dismissReview(reviewId: string): Promise<DirectorReview> {
  return json(`/api/director/reviews/${reviewId}/dismiss`, { method: "POST" });
}
