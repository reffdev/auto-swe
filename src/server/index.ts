import { createDeepAgent, FilesystemBackend, type SubAgent } from "deepagents";
import { HumanMessage } from "@langchain/core/messages";
import { constructSystemPrompt } from "./prompts";
import {
  ContextBudget,
  makeFilesystemTools,
  makeReadOnlyTools,
  makeVerifyTools,
  fetchUrlTool,
} from "./tools";

// Create tool sets for each sub-agent role, bound to the working directory.
// These are AI SDK tools — the full set from the mastra-react pipeline.
function createAgentTools(workDir: string) {
  const budget = new ContextBudget();

  // Full read/write/run tools for the coder
  const coderTools = makeFilesystemTools(workDir, budget);
  // Read-only + verify tools for the reviewer
  const reviewerTools = makeVerifyTools(workDir, budget);
  // Read-only tools for scouting/analysis
  const scoutTools = makeReadOnlyTools(workDir, budget);

  return { coderTools, reviewerTools, scoutTools, budget };
}

const coderSubAgent: SubAgent = {
  name: "coder",
  description: "Writes and edits code to complete tasks",
  systemPrompt:
    "You are a software engineer. Write clean, correct code to complete the assigned task.",
  tools: [],
};

const reviewerSubAgent: SubAgent = {
  name: "reviewer",
  description: "Reviews code changes for correctness and quality",
  systemPrompt:
    "You are a code reviewer. Analyze changes for bugs, style issues, and correctness.",
  tools: [],
};

export interface CreateSweAgentOptions {
  model?: string;
  workDir?: string;
  linearProjectId?: string;
  linearIssueNumber?: string;
  agentsMd?: string;
}

export function createSweAgent(options?: CreateSweAgentOptions): ReturnType<typeof createDeepAgent> {
  const model = options?.model ?? "claude-sonnet-4-20250514";
  const workDir = options?.workDir ?? "/workspace";

  const systemPrompt = constructSystemPrompt({
    workingDir: workDir,
    linearProjectId: options?.linearProjectId,
    linearIssueNumber: options?.linearIssueNumber,
    agentsMd: options?.agentsMd,
  });

  // Create filesystem tools bound to the working directory
  const { coderTools, reviewerTools, scoutTools, budget } = createAgentTools(workDir);

  return createDeepAgent({
    model,
    systemPrompt,
    tools: [], // AI SDK tools are available via sub-agents; deepagents tools can be added here
    subagents: [coderSubAgent, reviewerSubAgent],
    backend: new FilesystemBackend({ rootDir: workDir, virtualMode: true }),
    // The AI SDK tools are exported for direct use via the tools module:
    // coderTools, reviewerTools, scoutTools, fetchUrlTool
  });
}

/** Re-export tools for direct consumption by API routes or other consumers */
export {
  ContextBudget,
  makeFilesystemTools,
  makeReadOnlyTools,
  makeTestWriteTools,
  makeVerifyTools,
  fetchUrlTool,
} from "./tools";

// Dev entry point
async function main() {
  console.log("open-swe server starting on http://localhost:3000");

  const agent = createSweAgent();

  const result = await agent.invoke({
    messages: [new HumanMessage("Hello, what can you do?")],
  });

  console.log(result.messages[result.messages.length - 1].content);
}

main().catch(console.error);
