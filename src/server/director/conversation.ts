/**
 * Director conversation — streaming LLM chat for directive clarification.
 *
 * Reuses the exact pattern from src/server/planner-llm.ts:
 * streamText → in-memory activeStreams → polling via GET /messages
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { createModel, stream as llmStream } from "../llm";
import type { Db, Machine } from "../db";
import { buildConversationSystemPrompt } from "./prompts";
import { assembleDirectorContext } from "./memory";
import { webSearchTool } from "../tools/web-search";
import { fetchUrlTool } from "../tools/fetch";
import { lookupDocs } from "../tools/context7";
import { makeReadOnlyTools } from "../tools";
import { makeMemoryTools } from "./memsearch";
import { makeTaskQueryTools } from "../tools/task-query";

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

  console.log(`Director: generating response for conversation ${opts.conversationId} (directive: ${opts.directiveId})`);
  console.log(`Director: using machine "${opts.machine.name || opts.machine.id}" at ${opts.machine.base_url} with model ${opts.modelId}`);

  const model = createModel(opts.machine, opts.modelId);

  // Build context from directive + project
  const directive = db.getDirectorDirective(opts.directiveId);
  const project = directive ? db.getProject(directive.project_id) : null;

  if (!directive) console.warn(`Director: directive ${opts.directiveId} not found`);
  if (!project) console.warn(`Director: project not found for directive ${opts.directiveId}`);

  let projectContext: string | undefined;
  let designDocsContent: string | undefined;

  if (directive && project) {
    console.log(`Director: assembling context for project "${project.name}" (workdir: ${project.workdir})`);
    projectContext = await assembleDirectorContext(db, directive, project, { includeTaskSummaries: false });

    // Read input design docs referenced by the directive
    if (directive.design_docs) {
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

  const toolCount = project
    ? Object.keys(makeReadOnlyTools(project.workdir)).length +
      Object.keys(makeMemoryTools(project.workdir)).length + 3
    : 3;
  console.log(`Director: system prompt ${systemPrompt.length} chars, ${opts.messages.length} message(s), ${toolCount} tools`);

  // Initialize streaming state
  activeStreams.set(opts.conversationId, { text: "", done: false });

  try {
    const result = llmStream({
      model,
      system: systemPrompt,
      messages: opts.messages.map(m => ({ role: m.role, content: m.content })),
      tools: {
        webSearch: webSearchTool,
        fetchUrl: fetchUrlTool,
        lookupDocs,
        ...(project ? {
          ...makeReadOnlyTools(project.workdir),
          ...makeMemoryTools(project.workdir),
          ...makeTaskQueryTools(db, project.id, project.workdir),
        } : {}),
      },
      maxSteps: 50,
    });

    let fullText = "";
    let stepCount = 0;
    for await (const chunk of result.textStream) {
      fullText += chunk;
      activeStreams.set(opts.conversationId, { text: fullText, done: false });
    }

    // Log step details
    try {
      const steps = await result.steps;
      stepCount = steps.length;
      for (const step of steps) {
        const toolCalls = step.toolCalls as Array<{ toolName?: string }> | undefined;
        if (toolCalls?.length) {
          console.log(`Director: step — tool calls: ${toolCalls.map(tc => tc.toolName).join(", ")}`);
        }
      }
    } catch { /* steps not available */ }

    console.log(`Director: response complete — ${fullText.length} chars, ${stepCount} steps`);
    if (!fullText) {
      console.warn(`Director: empty response generated! This usually means the LLM only made tool calls without producing text. Check maxSteps and tool usage.`);
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
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`Director LLM error for conversation ${opts.conversationId}:`, errMsg);
    if (err instanceof Error && err.stack) {
      console.error(`Director LLM stack:`, err.stack);
    }
    const errorText = `Error generating response: ${errMsg.slice(0, 200)}`;
    db.createDirectorMessage({
      conversation_id: opts.conversationId,
      role: "assistant",
      content: errorText,
    });
    activeStreams.set(opts.conversationId, { text: errorText, done: true });
    setTimeout(() => activeStreams.delete(opts.conversationId), 5000);
  }
}
