/**
 * Director conversation — streaming LLM chat for directive clarification.
 *
 * Reuses the exact pattern from src/server/planner-llm.ts:
 * streamText → in-memory activeStreams → polling via GET /messages
 */

import { streamText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Db, Machine } from "../db";
import { buildConversationSystemPrompt } from "./prompts";
import { assembleDirectorContext } from "./memory";

// ─── In-memory streaming state ──────────────────────────────────────────────

interface ActiveStream {
  text: string;
  done: boolean;
}

const activeStreams = new Map<string, ActiveStream>();

export function getDirectorStream(conversationId: string): ActiveStream | null {
  return activeStreams.get(conversationId) ?? null;
}

export function isDirectorGenerating(conversationId: string): boolean {
  const stream = activeStreams.get(conversationId);
  return stream !== undefined && !stream.done;
}

// ─── Response generation ────────────────────────────────────────────────────

export async function generateDirectorResponse(opts: {
  db: Db;
  conversationId: string;
  directiveId: string;
  machine: Machine;
  modelId: string;
  projectName: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<void> {
  const { db } = opts;

  const provider = createOpenAICompatible({
    name: "director",
    baseURL: opts.machine.base_url,
    apiKey: opts.machine.api_key || undefined,
  });
  const model = provider(opts.modelId);

  // Build context from directive + project
  const directive = db.getDirectorDirective(opts.directiveId);
  const project = directive ? db.getProject(directive.project_id) : null;

  let projectContext: string | undefined;
  let designDocsContent: string | undefined;

  if (directive && project) {
    projectContext = assembleDirectorContext(db, directive, project, { includeTaskSummaries: false });

    // Read input design docs referenced by the directive
    if (directive.design_docs) {
      const { readFileSync, existsSync } = await import("fs");
      const { resolve } = await import("path");
      const docPaths: string[] = JSON.parse(directive.design_docs);
      const docs: string[] = [];
      for (const p of docPaths) {
        const fullPath = resolve(project.workdir, p);
        if (existsSync(fullPath)) {
          docs.push(`## ${p}\n\n${readFileSync(fullPath, "utf-8")}`);
        }
      }
      if (docs.length > 0) designDocsContent = docs.join("\n\n---\n\n");
    }
  }

  const systemPrompt = buildConversationSystemPrompt({
    projectName: opts.projectName,
    projectContext,
    designDocsContent,
  });

  // Initialize streaming state
  activeStreams.set(opts.conversationId, { text: "", done: false });

  try {
    const result = streamText({
      model,
      system: systemPrompt,
      messages: opts.messages.map(m => ({ role: m.role, content: m.content })),
    });

    let fullText = "";
    for await (const chunk of result.textStream) {
      fullText += chunk;
      activeStreams.set(opts.conversationId, { text: fullText, done: false });
    }

    // Save final message to DB
    db.createDirectorMessage({
      conversation_id: opts.conversationId,
      role: "assistant",
      content: fullText || "(No response generated)",
    });

    activeStreams.set(opts.conversationId, { text: fullText, done: true });
    setTimeout(() => activeStreams.delete(opts.conversationId), 5000);
  } catch (err) {
    console.error(`Director LLM error for conversation ${opts.conversationId}:`, err);
    const errorText = "Sorry, I encountered an error generating a response. Please try again.";
    db.createDirectorMessage({
      conversation_id: opts.conversationId,
      role: "assistant",
      content: errorText,
    });
    activeStreams.set(opts.conversationId, { text: errorText, done: true });
    setTimeout(() => activeStreams.delete(opts.conversationId), 5000);
  }
}
