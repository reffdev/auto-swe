# Agent Harness

The harness is the infrastructure that runs LLM agents — managing their tools, context, prompts, and lifecycle. The agents themselves are stateless LLM calls; the harness provides everything around them.

## What the Harness Does

```mermaid
graph LR
    subgraph Harness["Harness (your code)"]
        direction TB
        Prompt["📝 Build Prompt"]
        Tools["🔧 Provide Tools"]
        State["💾 Manage State"]
    end

    subgraph Loop["Agent Loop (AI SDK)"]
        direction TB
        Call["LLM Call"]
        Exec["Execute Tool"]
        Log["Log Step"]
        Call -->|tool call| Exec -->|result| Call
        Call -->|step done| Log
    end

    subgraph Guards["Guards"]
        direction TB
        Timeout["⏱ Timeouts"]
        Cancel["🛑 Cancel"]
    end

    Prompt --> Loop
    Tools --> Loop
    Loop --> State
    Guards -.->|abort| Loop
```

The harness wraps each pipeline stage. It builds the prompt, hands the LLM a set of tools, runs the agent loop, logs each step, and enforces timeouts. The LLM itself is stateless — it just receives a prompt and responds with text or tool calls.

## Agent vs Harness Responsibilities

| Concern | Agent (LLM) | Harness (Code) |
|---------|-------------|----------------|
| **What to do** | Decides based on prompt + tools | Provides the issue description and file list |
| **How to do it** | Generates tool calls and code | Executes tool calls, returns results |
| **What tools exist** | Sees tool names + descriptions | Creates tool functions, controls which are available per stage |
| **File access** | Calls readFile/writeFile | Reads from worktree, enforces path boundaries |
| **Context window** | Manages within its limit | Controls prompt size, provides pre-loaded project files |
| **When to stop** | Produces result block | Enforces step limits, timeouts, abort signals |
| **Quality** | Follows coding standards in prompt | Review lenses catch violations |
| **State between stages** | None — each stage is a fresh context | LangGraph persists state, passes outputs between nodes |

## The Agent Loop

Each stage runs one agent loop via `streamText`:

```mermaid
sequenceDiagram
    participant Harness
    participant LLM as LLM (Agent)
    participant Tools as Tool Functions

    Harness->>LLM: System prompt + User prompt + Tool definitions

    loop Until maxSteps or text output
        LLM-->>Harness: Tool call(s)
        Harness->>Tools: Execute tool functions
        Tools-->>Harness: Tool results
        Harness->>LLM: Tool results appended to conversation
    end

    LLM-->>Harness: Final text output
    Harness->>Harness: Save output to pipeline state
```

Key points:
- The LLM has **no memory between stages** — each stage starts with a fresh system prompt and user message
- Tool calls and results accumulate **within** a stage (the AI SDK manages the conversation)
- The harness controls **which tools** each stage can access — scout gets read-only, implement gets read+write, review gets read+run
- **`onStepFinish`** fires after each tool call round-trip, allowing the harness to log progress

## Tool Provisioning Per Stage

The harness creates different tool sets per stage to enforce boundaries:

```mermaid
graph LR
    subgraph Scout["Scout Tools"]
        SR[readFile]
        SS[searchFiles]
        SL[listDirectory]
        SI[getFileInfo]
        SC[saveCheckpoint]
    end

    subgraph Implement["Implement Tools"]
        IR[readFile]
        IW[writeFile]
        IS[searchFiles]
        IL[listDirectory]
        IC[runCommand]
        IG[gitStatus / gitDiff]
        IE[replaceInFile]
        IA[appendToFile]
        ID[deleteFile]
        IM[moveFile]
        IF[getFileInfo]
        IRR[readRelevantFiles]
    end

    subgraph TestWrite["Test-Write Tools"]
        TR[readFile]
        TW[writeFile]
        TS[searchFiles]
        TL[listDirectory]
        TC[runCommand]
        TA[appendToFile]
        TI[getFileInfo]
    end

    subgraph Review["Review Tools"]
        RR[readFile]
        RS[searchFiles]
        RL[listDirectory]
        RC[runCommand]
        RG[gitStatus / gitDiff]
        RI[getFileInfo]
    end
```

## Prompt Strategy

Each stage gets a focused prompt. The harness doesn't use a shared "mega-prompt" — each stage sees only what's relevant:

```mermaid
graph TD
    subgraph ScoutPrompt["Scout Prompt"]
        SP1["Role: Codebase researcher"]
        SP2["Task: Find relevant files"]
        SP3["Output: File manifest via saveCheckpoint"]
        SP4["Constraint: Read-only, no code writing"]
    end

    subgraph ImplPrompt["Implement Prompt"]
        IP1["Role: Implementer"]
        IP2["Input: File list + issue description"]
        IP3["Task: Read files, make changes"]
        IP4["Standards: Additive only, no rewrites"]
    end

    subgraph ReviewPrompt["Review Prompt"]
        RP1["Role: Reviewer with specific lens"]
        RP2["Input: Git diff + issue + prior outputs"]
        RP3["Task: Read files, run tests, verdict"]
        RP4["Output: accept or reject with feedback"]
    end
```

## Data Flow Between Stages

Stages don't share context directly — the harness passes data through pipeline state:

```mermaid
graph LR
    Scout -->|"scoutBrief\n(JSON manifest)"| Resolve["Server resolves\nto file list"]
    Resolve -->|"file list in\nuser prompt"| Implement
    Implement -->|"implementOutput\n(text summary)"| TestWrite
    TestWrite -->|"testWriteOutput\n(text summary)"| Review

    GitContext["captureGitContext()\ngit status + diff"] -->|injected| TestWrite
    GitContext -->|injected| Review
    ProjectContext["gatherProjectContext()\nauto-read key files"] -->|injected| Scout
    ProjectContext -->|injected| TestWrite
    ProjectContext -->|injected| Review
```

Note: `implementOutput` and `testWriteOutput` are only the LLM's **text** responses — not the full tool call history. The actual code changes live in the worktree (visible via `gitDiff`).

## Isolation Model

```mermaid
graph TD
    subgraph Project["Project Workdir\n(shared, reset to origin)"]
        Main[main branch]
    end

    subgraph WT1["Worktree: Issue A"]
        Branch1[issue/abc-feature]
        Files1[Isolated file changes]
    end

    subgraph WT2["Worktree: Issue B"]
        Branch2[issue/def-bugfix]
        Files2[Isolated file changes]
    end

    Main -->|"git worktree add"| WT1
    Main -->|"git worktree add"| WT2

    WT1 -->|"commit + push"| PR1[PR #1]
    WT2 -->|"commit + push"| PR2[PR #2]
```

Each issue gets its own git worktree — a lightweight checkout of the repo on a separate branch. This means:
- Multiple issues can run concurrently without conflicts
- Each agent sees a clean copy of the codebase
- Changes are isolated until the PR is merged
- Worktrees are cleaned up after the pipeline finishes (success or failure)

## Error Handling

```mermaid
graph TD
    StageRun[Stage Running]

    StageRun -->|"Stream timeout\n(5 min no data)"| StreamError[Stream Error]
    StageRun -->|"Hard timeout\n(15 min total)"| TimeoutError[Timeout Error]
    StageRun -->|"Cancel button"| CancelError[Cancel Error]
    StageRun -->|"LLM error"| LLMError[LLM Error]
    StageRun -->|"Success"| StagePass[Stage Pass]

    StreamError --> StageFail[Stage Fail]
    TimeoutError --> StageFail
    CancelError --> StageFail
    LLMError --> StageFail

    StageFail -->|"Scout empty"| PipelineFail[Pipeline Fail]
    StageFail -->|"Review reject\n+ retries left"| RetryImpl[Retry Implement]
    StageFail -->|"Review reject\n+ retries exhausted"| NextLens[Next Lens]
    StageFail -->|"Other stage"| PipelineFail

    StagePass -->|"More lenses"| NextReview[Next Review Lens]
    StagePass -->|"All lenses pass"| GitOps[GitOps]
```
