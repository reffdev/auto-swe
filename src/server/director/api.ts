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
import { acquireLease, releaseLease } from "../machine-manager";

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
      const machineInfo = selectPlannerMachine(db, project);
      if (machineInfo) {
        const allMessages = db.getDirectorMessages(conversation.id);
        void generateDirectorResponse({
          db,
          conversationId: conversation.id,
          directiveId: directive.id,
          machine: machineInfo.machine,
          modelId: machineInfo.modelId,
          projectName: project.name,
          messages: allMessages.map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
        }).catch(err => console.error("Director initial response error:", err));
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

    // Select machine and acquire lease
    const machineInfo = selectPlannerMachine(db, project);
    if (!machineInfo) return res.status(503).json({ error: "No machine available" });

    const leaseResult = acquireLease(db, "director", `conversation: ${directive.directive.slice(0, 40)}`, {
      preferredMachineId: machineInfo.machine.id,
    });
    if (!leaseResult) return res.status(503).json({ error: "No machine available (all busy)" });

    console.log(`Director message: using machine "${leaseResult.machine.name || leaseResult.machine.id}" (${machineInfo.modelId}) for conversation ${conversation.id}`);

    // Get all messages for context
    const allMessages = db.getDirectorMessages(conversation.id);

    // Fire and forget — streaming response, release lease when done
    const leaseId = leaseResult.lease.id;
    generateDirectorResponse({
      db,
      conversationId: conversation.id,
      directiveId: directive.id,
      machine: leaseResult.machine,
      modelId: machineInfo.modelId,
      projectName: project.name,
      messages: allMessages.map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
    })
      .catch(err => console.error("Director conversation error:", err))
      .finally(() => releaseLease(leaseId));

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

  router.post("/conversations/:id/retry", (req, res) => {
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

    const machineInfo = selectPlannerMachine(db, project);
    if (!machineInfo) return res.status(503).json({ error: "No machine available" });

    const leaseResult = acquireLease(db, "director", `retry: ${directive.directive.slice(0, 40)}`, {
      preferredMachineId: machineInfo.machine.id,
    });
    if (!leaseResult) return res.status(503).json({ error: "No machine available (all busy)" });

    console.log(`Director retry: using machine "${leaseResult.machine.name || leaseResult.machine.id}" (${machineInfo.modelId}) for conversation ${conversation.id}`);

    // Delete the last assistant message (the failed one)
    const allMessages = db.getDirectorMessages(conversation.id);
    const lastAssistant = [...allMessages].reverse().find(m => m.role === "assistant");
    if (lastAssistant) {
      db.deleteDirectorMessage(lastAssistant.id);
    }

    // Re-trigger generation with remaining messages
    const leaseId = leaseResult.lease.id;
    const remainingMessages = db.getDirectorMessages(conversation.id);
    generateDirectorResponse({
      db,
      conversationId: conversation.id,
      directiveId: directive.id,
      machine: leaseResult.machine,
      modelId: machineInfo.modelId,
      projectName: project.name,
      messages: remainingMessages.map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
    })
      .catch(err => console.error("Director retry error:", err))
      .finally(() => releaseLease(leaseId));

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
        console.log(`Director: approved — starting task planning for milestone "${firstMilestone.title}"`);
        void planNextTasks(db, updatedDirective, project, firstMilestone)
          .catch(err => console.error("Director: initial task planning failed:", err));
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

  return router;
}
