/**
 * Director API routes — directives, conversations, reviews, milestones.
 */

import { Router } from "express";
import type { Db } from "../db";
import { selectPlannerMachine } from "../planner-llm";
import { generateDirectorResponse, getDirectorStream, isDirectorGenerating } from "./conversation";
import { decomposeDirective } from "./decomposer";
import { planNextTasks } from "./planner";
import { nudgeDirector } from "./scheduler";

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
    const created = db.createDirectorDirective({ project_id, directive, design_docs, autonomy_level });
    res.status(201).json(created);
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

    res.status(201).json({ conversation, messages: db.getDirectorMessages(conversation.id) });
  });

  router.get("/conversations/:id", (req, res) => {
    const conversation = db.getDirectorConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });
    const messages = db.getDirectorMessages(conversation.id);
    res.json({ conversation, messages });
  });

  router.post("/conversations/:id/messages", (req, res) => {
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

    // Select machine
    const machineInfo = selectPlannerMachine(db, project);
    if (!machineInfo) return res.status(503).json({ error: "No machine available" });

    // Get all messages for context
    const allMessages = db.getDirectorMessages(conversation.id);

    // Fire and forget — streaming response
    generateDirectorResponse({
      db,
      conversationId: conversation.id,
      directiveId: directive.id,
      machine: machineInfo.machine,
      modelId: machineInfo.modelId,
      projectName: project.name,
      messages: allMessages.map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
    }).catch(err => console.error("Director conversation error:", err));

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

      // Generate initial tasks for first milestone
      const updatedDirective = db.getDirectorDirective(directive.id)!;
      const milestones = db.getDirectorMilestones(directive.id);
      const firstMilestone = milestones[0];

      if (firstMilestone) {
        await planNextTasks(db, updatedDirective, project, firstMilestone);
      }

      res.json({
        directive: db.getDirectorDirective(directive.id),
        milestones: db.getDirectorMilestones(directive.id),
        designDocPath: result.designDocPath,
        milestoneCount: result.milestoneCount,
      });
    } catch (err) {
      db.updateDirectorDirective(directive.id, {
        status: "failed",
        error_message: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
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

  return router;
}
