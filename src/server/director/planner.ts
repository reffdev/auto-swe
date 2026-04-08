/**
 * Director planner — dynamic task generation based on current project state.
 *
 * Called whenever the Director needs more tasks to work on:
 * - After initial decomposition (first batch)
 * - After all current tasks complete (next batch)
 * - After a milestone transitions (new milestone tasks)
 */

import { randomUUID } from "crypto";
import { stream as llmStream } from "../llm";
import { withLlmSession } from "../llm-dispatch";
import { getDirectorModelId, getDirectorPreferredMachineId, ModelSlotUnconfiguredError, NoMachineHostsModelError, ModelNotFoundError } from "../models";
import { MACHINE_TYPE_TASK_TYPES } from "../foreman/task-types";
import type { Db, DirectorDirective, DirectorMilestone, Project } from "../db";
import { assembleDirectorContext } from "./memory";
import { buildPlanningPrompt } from "./prompts";
import { parseNextTasks, parseWaitBlock } from "./parsers";
import { webSearchTool } from "../tools/web-search";
import { fetchUrlTool } from "../tools/fetch";
import { lookupDocs } from "../tools/context7";
import { makeReadOnlyTools } from "../tools";
import { makeMemoryTools } from "./memsearch";
import { postProcessArtTasks } from "./art-task-processor";
import { makeTaskQueryTools } from "../tools/task-query";
import { makeDirectorReadTools } from "../tools/director-read";
import { makeDirectorOpinionTools } from "../tools/director-opinion";
import { buildSandboxProfile } from "../util/sandbox";
import { ToolLoopGuard } from "../util/tool-loop-guard";
import { loadWorkflowManifest, summarizeManifestForPrompt } from "../foreman/workflow-manifest";

import { nudgeForeman } from "../foreman/scheduler";
import { logEpisodic } from "./persistent-memory";
import { autonomyBudgets } from "./review-gates";

/**
 * Generate the next batch of tasks for the active milestone.
 * Creates foreman_tasks and queues them for execution.
 */
export async function planNextTasks(
  db: Db,
  directive: DirectorDirective,
  project: Project,
  milestone: DirectorMilestone,
  /** Machine types that are idle and need work. When set, the planner prioritizes generating tasks for these types. */
  idleMachineTypes?: string[],
  /** Verification issues that triggered corrective planning. The planner must generate fix tasks for these. */
  verificationIssues?: string[],
  /** When true, the planner is being asked to verify a complete milestone (call advanceMilestone) instead of generating new work. */
  verificationMode?: boolean,
  /** Which corrective attempt this is (1-indexed). Used to nudge the planner to take a fundamentally different approach on later attempts. */
  correctionAttempt?: number,
): Promise<number> {
  const planStartTime = Date.now();
  const reason = verificationMode ? "verification" : verificationIssues?.length ? `corrective (attempt ${correctionAttempt ?? 1})` : idleMachineTypes?.length ? `top-up (idle: ${idleMachineTypes.join(", ")})` : "initial";
  console.log(`[director:planner] "${milestone.title}" — ${reason}`);

  // Director slot supplies the planner model.
  let directorModelId: string;
  try {
    directorModelId = getDirectorModelId(db);
  } catch (err) {
    if (err instanceof ModelSlotUnconfiguredError) {
      console.error(`[director:planner] ${err.message}`);
      return 0;
    }
    throw err;
  }

  // Assemble context + manifest + prompt
  const contextStartTime = Date.now();
  const directiveContext = await assembleDirectorContext(db, directive, project, {
    includeTaskSummaries: true,
    maxRecentTasks: 10,
  });
  const workflowManifest = await loadWorkflowManifest(project.workdir);
  const workflowSummary = workflowManifest ? summarizeManifestForPrompt(workflowManifest) : null;

  const { system, user } = buildPlanningPrompt({
    directiveContext,
    milestoneTitle: milestone.title,
    milestoneVerification: milestone.verification ?? "Not specified",
    workflowSummary,
    idleMachineTypes,
    verificationIssues,
    verificationMode,
    milestoneId: milestone.id,
    correctionAttempt,
  });

  const totalPromptChars = system.length + user.length;
  const estimatedTokens = Math.round(totalPromptChars / 4);
  console.log(`[director:planner] context ready — ~${estimatedTokens} tokens, ${Math.round((Date.now() - contextStartTime) / 1000)}s`);

  // Build the Director observation sandbox (RO worktree, no network) once
  // for this planning call. Composes with the existing analysis sandbox.
  const directorSandbox = await buildSandboxProfile(db, project, project.workdir, {
    readOnlyWorktree: true,
    allowNetwork: false,
  });

  // The non-LLM-backed tools can be constructed up front. The opinion tools
  // need the model instance which is only available inside the withLlmSession
  // callback, so we construct those lazily there.
  const baseTools = (() => {
    try {
      return {
        webSearch: webSearchTool,
        fetchUrl: fetchUrlTool,
        lookupDocs,
        ...makeReadOnlyTools(project.workdir, undefined, directorSandbox),
        ...makeMemoryTools(project.workdir),
        ...makeTaskQueryTools(db, project.id, project.workdir),
        ...makeDirectorReadTools(project.workdir, project, directorSandbox),
      };
    } catch (toolErr) {
      console.error("[director:planner] tool construction failed:", toolErr);
      throw toolErr;
    }
  })();

  // Open a session for the LLM call. Hold the lease only for the duration of
  // the LLM streaming — task creation/parsing happens after the session closes.
  let resultText: string | null;
  // Hoisted out of the session callback so post-stream logic can read it.
  // Set inside onStepFinish when the agent calls advanceMilestone.
  let advanceMilestoneCalled = false;
  try {
    resultText = await withLlmSession(
      db,
      "director",
      `plan: ${milestone.title.slice(0, 40)}`,
      directorModelId,
      async (session): Promise<string> => {
        if (session.effectiveContextLimit && estimatedTokens > session.effectiveContextLimit * 0.8) {
          console.warn(`[director:planner] prompt (~${estimatedTokens} tokens) approaching context limit (${session.effectiveContextLimit}) — may be truncated`);
        }
        console.log(`[director:planner] calling ${session.machine.name || session.providerModelId} ...`);
        const llmStartTime = Date.now();
        // Lease auto-renewal + expiry-driven abort: import inside the session
        // callback so we can bump expiresAt on every step AND wire an
        // onExpiry callback that aborts the stream if the LLM hangs mid-call
        // (LLM "thinking" phase that doesn't emit step boundaries — the
        // renewal can't fire because no step finishes, so the lease expires
        // correctly at the idle-timeout boundary, and we use that signal to
        // kill the stream instead of letting it run as a phantom).
        const { renewLease, setLeaseOnExpiry } = await import("../machine-manager");
        setLeaseOnExpiry(session.leaseId, () => {
          leaseExpiredAborted = true;
          console.error(`[director:planner] lease idle-timeout fired — aborting stream for "${milestone.title}"`);
          abortController.abort();
        });
        // Synthetic identifiers used for the per-step llm_requests rows so the
        // Director planner's reasoning is browsable in the existing LLM logs UI
        // alongside Foreman pipeline steps. The frontend filters by issue_id
        // prefix; "director-planner:<milestone>" is greppable and groups all
        // calls within one planning attempt.
        const plannerIssueId = `director-planner:${milestone.id}`;
        const plannerRunId = `director-planner-run:${randomUUID()}`;
        let stepIndex = 0;
        const opinionTools = makeDirectorOpinionTools(db, project, {
          model: session.llm,
          sandbox: directorSandbox,
          directiveId: directive.id,
        });
        const tools = { ...baseTools, ...opinionTools };
        const loopGuard = new ToolLoopGuard(5);
        let loopTripped = false;
        let leaseExpiredAborted = false;
        // Per-invocation per-tool quota. Defends against the failure mode
        // the loop guard misses: agent makes the same kind of call N times
        // with VARYING args (so the exact-match loop guard never trips) and
        // grinds the entire step budget. The classic example is memory-write
        // spirals: writeSemanticMemory called 15+ times in a row with
        // different filenames, each generating dozens of seconds of LLM time.
        // The agent has gone categorically degenerate even if no two calls
        // are identical, and we should kill the stream the same way.
        //
        // The cap is per category, not per individual tool, so the agent
        // can't sidestep it by alternating writeSemanticMemory <-> editMemory.
        const TOOL_CATEGORY_QUOTAS: Record<string, number> = {
          memory_write: 6,    // writeSemanticMemory + writeConvention + writeProcedure + editMemory + updateProjectBrief
        };
        const toolCategoryCounts: Record<string, number> = {};
        function categorizeToolCall(toolName: string | undefined): string | null {
          if (!toolName) return null;
          if (toolName === "writeSemanticMemory" || toolName === "writeConvention" || toolName === "writeProcedure" || toolName === "editMemory" || toolName === "updateProjectBrief" || toolName === "deleteMemory") return "memory_write";
          return null;
        }
        let quotaTripped = false;
        let quotaTrippedCategory: string | null = null;
        // Abort controller wired into streamText so that when the loop guard
        // trips we actually KILL the stream instead of letting it grind for
        // the rest of its 50-step budget. Without this the planner just logs
        // the detection and keeps going — which is what happened in the
        // earlier "readFile Big.gd repeated 5 times" incident.
        const abortController = new AbortController();

        // Wall-clock cap for the entire planner stream. Foreman/runStage has
        // a wallTimeoutMs but the planner did not, and we observed runs of
        // 19+ minutes spinning on advanceMilestone retries. Cap at 12 min;
        // this is plenty for both planning and verification mode.
        const PLANNER_WALL_TIMEOUT_MS = 12 * 60 * 1000;
        let wallTimedOut = false;
        const wallTimer = setTimeout(() => {
          wallTimedOut = true;
          const elapsed = Math.round((Date.now() - llmStartTime) / 1000);
          console.error(`[director:planner] wall-clock timeout after ${elapsed}s — aborting stream for "${milestone.title}"`);
          abortController.abort();
        }, PLANNER_WALL_TIMEOUT_MS);

        // Track advanceMilestone outcomes per stream. The agent has been
        // observed calling advanceMilestone repeatedly when it fails (each
        // call returns "verificationPassed: false" with the same blockers,
        // and the agent ignores its own tool's "do NOT call again until
        // issues are addressed" hint). And on success, it has been observed
        // continuing to investigate instead of stopping. Both are bugs.
        //
        //   - First successful call → abort the stream. The work is done.
        //   - Second failed call    → abort the stream. The agent is in
        //     denial about the blockers; the right next step is for the
        //     scheduler to surface the issues to the user, not to spin.
        let advanceMilestoneSuccess = false;
        let advanceMilestoneFailureCount = 0;
        let advanceMilestoneAborted: "success" | "repeated-failure" | null = null;
        const stream = llmStream({
          model: session.llm,
          system,
          prompt: user,
          tools,
          maxSteps: 50,
          abortSignal: abortController.signal,
          onStepFinish: (step) => {
            stepIndex++;
            // Renew the lease on every step. The Director default lease is
            // an IDLE timeout, not a wall-clock cap — as long as the agent
            // is making progress, the lease should not expire and let the
            // Foreman snipe the same machine.
            renewLease(session.leaseId);

            const toolCalls = step.toolCalls as Array<{ toolName?: string; args?: unknown }> | undefined;
            const toolResults = step.toolResults as Array<{ toolName?: string; result?: unknown }> | undefined;
            const stepText = (step as { text?: string }).text;
            const usage = (step as { usage?: { promptTokens?: number; completionTokens?: number } }).usage;
            const elapsed = Math.round((Date.now() - llmStartTime) / 1000);

            if (toolCalls?.length) {
              const toolNames = toolCalls.map(tc => tc.toolName).join(", ");
              console.log(`[director:planner] step — ${toolNames} (${elapsed}s)`);
              for (const tc of toolCalls) {
                if (tc.toolName === "advanceMilestone") {
                  advanceMilestoneCalled = true;
                }
              }
            }

            // Inspect advanceMilestone tool RESULTS (not just calls) so we
            // know whether the milestone was actually advanced. The tool
            // returns JSON: { advanced: true/false, ... }. On the first
            // success we abort — the work is done. On the second failure
            // we abort — the agent is ignoring its own blockers.
            if (toolResults?.length && advanceMilestoneAborted === null) {
              for (const tr of toolResults) {
                if (tr.toolName !== "advanceMilestone") continue;
                let parsed: { advanced?: boolean; verificationPassed?: boolean; issues?: string[]; blockers?: string[] } | null = null;
                try { parsed = JSON.parse(String(tr.result ?? "")); } catch { /* non-JSON result — ignore */ }
                if (parsed?.advanced === true) {
                  advanceMilestoneSuccess = true;
                  advanceMilestoneAborted = "success";
                  console.log(`[director:planner] advanceMilestone succeeded for "${milestone.title}" — aborting stream, work is done`);
                  abortController.abort();
                  break;
                }
                if (parsed && parsed.advanced === false) {
                  advanceMilestoneFailureCount++;
                  const detail = parsed.blockers?.join("; ") || parsed.issues?.join("; ") || "(no detail)";
                  console.warn(`[director:planner] advanceMilestone FAILED #${advanceMilestoneFailureCount} for "${milestone.title}": ${detail.slice(0, 300)}`);
                  if (advanceMilestoneFailureCount >= 2) {
                    advanceMilestoneAborted = "repeated-failure";
                    console.error(`[director:planner] advanceMilestone has failed ${advanceMilestoneFailureCount} times with the same kind of blockers — aborting stream. The agent is ignoring its own tool's guidance. Surface the blockers and let the next tick re-plan.`);
                    abortController.abort();
                    break;
                  }
                }
              }
            }

            // Persist this step into llm_requests so the Director's reasoning
            // is visible in the existing LLM logs UI. Each step records the
            // tool results that fed into it (input) and the model's response
            // (output: text + tool calls). Failures here are non-critical.
            try {
              const inputParts: string[] = [];
              for (const tr of toolResults ?? []) {
                inputParts.push(`[tool_result: ${tr.toolName ?? "unknown"}] ${String(tr.result).slice(0, 2000)}`);
              }
              const outputParts: string[] = [];
              if (stepText) outputParts.push(stepText);
              for (const tc of toolCalls ?? []) {
                outputParts.push(`[tool_call: ${tc.toolName ?? "unknown"}] ${JSON.stringify(tc.args ?? {}).slice(0, 2000)}`);
              }
              db.createLlmRequest({
                issue_id: plannerIssueId,
                run_id: plannerRunId,
                model_id: session.providerModelId,
                input_text: inputParts.join("\n") || `[director-planner step ${stepIndex} input]`,
                output_text: outputParts.join("\n") || `[director-planner step ${stepIndex} output]`,
                prompt_tokens: usage?.promptTokens ?? 0,
                completion_tokens: usage?.completionTokens ?? 0,
                duration_ms: Date.now() - llmStartTime,
              });
            } catch (logErr) {
              console.warn("[director:planner] failed to log step to llm_requests:", logErr instanceof Error ? logErr.message : logErr);
            }

            if (toolCalls?.length) {
              const summary = toolCalls.map(tc => ({
                tool: tc.toolName ?? "unknown",
                args: JSON.stringify(tc.args ?? {}),
              }));
              const obs = loopGuard.observe(summary);
              if (obs.looping && !loopTripped) {
                loopTripped = true;
                console.error(`[director:planner] tool-call loop detected: ${obs.signature?.slice(0, 200)} repeated ${obs.count} times — aborting Director planner stream`);
                abortController.abort();
              }

              // Per-category quota check. Bumps a counter for each tool call
              // and aborts the stream if any category exceeds its budget.
              // Catches the "varying-args spiral" failure mode where the agent
              // calls the same tool repeatedly with different filenames.
              if (!quotaTripped) {
                for (const tc of toolCalls) {
                  const category = categorizeToolCall(tc.toolName);
                  if (!category) continue;
                  toolCategoryCounts[category] = (toolCategoryCounts[category] ?? 0) + 1;
                  const quota = TOOL_CATEGORY_QUOTAS[category];
                  if (quota && toolCategoryCounts[category] > quota) {
                    quotaTripped = true;
                    quotaTrippedCategory = category;
                    console.error(`[director:planner] tool-category quota exceeded: ${category} called ${toolCategoryCounts[category]} times (cap ${quota}) — aborting Director planner stream. Categorically degenerate behavior — the agent is using the tool as a place to dump thinking instead of doing the actual job.`);
                    abortController.abort();
                    break;
                  }
                }
              }
            }
          },
        });
        let text = "";
        try {
          try {
            for await (const chunk of stream.textStream) {
              text += chunk;
            }
          } catch (streamErr) {
            // If we aborted ourselves due to a loop / quota / lease /
            // wall-clock / advanceMilestone trip, treat it as a planner
            // termination (return whatever partial text we got) instead
            // of re-throwing. The Director's next tick will re-evaluate.
            if (loopTripped) {
              console.warn(`[director:planner] stream aborted by loop guard after ${text.length} chars of output`);
            } else if (quotaTripped) {
              console.warn(`[director:planner] stream aborted by tool-category quota (${quotaTrippedCategory}) after ${text.length} chars of output`);
            } else if (leaseExpiredAborted) {
              console.warn(`[director:planner] stream aborted by lease idle-timeout after ${text.length} chars of output — LLM was likely hung mid-call between steps`);
            } else if (wallTimedOut) {
              console.warn(`[director:planner] stream aborted by wall-clock timeout (${PLANNER_WALL_TIMEOUT_MS / 1000}s) after ${text.length} chars of output`);
            } else if (advanceMilestoneAborted) {
              console.warn(`[director:planner] stream aborted by advanceMilestone-${advanceMilestoneAborted} after ${text.length} chars of output`);
            } else {
              throw streamErr;
            }
          }
        } finally {
          clearTimeout(wallTimer);
        }
        // If we self-aborted, do NOT await stream.steps — the AI SDK does
        // not always resolve that promise after an abortController.abort(),
        // and `.catch()` only handles rejection, not "never resolves."
        // Awaiting it here was holding the lease for the full 10-min idle
        // timeout window after the planner had already aborted.
        const selfAborted =
          loopTripped || quotaTripped || leaseExpiredAborted ||
          wallTimedOut || advanceMilestoneAborted !== null;
        const steps = selfAborted ? [] : await stream.steps.catch(() => []);
        const elapsed = Math.round((Date.now() - llmStartTime) / 1000);
        const abortReason =
          loopTripped ? " (LOOP-ABORTED)" :
          quotaTripped ? ` (QUOTA-ABORTED: ${quotaTrippedCategory})` :
          leaseExpiredAborted ? " (LEASE-EXPIRED)" :
          wallTimedOut ? " (WALL-CLOCK-TIMEOUT)" :
          advanceMilestoneAborted === "success" ? " (ADVANCED)" :
          advanceMilestoneAborted === "repeated-failure" ? " (ADVANCE-REPEATEDLY-FAILED)" :
          "";
        console.log(`[director:planner] LLM done — ${text.length} chars, ${steps.length} steps, ${elapsed}s${abortReason}`);
        return text;
      },
      {
        preferMachineId: getDirectorPreferredMachineId(db),
        // Route to the parent directive — there is no per-milestone detail
        // page in the frontend, but the directive detail page lists all
        // milestones and shows live planner activity. The lease label
        // already names the milestone so the activity panel still shows
        // which milestone is being planned.
        workRef: { kind: "directive", id: directive.id, projectId: project.id },
      },
    );
  } catch (llmErr) {
    if (llmErr instanceof NoMachineHostsModelError || llmErr instanceof ModelNotFoundError) {
      console.error(`[director:planner] ${llmErr.message}`);
      return 0;
    }
    const elapsed = Math.round((Date.now() - planStartTime) / 1000);
    console.error(`[director:planner] LLM failed after ${elapsed}s:`, llmErr instanceof Error ? llmErr.message : String(llmErr));
    throw llmErr;
  }
  if (resultText === null) {
    console.error("[director:planner] no machine available");
    return 0;
  }

  // Parse tasks
  let rawTasks = parseNextTasks(resultText);

  // Mutual exclusion: if the planner called `advanceMilestone` during this
  // run, the milestone is being marked done. It is incoherent to also queue
  // new tasks against it in the same invocation. Discard any next_tasks
  // block and let the next director tick re-evaluate against the now-
  // advanced state.
  if (advanceMilestoneCalled && rawTasks.length > 0) {
    console.warn(`[director:planner] LLM called advanceMilestone AND emitted ${rawTasks.length} next_tasks for "${milestone.title}" — these are mutually exclusive. Discarding next_tasks; advanceMilestone wins.`);
    try {
      if (directive.conversation_id) {
        db.createDirectorMessage({
          conversation_id: directive.conversation_id,
          role: "assistant",
          content: `**Director planning** [${reason}] for milestone "${milestone.title}" — Director both advanced the milestone and proposed ${rawTasks.length} new task(s). Discarded the new tasks (advanceMilestone is authoritative).`,
        });
      }
    } catch { /* non-critical */ }
    return 0;
  }

  // For top-up requests, filter out tasks that don't match the requested machine types.
  // The planner was asked to generate work for idle machines, not create more work for busy ones.
  if (idleMachineTypes?.length) {
    const allowedTypes = new Set<string>();
    for (const mt of idleMachineTypes) {
      const taskTypes = MACHINE_TYPE_TASK_TYPES[mt];
      if (taskTypes) for (const tt of taskTypes) allowedTypes.add(tt);
    }
    const before = rawTasks.length;
    rawTasks = rawTasks.filter(t => allowedTypes.has(t.type));
    if (rawTasks.length < before) {
      console.log(`[director:planner] filtered ${before - rawTasks.length} task(s) not matching idle machine types (${idleMachineTypes.join(", ")})`);
    }
  }

  const parsedTasks = await postProcessArtTasks(rawTasks, project.workdir);

  if (parsedTasks.length === 0) {
    // Check for an explicit wait decision FIRST. This is a first-class output:
    // the planner is saying "no new work right now, the right move is to let
    // in-flight tasks finish." It's NOT a parse failure, NOT "milestone may
    // be complete," and we should treat it as success and let the next tick
    // re-evaluate when something changes.
    const waitReason = parseWaitBlock(resultText);
    if (waitReason) {
      console.log(`[director:planner] explicit wait decision for "${milestone.title}" — ${waitReason}`);
      // Persist the decision into the directive's conversation so the user
      // can see why no tasks were generated this round.
      try {
        if (directive.conversation_id) {
          db.createDirectorMessage({
            conversation_id: directive.conversation_id,
            role: "assistant",
            content: `**Director planning** [${reason}] for milestone "${milestone.title}" — decided to WAIT for in-flight work.\n\nReason: ${waitReason}`,
          });
        }
      } catch { /* non-critical */ }
      return 0;
    }

    const rawCount = parseNextTasks(resultText).length;
    if (rawCount > 0) {
      // Tasks were parsed but all got filtered (e.g., top-up requested comfyui but LLM only generated code tasks)
      console.log(`[director:planner] ${rawCount} task(s) parsed but all filtered — none matched requested types`);
    } else {
      const hasTaskBlock = resultText.includes("```next_tasks");
      if (hasTaskBlock) {
        console.warn(`[director:planner] LLM produced a next_tasks block but parsing yielded 0 tasks — possible format issue. Output sample: ${resultText.slice(0, 300)}`);
      } else if (resultText.length < 50) {
        console.warn(`[director:planner] LLM returned very short response (${resultText.length} chars) — possible error`);
      } else {
        console.log(`[director:planner] no tasks generated (milestone may be complete)`);
      }
    }
    return 0;
  }

  // Duplicate handling — three distinct cases:
  //
  //   1. Duplicate of a task that is COMPLETED, AWAITING_REVIEW, or VALIDATING
  //      (i.e. the work is done or done-pending-review). DROP entirely. It is
  //      never correct to redo accepted work behind the user's back. If the
  //      user actually wants it redone, they can explicitly reject/retry it.
  //
  //   2. Duplicate of an ACKNOWLEDGED task (the Foreman has picked it up at
  //      least once — `acknowledged_at` is set). DROP entirely. The Foreman is
  //      already running it; the Director loses the right to clobber once
  //      it's in flight. This closes the planner-vs-dispatcher re-plan race.
  //
  //   3. Duplicate of a task in a redo-able state (BACKLOG, QUEUED with no
  //      acknowledgment, FAILED). Append a numbered suffix and create it as
  //      a new attempt — the user may legitimately want a retry with a fresh
  //      context.
  //
  // We scan ALL tasks for this directive (not just the current milestone),
  // because the planner was regenerating art from earlier milestones.
  const DONE_STATUSES = new Set(["completed", "awaiting_review", "validating"]);
  const allDirectiveTasks = db.getDirectiveTasks(directive.id);
  // (title key) → { status, acknowledged }
  const titleInfo = new Map<string, { status: string; acknowledged: boolean }>();
  for (const t of allDirectiveTasks) {
    titleInfo.set(t.title.toLowerCase(), {
      status: t.status,
      acknowledged: !!t.acknowledged_at,
    });
  }
  const batchTitles = new Set<string>(); // track titles within this batch too

  type DedupeDecision =
    | { action: "drop"; reason: string }
    | { action: "use"; title: string };

  function decideDedupe(title: string): DedupeDecision {
    const key = title.toLowerCase();
    const existing = titleInfo.get(key);
    const existingStatus = existing?.status;

    // Acknowledged → Foreman is already running it. Drop. (Independent of
    // status — even a failed-but-acknowledged task should not be silently
    // re-planned; the Director can still re-plan via explicit retry.)
    if (existing?.acknowledged) {
      return {
        action: "drop",
        reason: `task with title "${title}" has already been acknowledged by the Foreman (status "${existingStatus}") — refusing to clobber in-flight work`,
      };
    }

    if (existingStatus && DONE_STATUSES.has(existingStatus)) {
      return {
        action: "drop",
        reason: `task with title "${title}" already exists in status "${existingStatus}" — refusing to duplicate accepted/pending-review work`,
      };
    }

    // In a redo-able state OR new title — find a unique candidate by suffix
    let candidate = title;
    let suffix = 2;
    while (titleInfo.has(candidate.toLowerCase()) || batchTitles.has(candidate.toLowerCase())) {
      candidate = `${title} (#${suffix})`;
      suffix++;
    }
    if (candidate !== title) {
      console.log(`[director:planner] renamed "${title}" → "${candidate}" (title already exists in status "${existingStatus}" — retry allowed)`);
    }
    batchTitles.add(candidate.toLowerCase());
    return { action: "use", title: candidate };
  }

  // Two-pass creation: first create all tasks (without depends_on), then wire up dependencies.
  // This mirrors the epic story creation pattern — depends_on references task numbers (1-based)
  // in the current batch, which need to be resolved to UUIDs after creation.

  // Pass 1: Create tasks, track batch number → UUID mapping.
  // Dropped duplicates are recorded as null in batchMap so Pass 2 can resolve
  // depends_on references correctly (a surviving task that depended on a
  // dropped duplicate needs to have that reference filtered out).
  const batchMap = new Map<number, string | null>(); // task number (1-based) → UUID or null if dropped
  let created = 0;
  let droppedDuplicates = 0;
  for (let i = 0; i < parsedTasks.length; i++) {
    const parsed = parsedTasks[i];
    const decision = decideDedupe(parsed.title);

    if (decision.action === "drop") {
      console.warn(`[director:planner] dropping duplicate task — ${decision.reason}`);
      await logEpisodic(project.workdir, `Planner generated a duplicate of already-done work: ${decision.reason}`, "");
      batchMap.set(i + 1, null);
      droppedDuplicates++;
      continue;
    }

    const title = decision.title;

    // Tag description with human review flag so the Director scheduler can check it
    const description = parsed.needs_human_review
      ? parsed.description + "\n\n[needs_human_review]"
      : parsed.description;

    const task = db.createForemanTask({
      project_id: project.id,
      title,
      description,
      priority: parsed.priority,
      type: parsed.type,
      // model_id is left null — scheduler resolves it from foreman_config.foreman_code_model_id at dispatch
      target_files: parsed.target_files,
      depends_on: [],
      acceptance_criteria: parsed.acceptance_criteria,
      // Retry budget is autonomy-derived: conservative=2, standard=3, aggressive=5.
      max_retries: autonomyBudgets(directive.autonomy_level).maxTaskRetries,
      status: "queued",
      directive_id: directive.id,
      milestone_id: milestone.id,
    });

    batchMap.set(i + 1, task.id); // 1-based task number → UUID
    created++;
  }

  if (droppedDuplicates > 0) {
    console.warn(`[director:planner] dropped ${droppedDuplicates} duplicate task(s) that targeted already-accepted work`);
  }

  // Pass 2: Resolve depends_on references (task numbers → UUIDs).
  //
  // Critical correctness rule: when a planned task is dropped as a duplicate
  // of an EXISTING task (completed, in-flight, acknowledged, etc.), any
  // dependents that referenced the dropped task by number/title must be
  // REDIRECTED to the existing task, NOT silently stripped. The previous
  // behavior was to log a warning and drop the dependency entirely, which
  // produced the failure shape "task got scheduled before its dep was
  // actually done" — the dependent had no dep recorded so the dispatcher
  // happily ran it immediately.
  //
  // Build a lookup: task number → existing-task-id-it's-a-duplicate-of, so
  // we can redirect references to the right place.
  const droppedRedirects = new Map<number, string>();
  // Re-walk the batch and recompute the dedupe decision for dropped entries
  // to find which existing task they were duplicates of.
  for (let i = 0; i < parsedTasks.length; i++) {
    if (batchMap.get(i + 1) !== null) continue;
    const droppedTitle = parsedTasks[i].title.toLowerCase();
    const existing = allDirectiveTasks.find(t => t.title.toLowerCase() === droppedTitle);
    if (existing) {
      droppedRedirects.set(i + 1, existing.id);
    }
  }

  for (let i = 0; i < parsedTasks.length; i++) {
    const parsed = parsedTasks[i];
    const taskId = batchMap.get(i + 1);
    if (!taskId || parsed.depends_on.length === 0) continue;

    const resolvedDeps: string[] = [];
    for (const rawDep of parsed.depends_on) {
      // Clean up common LLM formatting: strip brackets, quotes, whitespace
      const dep = rawDep.replace(/[\[\]"']/g, "").trim();
      if (!dep) continue;
      // dep could be a number string ("1", "2") or a title
      const depNum = parseInt(dep, 10);
      const numTarget = !isNaN(depNum) ? batchMap.get(depNum) : undefined;
      if (numTarget !== undefined) {
        if (numTarget !== null) {
          resolvedDeps.push(numTarget);
        } else {
          // The referenced task was dropped as a duplicate. Redirect the
          // dependency to the existing task it was a duplicate OF, instead
          // of silently removing it. Without this, the dependent gets
          // dispatched before the existing in-flight task finishes.
          const redirect = droppedRedirects.get(depNum);
          if (redirect) {
            resolvedDeps.push(redirect);
            console.log(`[director:planner] task "${parsed.title}" depends on dropped duplicate #${depNum} — redirected to existing task ${redirect.slice(0, 8)}`);
          } else {
            console.warn(`[director:planner] task "${parsed.title}" depends on dropped duplicate #${depNum} but no existing task matches the dropped title — dependency removed`);
          }
        }
      } else {
        // Try matching by title against this batch first, then existing directive tasks
        const byTitle = [...batchMap.entries()].find(([num]) => {
          const pt = parsedTasks[num - 1];
          return pt && pt.title.toLowerCase() === dep.toLowerCase();
        });
        if (byTitle && byTitle[1] !== null) {
          resolvedDeps.push(byTitle[1]);
        } else if (byTitle && byTitle[1] === null) {
          // Same redirect logic for title-based references to dropped duplicates.
          const redirect = droppedRedirects.get(byTitle[0]);
          if (redirect) {
            resolvedDeps.push(redirect);
            console.log(`[director:planner] task "${parsed.title}" depends on dropped duplicate "${dep}" — redirected to existing task ${redirect.slice(0, 8)}`);
          } else {
            console.warn(`[director:planner] task "${parsed.title}" depends on dropped duplicate "${dep}" but no existing task matches — dependency removed`);
          }
        } else {
          const existing = allDirectiveTasks.find(t => t.title.toLowerCase() === dep.toLowerCase());
          if (existing) {
            resolvedDeps.push(existing.id);
          } else {
            console.warn(`[director:planner] unresolved dependency "${dep}" for task "${parsed.title}" — dependency will be ignored`);
          }
        }
      }
    }

    // Filter out self-dependencies
    const filteredDeps = resolvedDeps.filter(depId => depId !== taskId);
    if (filteredDeps.length !== resolvedDeps.length) {
      console.warn(`[director:planner] "${parsed.title}" had a self-dependency — removed`);
    }

    if (filteredDeps.length > 0) {
      db.updateForemanTask(taskId, { depends_on: JSON.stringify(filteredDeps) });
      console.log(`[director:planner] "${parsed.title}" depends on ${filteredDeps.length} task(s)`);
    }
  }

  // Cycle detection — surgical: only remove the specific edges that create
  // cycles, NOT all dependencies. The previous behavior wiped every
  // depends_on in the batch on any cycle, destroying valid (acyclic)
  // dependencies as collateral damage.
  //
  // Algorithm: build the directed graph, find strongly-connected components
  // via Tarjan's. Any SCC of size > 1 contains cycles; we break each one by
  // removing the edges from the LAST task into earlier tasks in the SCC.
  // (Tasks are 1-indexed by the planner; dependencies typically point
  // backwards. Removing forward-into-earlier edges preserves the planner's
  // intent for the rest.)
  const depGraph = new Map<string, string[]>();
  for (const [, id] of batchMap) {
    if (id === null) continue;
    const task = db.getForemanTask(id);
    if (task?.depends_on) {
      try { depGraph.set(id, JSON.parse(task.depends_on)); } catch { /* skip */ }
    }
  }
  const removedEdges: Array<{ from: string; to: string }> = [];
  // Iteratively find one back-edge per pass and remove it. Repeat until no
  // cycles remain. Bounded by number of edges so it always terminates.
  const MAX_ITERATIONS = 50;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let foundCycleNode: string | null = null;
    let cyclePath: string[] = [];
    const visited = new Set<string>();
    const stack: string[] = [];
    const inStack = new Set<string>();
    function dfs(nodeId: string): boolean {
      if (inStack.has(nodeId)) {
        // Found a back-edge — slice the stack from the cycle entry point
        const cycleStart = stack.indexOf(nodeId);
        cyclePath = stack.slice(cycleStart).concat(nodeId);
        foundCycleNode = nodeId;
        return true;
      }
      if (visited.has(nodeId)) return false;
      visited.add(nodeId);
      stack.push(nodeId);
      inStack.add(nodeId);
      for (const dep of depGraph.get(nodeId) ?? []) {
        if (dfs(dep)) return true;
      }
      stack.pop();
      inStack.delete(nodeId);
      return false;
    }
    for (const id of batchMap.values()) {
      if (id === null || foundCycleNode) continue;
      dfs(id);
    }
    if (!foundCycleNode) break; // no more cycles

    // cyclePath: [a, b, c, ..., a] — remove the last edge (closing the loop).
    if (cyclePath.length >= 2) {
      const from = cyclePath[cyclePath.length - 2];
      const to = cyclePath[cyclePath.length - 1];
      const fromDeps = depGraph.get(from) ?? [];
      const newDeps = fromDeps.filter(d => d !== to);
      depGraph.set(from, newDeps);
      removedEdges.push({ from, to });
      console.warn(`[director:planner] removed cyclic dependency edge ${from.slice(0, 8)} → ${to.slice(0, 8)} (cycle path: ${cyclePath.map(x => x.slice(0, 8)).join(" → ")})`);
    } else {
      break;
    }
  }
  // Persist the surgically-pruned graphs back to the DB.
  for (const edge of removedEdges) {
    const task = db.getForemanTask(edge.from);
    if (!task) continue;
    let deps: string[];
    try { deps = JSON.parse(task.depends_on ?? "[]"); } catch { continue; }
    const pruned = deps.filter(d => d !== edge.to);
    db.updateForemanTask(edge.from, { depends_on: pruned.length > 0 ? JSON.stringify(pruned) : null });
  }
  if (removedEdges.length > 0) {
    console.warn(`[director:planner] surgical cycle removal: pruned ${removedEdges.length} edge(s); preserved all other dependencies`);
  }

  const totalTime = Math.round((Date.now() - planStartTime) / 1000);
  let createdTitles: string[] = [];
  if (created > 0) {
    // Only list the tasks that were actually created (non-null batchMap entries).
    for (const [num, id] of batchMap) {
      if (id !== null) {
        const pt = parsedTasks[num - 1];
        if (pt) createdTitles.push(`"${pt.title}" (${pt.type})`);
      }
    }
    console.log(`[director:planner] created ${created} task(s) in ${totalTime}s — ${createdTitles.join(", ")}`);
    const taskTypes = parsedTasks.map(t => t.type).join(", ");
    await logEpisodic(project.workdir, `Planned ${created} task(s) for "${milestone.title}"`, `Types: ${taskTypes}${idleMachineTypes?.length ? ` (top-up for idle: ${idleMachineTypes.join(", ")})` : ""}`);
    nudgeForeman(db);
  } else {
    const skipped = rawTasks.length;
    console.log(`[director:planner] 0 new tasks in ${totalTime}s${skipped > 0 ? ` (${skipped} duplicate${skipped > 1 ? "s" : ""} skipped)` : ""}`);
  }

  // Persist a one-line summary of this planner run into the directive's
  // conversation as a system message. The user can see in the conversation UI
  // that a planning attempt happened and what came out of it, without digging
  // through llm_requests for the per-step trace. This is the cheap surface;
  // the rich per-step trace is in llm_requests under issue_id =
  // "director-planner:<milestone.id>".
  try {
    if (directive.conversation_id) {
      const summaryParts: string[] = [];
      summaryParts.push(`**Director planning** [${reason}] for milestone "${milestone.title}" — ${totalTime}s`);
      if (created > 0) {
        summaryParts.push(`Created ${created} task(s):`);
        for (const t of createdTitles) summaryParts.push(`- ${t}`);
      } else {
        summaryParts.push(`No new tasks generated.`);
      }
      if (removedEdges.length > 0) {
        summaryParts.push(`⚠ Removed ${removedEdges.length} cyclic dependency edge(s) — your dependency graph contained cycles. The remaining acyclic dependencies were preserved.`);
      }
      if (droppedDuplicates > 0) {
        summaryParts.push(`⚠ Dropped ${droppedDuplicates} duplicate task(s) that were already in flight or already completed.`);
      }
      if (verificationIssues?.length) {
        summaryParts.push("Triggered by verification failures:");
        for (const issue of verificationIssues.slice(0, 5)) summaryParts.push(`- ${issue}`);
      }
      db.createDirectorMessage({
        conversation_id: directive.conversation_id,
        role: "assistant",
        content: summaryParts.join("\n"),
      });
    }
  } catch (logErr) {
    console.warn("[director:planner] failed to write planning summary to conversation:", logErr instanceof Error ? logErr.message : logErr);
  }

  return created;
}
