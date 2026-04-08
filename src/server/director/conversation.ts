/**
 * Director conversation — streaming LLM chat for directive clarification.
 *
 * Reuses the exact pattern from src/server/planner-llm.ts:
 * streamText → in-memory activeStreams → polling via GET /messages
 */

import { readFile as fsReadFile } from "fs/promises";
import { resolve } from "path";
import { stream as llmStream } from "../llm";
import type { LlmSession } from "../llm-dispatch";
import type { Db } from "../db";
import { buildConversationSystemPrompt } from "./prompts";
import { assembleDirectorContext } from "./memory";
import { webSearchTool } from "../tools/web-search";
import { fetchUrlTool } from "../tools/fetch";
import { lookupDocs } from "../tools/context7";
import { makeReadOnlyTools } from "../tools";
import { makeMemoryTools } from "./memsearch";
import { makeTaskQueryTools } from "../tools/task-query";
import { makeDirectorReadTools } from "../tools/director-read";
import { makeDirectorOpinionTools } from "../tools/director-opinion";
import { buildSandboxProfile } from "../util/sandbox";

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
  session: LlmSession;
  projectName: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<void> {
  const { db } = opts;
  const { machine, providerModelId: modelId, llm: model } = opts.session;

  console.log(`[director:conversation] generating response for ${opts.conversationId} (directive: ${opts.directiveId}) via "${machine.name || machine.id}" model ${modelId}`);

  // Build context from directive + project
  const directive = db.getDirectorDirective(opts.directiveId);
  const project = directive ? db.getProject(directive.project_id) : null;

  if (!directive) console.warn(`[director] directive ${opts.directiveId} not found`);
  if (!project) console.warn(`[director] project not found for directive ${opts.directiveId}`);

  let projectContext: string | undefined;
  let designDocsContent: string | undefined;

  if (directive && project) {
    console.log(`[director] assembling context for project "${project.name}" (workdir: ${project.workdir})`);
    projectContext = await assembleDirectorContext(db, directive, project, { includeTaskSummaries: false });

    // Read input design docs referenced by the directive
    if (directive.design_docs) {
      const docPaths: string[] = JSON.parse(directive.design_docs);
      const docs: string[] = [];
      for (const p of docPaths) {
        const fullPath = resolve(project.workdir, p);
        try {
          const content = await fsReadFile(fullPath, "utf-8");
          docs.push(`## ${p}\n\n${content}`);
        } catch { /* missing is OK */ }
      }
      if (docs.length > 0) designDocsContent = docs.join("\n\n---\n\n");
    }
  }

  const systemPrompt = buildConversationSystemPrompt({
    projectName: opts.projectName,
    projectContext,
    designDocsContent,
  });

  // Build the Director observation sandbox (RO worktree, no network).
  // Constructed once per response — read-only project bind, no subprocess
  // network. Composes with the existing analysis sandbox profile.
  const directorSandbox = project
    ? await buildSandboxProfile(db, project, project.workdir, { readOnlyWorktree: true, allowNetwork: false })
    : undefined;

  const directorReadTools = project ? makeDirectorReadTools(project.workdir, project, directorSandbox) : {};
  const directorOpinionTools = project
    ? makeDirectorOpinionTools(db, project, { model, sandbox: directorSandbox, directiveId: opts.directiveId })
    : {};

  const toolCount = project
    ? Object.keys(makeReadOnlyTools(project.workdir)).length +
      Object.keys(makeMemoryTools(project.workdir)).length +
      Object.keys(directorReadTools).length +
      Object.keys(directorOpinionTools).length + 3
    : 3;
  console.log(`[director] system prompt ${systemPrompt.length} chars, ${opts.messages.length} message(s), ${toolCount} tools`);

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
          ...makeReadOnlyTools(project.workdir, undefined, directorSandbox),
          ...makeMemoryTools(project.workdir),
          ...makeTaskQueryTools(db, project.id, project.workdir),
          ...directorReadTools,
          ...directorOpinionTools,
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
          console.log(`[director] step — tool calls: ${toolCalls.map(tc => tc.toolName).join(", ")}`);
        }
      }
    } catch { /* steps not available */ }

    console.log(`[director] response complete — ${fullText.length} chars, ${stepCount} steps`);
    if (!fullText) {
      console.warn(`[director] empty response generated! This usually means the LLM only made tool calls without producing text. Check maxSteps and tool usage.`);
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
    console.error(`[director:conversation] LLM error for ${opts.conversationId}:`, errMsg);
    if (err instanceof Error && err.stack) {
      console.error(`[director:conversation] LLM stack:`, err.stack);
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
