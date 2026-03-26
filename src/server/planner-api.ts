/**
 * Express router for the interactive issue planner.
 */

import { Router } from "express";
import type { Db } from "./db";
import { selectPlannerMachine, generatePlannerResponse, getActiveStream, isGenerating } from "./planner-llm";

// ─── Issue proposal parsing ──────────────────────────────────────────────────

export function parseIssueProposal(content: string): {
  title: string;
  description: string;
  lenses: string[];
} | null {
  const match = content.match(/```issue_proposal\s*\n([\s\S]*?)```/);
  if (!match) return null;

  const block = match[1];

  // Parse title
  const titleMatch = block.match(/^title:\s*(.+)$/m);
  if (!titleMatch) return null;
  const title = titleMatch[1].trim();

  // Parse description — everything between "description:" and "review_lenses:"
  const descMatch = block.match(/description:\s*\n?([\s\S]*?)(?=\n?review_lenses:|$)/);
  const description = descMatch ? descMatch[1].trim() : "";

  // Parse review lenses
  const lensMatch = block.match(/review_lenses:\s*(.+)$/m);
  const lensStr = lensMatch?.[1]?.trim() ?? "general";
  const lenses = lensStr.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);

  return { title, description, lenses };
}

// ─── Router ──────────────────────────────────────────────────────────────────

export function createPlannerRouter(db: Db): Router {
  const router = Router();

  // POST /conversations — create a new planner conversation
  router.post("/conversations", (req, res) => {
    const { project_id } = req.body;
    if (!project_id) {
      return res.status(400).json({ error: "project_id is required" });
    }
    const project = db.getProject(project_id);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    const conversation = db.createPlannerConversation({ project_id });
    const messages = db.getPlannerMessages(conversation.id);
    res.status(201).json({ ...conversation, messages });
  });

  // GET /conversations/:id — get conversation with all messages
  router.get("/conversations/:id", (req, res) => {
    const conversation = db.getPlannerConversation(req.params.id);
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }
    const messages = db.getPlannerMessages(conversation.id);
    res.json({ ...conversation, messages });
  });

  // POST /conversations/:id/messages — send a user message, trigger LLM response
  router.post("/conversations/:id/messages", (req, res) => {
    const conversation = db.getPlannerConversation(req.params.id);
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }
    if (conversation.status !== "active") {
      return res.status(400).json({ error: "Conversation is not active" });
    }
    if (isGenerating(conversation.id)) {
      return res.status(409).json({ error: "A response is already being generated" });
    }

    const { content } = req.body;
    if (!content?.trim()) {
      return res.status(400).json({ error: "content is required" });
    }

    // Save the user message
    const message = db.createPlannerMessage({
      conversation_id: conversation.id,
      role: "user",
      content: content.trim(),
    });

    // Find a machine for the LLM call
    const project = db.getProject(conversation.project_id);
    if (!project) {
      return res.status(500).json({ error: "Project not found" });
    }
    const selected = selectPlannerMachine(db, project);
    if (!selected) {
      return res.status(503).json({ error: "No enabled machines available" });
    }

    // Trigger async LLM response (don't await)
    const allMessages = db.getPlannerMessages(conversation.id);
    generatePlannerResponse({
      db,
      conversationId: conversation.id,
      machine: selected.machine,
      modelId: selected.modelId,
      projectName: project.name,
      messages: allMessages.map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
    }).catch(err => {
      console.error("Planner response generation failed:", err);
    });

    // Return 202 immediately
    res.status(202).json({ message_id: message.id });
  });

  // GET /conversations/:id/messages — poll for messages
  router.get("/conversations/:id/messages", (req, res) => {
    const conversation = db.getPlannerConversation(req.params.id);
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const afterId = req.query.after as string | undefined;
    const messages = db.getPlannerMessages(conversation.id, afterId || undefined);

    // Check for active stream
    const stream = getActiveStream(conversation.id);
    const generating = stream ? !stream.done : false;
    const partialText = (stream && !stream.done) ? stream.text : undefined;

    res.json({ messages, generating, partialText });
  });

  // POST /conversations/:id/approve — create an issue from the conversation
  router.post("/conversations/:id/approve", (req, res) => {
    const conversation = db.getPlannerConversation(req.params.id);
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }
    if (conversation.status !== "active") {
      return res.status(400).json({ error: "Conversation is not active" });
    }
    if (isGenerating(conversation.id)) {
      return res.status(409).json({ error: "Wait for the response to finish before approving" });
    }

    // Find the last assistant message with an issue_proposal
    const messages = db.getPlannerMessages(conversation.id);
    let proposal: ReturnType<typeof parseIssueProposal> = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        proposal = parseIssueProposal(messages[i].content);
        if (proposal) break;
      }
    }

    if (!proposal) {
      return res.status(400).json({ error: "No issue proposal found in conversation. Ask the planner to produce one first." });
    }

    // Allow caller to override lenses
    const lenses = req.body.reviewLenses?.length ? req.body.reviewLenses : proposal.lenses;

    // Create the issue
    const issue = db.createIssue({
      project_id: conversation.project_id,
      title: proposal.title,
      description: proposal.description,
    });

    // Mark conversation as approved
    db.updatePlannerConversation(conversation.id, {
      status: "approved",
      issue_id: issue.id,
      updated_at: new Date().toISOString(),
    });

    res.status(201).json({ issue, reviewLenses: lenses });
  });

  // DELETE /conversations/:id — abandon a conversation
  router.delete("/conversations/:id", (req, res) => {
    const conversation = db.getPlannerConversation(req.params.id);
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    db.updatePlannerConversation(conversation.id, {
      status: "abandoned",
      updated_at: new Date().toISOString(),
    });

    res.status(204).end();
  });

  return router;
}
