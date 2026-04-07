/**
 * Director API routes — directives, conversations, reviews, milestones.
 */

import { Router } from "express";
import { runProcess } from "../util/async-process";
import type { Db } from "../db";
import { getUnattributedCommits } from "./unattributed-commits";
import { generateDirectorResponse, getDirectorStream, isDirectorGenerating } from "./conversation";
import { decomposeDirective } from "./decomposer";
import { planNextTasks } from "./planner";
import { nudgeDirector } from "./scheduler";
import { withLlmSession } from "../llm-dispatch";
import { getDirectorModelId, getDirectorPreferredMachineId, ModelSlotUnconfiguredError } from "../models";


export function createDirectorRouter(db: Db): Router {
  const router = Router();

  // ─── Directives ──────────────────────────────────────────────────────────

  router.get("/directives", (req, res) => {
    const { project_id } = req.query as { project_id?: string };
    const directives = db.getDirectorDirectives(project_id ?? undefined);
    res.json(directives);
  });

  router.get("/directives/:id", (req, res) => {
    const directive = db.getDirectorDirective(req.params.id);
    if (!directive) return res.status(404).json({ error: "Directive not found" });
    const milestones = db.getDirectorMilestones(directive.id);
    const reviews = db.getDirectorReviews(directive.id, "pending");
    res.json({ directive, milestones, pendingReviews: reviews });
  });

  router.post("/directives", (req, res) => {
    const { project_id, directive, design_docs, autonomy_level } = req.body;
    if (!project_id || !directive) {
      return res.status(400).json({ error: "project_id and directive are required" });
    }
    // Prevent concurrent active directives on the same project
    const existing = db.getDirectorDirectives(project_id);
    const active = existing.find(d => ["conversing", "planning", "active", "paused"].includes(d.status));
    if (active) {
      return res.status(409).json({ error: `Project already has an active directive: "${active.directive.slice(0, 80)}"` });
    }
    const created = db.createDirectorDirective({ project_id, directive, design_docs, autonomy_level });
    res.status(201).json(created);
  });

  router.delete("/directives/:id", (req, res) => {
    const directive = db.getDirectorDirective(req.params.id);
    if (!directive) return res.status(404).json({ error: "Directive not found" });

    // Don't delete actively running directives
    if (directive.status === "active" || directive.status === "planning") {
      return res.status(409).json({ error: `Cannot delete directive with status "${directive.status}". Pause or complete it first.` });
    }

    db.deleteDirectorDirective(directive.id);
    res.status(204).end();
  });

  router.get("/directives/:id/poll", (req, res) => {
    const directive = db.getDirectorDirective(req.params.id);
    if (!directive) return res.status(404).json({ error: "Directive not found" });
    const milestones = db.getDirectorMilestones(directive.id);
    const tasks = db.getDirectiveTasks(directive.id);
    const reviews = db.getDirectorReviews(directive.id);
    res.json({ directive, milestones, tasks, reviews });
  });

  router.post("/directives/:id/pause", (req, res) => {
    const directive = db.getDirectorDirective(req.params.id);
    if (!directive) return res.status(404).json({ error: "Directive not found" });
    db.updateDirectorDirective(directive.id, { status: "paused" });
    res.json(db.getDirectorDirective(directive.id));
  });

  router.post("/directives/:id/resume", (req, res) => {
    const directive = db.getDirectorDirective(req.params.id);
    if (!directive) return res.status(404).json({ error: "Directive not found" });
    db.updateDirectorDirective(directive.id, { status: "active" });
    nudgeDirector(db);
    res.json(db.getDirectorDirective(directive.id));
  });

  // ─── Conversations ───────────────────────────────────────────────────────

  router.post("/directives/:id/conversations", (req, res) => {
    const directive = db.getDirectorDirective(req.params.id);
    if (!directive) return res.status(404).json({ error: "Directive not found" });

    const conversation = db.createDirectorConversation({ directive_id: directive.id });
    db.updateDirectorDirective(directive.id, {
      conversation_id: conversation.id,
      status: "conversing",
    });

    // Seed with the directive as the first user message
    db.createDirectorMessage({
      conversation_id: conversation.id,
      role: "user",
      content: directive.directive,
    });

    // Auto-trigger Director LLM response to the initial directive
    const project = db.getProject(directive.project_id);
    if (project) {
      let directorModelId: string | null = null;
      try { directorModelId = getDirectorModelId(db); } catch { /* slot unconfigured — skip auto-response */ }
      if (directorModelId) {
        const allMessages = db.getDirectorMessages(conversation.id);
        void withLlmSession(
          db,
          "director",
          `initial: ${directive.directive.slice(0, 40)}`,
          directorModelId,
          async (session) => generateDirectorResponse({
            db,
            conversationId: conversation.id,
            directiveId: directive.id,
            session,
            projectName: project.name,
            messages: allMessages.map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
          }),
          { preferMachineId: getDirectorPreferredMachineId(db) },
        ).catch(err => console.error("[director] initial response error:", err));
      }
    }

    res.status(201).json({ conversation, messages: db.getDirectorMessages(conversation.id) });
  });

  router.get("/conversations/:id", (req, res) => {
    const conversation = db.getDirectorConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });
    const messages = db.getDirectorMessages(conversation.id);
    res.json({ conversation, messages });
  });

  router.post("/conversations/:id/messages", async (req, res) => {
    const conversation = db.getDirectorConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });
    if (conversation.status !== "active") {
      return res.status(409).json({ error: "Conversation is not active" });
    }

    const { content } = req.body;
    if (!content) return res.status(400).json({ error: "content is required" });

    // Save user message
    const msg = db.createDirectorMessage({ conversation_id: conversation.id, role: "user", content });

    // Find directive for context
    const directives = db.getDirectorDirectives();
    const directive = directives.find(d => d.conversation_id === conversation.id);
    if (!directive) return res.status(500).json({ error: "Directive not found for conversation" });

    const project = db.getProject(directive.project_id);
    if (!project) return res.status(500).json({ error: "Project not found" });

    // Director slot supplies the model.
    let directorModelId: string;
    try {
      directorModelId = getDirectorModelId(db);
    } catch (err) {
      if (err instanceof ModelSlotUnconfiguredError) {
        return res.status(409).json({ error: err.message });
      }
      throw err;
    }

    // Get all messages for context
    const allMessages = db.getDirectorMessages(conversation.id);

    // Fire-and-forget: open a session, run the LLM call inside it, release on completion.
    void withLlmSession(
      db,
      "director",
      `conversation: ${directive.directive.slice(0, 40)}`,
      directorModelId,
      async (session) => {
        console.log(`[director:message] using machine "${session.machine.name || session.machine.id}" (${session.providerModelId}) for conversation ${conversation.id}`);
        return generateDirectorResponse({
          db,
          conversationId: conversation.id,
          directiveId: directive.id,
          session,
          projectName: project.name,
          messages: allMessages.map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
        });
      },
      { preferMachineId: getDirectorPreferredMachineId(db) },
    ).catch(err => console.error("[director:conversation] error:", err));

    res.status(202).json({ message_id: msg.id });
  });

  router.get("/conversations/:id/messages", (req, res) => {
    const conversation = db.getDirectorConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });

    const afterId = req.query.after as string | undefined;
    const messages = db.getDirectorMessages(conversation.id, afterId);
    const stream = getDirectorStream(conversation.id);
    const generating = isDirectorGenerating(conversation.id);

    res.json({
      messages,
      generating,
      partialText: generating ? stream?.text : undefined,
    });
  });

  router.post("/conversations/:id/retry", async (req, res) => {
    const conversation = db.getDirectorConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });

    if (isDirectorGenerating(conversation.id)) {
      return res.status(409).json({ error: "Already generating" });
    }

    const directives = db.getDirectorDirectives();
    const directive = directives.find(d => d.conversation_id === conversation.id);
    if (!directive) return res.status(500).json({ error: "Directive not found" });

    const project = db.getProject(directive.project_id);
    if (!project) return res.status(500).json({ error: "Project not found" });

    let directorModelId: string;
    try {
      directorModelId = getDirectorModelId(db);
    } catch (err) {
      if (err instanceof ModelSlotUnconfiguredError) {
        return res.status(409).json({ error: err.message });
      }
      throw err;
    }

    // Delete the last assistant message (the failed one)
    const allMessages = db.getDirectorMessages(conversation.id);
    const lastAssistant = [...allMessages].reverse().find(m => m.role === "assistant");
    if (lastAssistant) {
      db.deleteDirectorMessage(lastAssistant.id);
    }

    // Re-trigger generation with remaining messages
    const remainingMessages = db.getDirectorMessages(conversation.id);
    void withLlmSession(
      db,
      "director",
      `retry: ${directive.directive.slice(0, 40)}`,
      directorModelId,
      async (session) => {
        console.log(`[director:retry] using machine "${session.machine.name || session.machine.id}" (${session.providerModelId}) for conversation ${conversation.id}`);
        return generateDirectorResponse({
          db,
          conversationId: conversation.id,
          directiveId: directive.id,
          session,
          projectName: project.name,
          messages: remainingMessages.map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
        });
      },
      { preferMachineId: getDirectorPreferredMachineId(db) },
    ).catch(err => console.error("[director:retry] error:", err));

    res.status(202).json({ retrying: true });
  });

  router.post("/conversations/:id/approve", async (req, res) => {
    const conversation = db.getDirectorConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });

    const directives = db.getDirectorDirectives();
    const directive = directives.find(d => d.conversation_id === conversation.id);
    if (!directive) return res.status(500).json({ error: "Directive not found for conversation" });

    const project = db.getProject(directive.project_id);
    if (!project) return res.status(500).json({ error: "Project not found" });

    try {
      // Decompose: extract design doc + milestones from conversation
      db.updateDirectorDirective(directive.id, { status: "planning" });
      const result = await decomposeDirective(db, directive, project);

      // Mark conversation as approved
      db.updateDirectorConversation(conversation.id, { status: "approved" });

      // Generate initial tasks for first milestone (fire and forget — don't block the response)
      const updatedDirective = db.getDirectorDirective(directive.id)!;
      const milestones = db.getDirectorMilestones(directive.id);
      const firstMilestone = milestones[0];

      if (firstMilestone) {
        console.log(`[director] approved — starting task planning for milestone "${firstMilestone.title}"`);
        void planNextTasks(db, updatedDirective, project, firstMilestone)
          .catch(err => console.error("[director] initial task planning failed:", err));
      }

      res.json({
        directive: db.getDirectorDirective(directive.id),
        milestones: db.getDirectorMilestones(directive.id),
        designDocPath: result.designDocPath,
        milestoneCount: result.milestoneCount,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Revert to conversing so the user can send another message to fix the plan format
      db.updateDirectorDirective(directive.id, {
        status: "conversing",
        error_message: msg,
      });
      // Add an assistant message explaining what went wrong
      db.createDirectorMessage({
        conversation_id: conversation.id,
        role: "assistant",
        content: `Plan approval failed: ${msg}\n\nPlease make sure your plan includes both a \`\`\`design_doc and \`\`\`milestones block. You can send another message to ask me to reformulate.`,
      });
      res.status(422).json({ error: msg });
    }
  });

  // ─── Reviews ─────────────────────────────────────────────────────────────

  router.get("/reviews", (req, res) => {
    const { status, directive_id } = req.query as { status?: string; directive_id?: string };
    const reviews = db.getDirectorReviews(directive_id ?? undefined, status ?? undefined);
    res.json(reviews);
  });

  router.get("/reviews/:id", (req, res) => {
    const review = db.getDirectorReview(req.params.id);
    if (!review) return res.status(404).json({ error: "Review not found" });
    res.json(review);
  });

  router.post("/reviews/:id/respond", (req, res) => {
    const review = db.getDirectorReview(req.params.id);
    if (!review) return res.status(404).json({ error: "Review not found" });
    if (review.status !== "pending") {
      return res.status(409).json({ error: "Review already responded to" });
    }

    const { response } = req.body;
    if (!response) return res.status(400).json({ error: "response is required" });

    db.updateDirectorReview(review.id, {
      response,
      status: "responded",
      responded_at: new Date().toISOString(),
    });

    nudgeDirector(db);
    res.json(db.getDirectorReview(review.id));
  });

  router.post("/reviews/:id/dismiss", (req, res) => {
    const review = db.getDirectorReview(req.params.id);
    if (!review) return res.status(404).json({ error: "Review not found" });

    db.updateDirectorReview(review.id, { status: "dismissed" });
    nudgeDirector(db);
    res.json(db.getDirectorReview(review.id));
  });

  // ─── Milestones ──────────────────────────────────────────────────────────

  router.get("/directives/:id/milestones", (req, res) => {
    const milestones = db.getDirectorMilestones(req.params.id);
    res.json(milestones);
  });

  // ─── Manual Commits ─────────────────────────────────────────────────────

  router.get("/unattributed-commits", async (req, res) => {
    const { project_id } = req.query as { project_id?: string };
    if (!project_id) return res.status(400).json({ error: "project_id required" });

    const project = db.getProject(project_id);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const commits = await getUnattributedCommits(db, project);
    res.json({ commits });
  });

  /**
   * Submit manual commits as a completed task.
   * Creates a foreman task with status=completed, linking the commit SHAs.
   */
  router.post("/submit-commits", async (req, res) => {
    const { project_id, title, description, commit_shas, directive_id, milestone_id } = req.body as {
      project_id: string;
      title: string;
      description: string;
      commit_shas: string[];
      directive_id?: string;
      milestone_id?: string;
    };

    if (!project_id || !title || !commit_shas?.length) {
      return res.status(400).json({ error: "project_id, title, and commit_shas required" });
    }

    const project = db.getProject(project_id);
    if (!project) return res.status(404).json({ error: "Project not found" });

    // Build a diff summary for context
    let diffSummary = "";
    try {
      for (const sha of commit_shas) {
        const diff = await runProcess("git", ["show", "--stat", sha], {
          cwd: project.workdir, timeoutMs: 10_000,
        });
        if (diff.status === 0) diffSummary += diff.stdout + "\n";
      }
    } catch { /* skip */ }

    const fullDescription = [
      description,
      "",
      `[commits: ${commit_shas.join(", ")}]`,
      `[manual_submission]`,
      "",
      diffSummary ? `## Files Changed\n\`\`\`\n${diffSummary.trim()}\n\`\`\`` : "",
    ].filter(Boolean).join("\n");

    const task = db.createForemanTask({
      project_id,
      title,
      description: fullDescription,
      priority: 3,
      type: "code",
      model_id: null,
      target_files: [],
      depends_on: [],
      acceptance_criteria: [],
      max_retries: 0,
      status: "completed",
      directive_id: directive_id ?? undefined,
      milestone_id: milestone_id ?? undefined,
    });

    // Use the earliest commit's date as completed_at for chronological ordering
    let completedAt = new Date().toISOString();
    try {
      const dateResult = await runProcess("git", ["show", "-s", "--format=%aI", commit_shas[commit_shas.length - 1]], {
        cwd: project.workdir, timeoutMs: 5_000,
      });
      if (dateResult.status === 0 && dateResult.stdout.trim()) {
        completedAt = new Date(dateResult.stdout.trim()).toISOString();
      }
    } catch { /* fall back to now */ }

    db.updateForemanTask(task.id, { completed_at: completedAt });

    console.log(`[director] manual commit submission "${title}" — ${commit_shas.length} commit(s)`);
    res.json(task);
  });

  return router;
}
