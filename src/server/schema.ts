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
  model_id: text("model_id").notNull(),
  enabled: integer("enabled").notNull().default(1),
  status: text("status").notNull().default("idle"),
  current_run_id: text("current_run_id"),
  context_limit: integer("context_limit"),
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
