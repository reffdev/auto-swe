/**
 * Drizzle ORM schema — single source of truth for all tables and types.
 */

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ─── Machines ─────────────────────────────────────────────────────────────────

export const machines = sqliteTable("machines", {
  id: text("id").primaryKey(),
  name: text("name").notNull().default(""),
  base_url: text("base_url").notNull(),
  model_id: text("model_id"),  // optional — fallback if project doesn't specify
  machine_type: text("machine_type").notNull().default("inference"), // inference | comfyui | npu
  enabled: integer("enabled").notNull().default(1),
  status: text("status").notNull().default("idle"),  // derived from active run count
  current_run_id: text("current_run_id"),  // legacy — kept for migration, not used
  max_concurrent: integer("max_concurrent").notNull().default(1),
  context_limit: integer("context_limit"),
  api_key: text("api_key"),
  created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ─── Projects ─────────────────────────────────────────────────────────────────

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  workdir: text("workdir").notNull(),
  git_remote: text("git_remote"),
  git_server_token: text("git_server_token"),
  git_default_branch: text("git_default_branch").notNull().default("main"),
  model_id: text("model_id"),
  build_command: text("build_command"),
  test_command: text("test_command"),
  lint_command: text("lint_command"),
  created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ─── Issues ───────────────────────────────────────────────────────────────────

export const issues = sqliteTable("issues", {
  id: text("id").primaryKey(),
  project_id: text("project_id").notNull().references(() => projects.id),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  status: text("status").notNull().default("pending"),
  git_branch: text("git_branch"),
  git_worktree: text("git_worktree"),
  git_pr_url: text("git_pr_url"),
  git_pr_number: integer("git_pr_number"),
  github_issue_number: integer("github_issue_number"),
  github_issue_url: text("github_issue_url"),
  review_lenses: text("review_lenses"), // JSON array, e.g. '["general","security"]'
  parent_id: text("parent_id"),        // references issues(id), null = top-level/standalone
  sequence: integer("sequence"),        // display ordering within an epic, null = standalone
  depends_on: text("depends_on"),      // JSON array of issue IDs this depends on, e.g. '["uuid1","uuid2"]'
  scout_brief: text("scout_brief"),
  scout_commit: text("scout_commit"),  // HEAD commit when scout ran — re-scout if changed
  retry_count: integer("retry_count").notNull().default(0),
  created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  completed_at: text("completed_at"),
});

// ─── Runs ─────────────────────────────────────────────────────────────────────

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  issue_id: text("issue_id").notNull().references(() => issues.id),
  machine_id: text("machine_id"),
  stage: text("stage"),  // 'scout' | 'implement' | 'test_write' | 'review' | null (legacy)
  status: text("status").notNull().default("pending"),
  output: text("output"),
  started_at: text("started_at"),
  completed_at: text("completed_at"),
  duration_ms: integer("duration_ms"),
  prompt_tokens: integer("prompt_tokens"),
  completion_tokens: integer("completion_tokens"),
  created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ─── Analysis ─────────────────────────────────────────────────────────────────

export const analysisConfigs = sqliteTable("analysis_configs", {
  id: text("id").primaryKey(),
  project_id: text("project_id").notNull().references(() => projects.id),
  lens_key: text("lens_key").notNull(),  // e.g. "security", "performance"
  enabled: integer("enabled").notNull().default(1),
  frequency: text("frequency").notNull().default("weekly"),  // "daily" | "weekly" | "monthly"
  last_run_at: text("last_run_at"),
  next_run_at: text("next_run_at"),
  created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const analysisRuns = sqliteTable("analysis_runs", {
  id: text("id").primaryKey(),
  project_id: text("project_id").notNull().references(() => projects.id),
  config_id: text("config_id").notNull().references(() => analysisConfigs.id),
  lens_key: text("lens_key").notNull(),
  machine_id: text("machine_id"),
  status: text("status").notNull().default("pending"),  // pending | running | pass | fail
  findings: text("findings"),  // JSON array of findings
  summary: text("summary"),    // JSON: { critical, high, medium, low, total }
  output: text("output"),      // raw step output for UI (same format as pipeline runs)
  started_at: text("started_at"),
  completed_at: text("completed_at"),
  duration_ms: integer("duration_ms"),
  prompt_tokens: integer("prompt_tokens"),
  completion_tokens: integer("completion_tokens"),
});

// ─── Planner Conversations ────────────────────────────────────────────────

export const plannerConversations = sqliteTable("planner_conversations", {
  id: text("id").primaryKey(),
  project_id: text("project_id").notNull().references(() => projects.id),
  status: text("status").notNull().default("active"), // active | approved | abandoned
  issue_id: text("issue_id"),
  created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  updated_at: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const plannerMessages = sqliteTable("planner_messages", {
  id: text("id").primaryKey(),
  conversation_id: text("conversation_id").notNull().references(() => plannerConversations.id),
  role: text("role").notNull(), // 'user' | 'assistant'
  content: text("content").notNull(),
  created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ─── LLM Requests ─────────────────────────────────────────────────────────────

export const llmRequests = sqliteTable("llm_requests", {
  id: text("id").primaryKey(),
  issue_id: text("issue_id"),
  run_id: text("run_id"),
  model_id: text("model_id"),
  input_text: text("input_text").notNull(),
  output_text: text("output_text").notNull().default(""),
  prompt_tokens: integer("prompt_tokens").notNull().default(0),
  completion_tokens: integer("completion_tokens").notNull().default(0),
  cache_read_tokens: integer("cache_read_tokens").notNull().default(0),
  cache_creation_tokens: integer("cache_creation_tokens").notNull().default(0),
  duration_ms: integer("duration_ms"),
  created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ─── Director Directives ─────────────────────────────────────────────────────

export const directorDirectives = sqliteTable("director_directives", {
  id: text("id").primaryKey(),
  project_id: text("project_id").notNull().references(() => projects.id),
  directive: text("directive").notNull(),
  design_docs: text("design_docs"),                                // JSON string[] of input file paths
  design_doc_path: text("design_doc_path"),                        // path to generated design doc in repo
  autonomy_level: text("autonomy_level").notNull().default("standard"), // conservative|standard|aggressive
  status: text("status").notNull().default("drafting"),            // drafting|conversing|planning|active|paused|completed|failed
  conversation_id: text("conversation_id"),
  progress: text("progress"),                                      // JSON: milestones, decisions, counts
  error_message: text("error_message"),
  created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  completed_at: text("completed_at"),
});

// ─── Director Milestones ─────────────────────────────────────────────────────

export const directorMilestones = sqliteTable("director_milestones", {
  id: text("id").primaryKey(),
  directive_id: text("directive_id").notNull().references(() => directorDirectives.id),
  sequence: integer("sequence").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  verification: text("verification"),                              // what must be true for completion
  status: text("status").notNull().default("pending"),             // pending|active|verifying|completed|failed
  started_at: text("started_at"),
  completed_at: text("completed_at"),
  created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ─── Director Reviews ────────────────────────────────────────────────────────

export const directorReviews = sqliteTable("director_reviews", {
  id: text("id").primaryKey(),
  directive_id: text("directive_id").notNull().references(() => directorDirectives.id),
  task_id: text("task_id"),
  milestone_id: text("milestone_id"),
  review_type: text("review_type").notNull(),                      // task_verify|design_choice|milestone_gate|failure_escalation
  question: text("question").notNull(),
  context: text("context").notNull(),                              // JSON
  options: text("options"),                                        // JSON string[] or null
  response: text("response"),
  status: text("status").notNull().default("pending"),             // pending|responded|dismissed
  created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  responded_at: text("responded_at"),
});

// ─── Director Conversations ──────────────────────────────────────────────────

export const directorConversations = sqliteTable("director_conversations", {
  id: text("id").primaryKey(),
  directive_id: text("directive_id").notNull().references(() => directorDirectives.id),
  status: text("status").notNull().default("active"),              // active|approved|abandoned
  created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  updated_at: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const directorMessages = sqliteTable("director_messages", {
  id: text("id").primaryKey(),
  conversation_id: text("conversation_id").notNull().references(() => directorConversations.id),
  role: text("role").notNull(),                                    // user | assistant
  content: text("content").notNull(),
  created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ─── Foreman Tasks ───────────────────────────────────────────────────────────

export const foremanTasks = sqliteTable("foreman_tasks", {
  id: text("id").primaryKey(),
  yaml_id: text("yaml_id"),                                    // original YAML ID e.g. "001"
  project_id: text("project_id").notNull().references(() => projects.id),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  priority: integer("priority").notNull().default(3),           // 1=highest, 5=lowest
  type: text("type").notNull().default("code"),                 // code | art | music | sfx | review | claude | content
  model: text("model").notNull().default("auto"),               // auto | specific model
  target_files: text("target_files"),                           // JSON string[]
  depends_on: text("depends_on"),                               // JSON string[] of foreman_task IDs
  acceptance_criteria: text("acceptance_criteria"),              // JSON string[]
  status: text("status").notNull().default("backlog"),          // backlog|queued|running|validating|awaiting_review|completed|failed
  machine_id: text("machine_id"),
  resolved_model: text("resolved_model"),
  retry_count: integer("retry_count").notNull().default(0),
  max_retries: integer("max_retries").notNull().default(3),
  error_message: text("error_message"),
  git_branch: text("git_branch"),
  git_worktree: text("git_worktree"),
  git_pr_url: text("git_pr_url"),
  git_pr_number: integer("git_pr_number"),
  next_retry_at: text("next_retry_at"),                         // ISO timestamp for backoff
  started_at: text("started_at"),
  completed_at: text("completed_at"),
  duration_ms: integer("duration_ms"),
  prompt_tokens: integer("prompt_tokens"),
  completion_tokens: integer("completion_tokens"),
  directive_id: text("directive_id"),                               // links to director_directives (null for manual tasks)
  milestone_id: text("milestone_id"),                               // links to director_milestones
  knowledge_extracted: integer("knowledge_extracted").notNull().default(0), // 0=pending, 1=done
  comfyui_config: text("comfyui_config"),                                  // JSON ComfyUITaskConfig
  created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  yaml_synced_at: text("yaml_synced_at"),
});

// ─── Foreman Runs ────────────────────────────────────────────────────────────

export const foremanRuns = sqliteTable("foreman_runs", {
  id: text("id").primaryKey(),
  task_id: text("task_id").notNull().references(() => foremanTasks.id),
  machine_id: text("machine_id"),
  attempt: integer("attempt").notNull().default(1),
  status: text("status").notNull().default("pending"),          // pending|running|validating|pass|fail
  model_id: text("model_id"),
  output: text("output"),                                       // JSON StepData[]
  validation_output: text("validation_output"),                 // JSON ValidationResult[]
  error_message: text("error_message"),
  started_at: text("started_at"),
  completed_at: text("completed_at"),
  duration_ms: integer("duration_ms"),
  prompt_tokens: integer("prompt_tokens"),
  completion_tokens: integer("completion_tokens"),
  created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ─── Foreman Config ──────────────────────────────────────────────────────────

export const foremanConfig = sqliteTable("foreman_config", {
  id: text("id").primaryKey(),
  enabled: integer("enabled").notNull().default(0),             // 0|1 — persisted toggle
  project_id: text("project_id").references(() => projects.id),
  tasks_dir: text("tasks_dir"),                                 // abs path to tasks/backlog/
  priority_mode: text("priority_mode").notNull().default("parallel"), // yield|parallel|exclusive
  tick_interval_ms: integer("tick_interval_ms").notNull().default(30000),
  director_machine_id: text("director_machine_id"),             // machine for Director LLM calls
  director_model_id: text("director_model_id"),                 // model override for Director
  analysis_enabled: integer("analysis_enabled").notNull().default(1), // 0|1 — global analysis toggle
  continuous_exploration: integer("continuous_exploration").notNull().default(0), // 0|1 — keep generating art overnight
  exploration_preset: text("exploration_preset").notNull().default("concept"), // preset for continuous exploration (default: FLUX.2)
  created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
});
