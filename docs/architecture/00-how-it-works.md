# How It Works

You describe what you want. The Director breaks it down, the Foreman dispatches work to AI agents, reviews happen automatically, and PRs get opened — all with human oversight at configurable gates.

## The Big Picture

```mermaid
graph LR
    You["🧑 You"]
    Directive["💬 Directive\n(describe what you want)"]
    Milestones["📋 Milestones\nwith tasks"]
    Agents["🤖 Agents\ncode, art,\nmusic, review"]
    Result["🔀 Pull Requests\n+ Assets"]

    You --> Directive --> Milestones --> Agents --> Result --> You

    style You fill:#2d4a22
    style Directive fill:#1e3a5f
    style Milestones fill:#1e3a5f
    style Agents fill:#1e3a5f
    style Result fill:#2d4a22
```

## Two-Level Orchestration

The system has two orchestration levels, managed by a central Orchestrator:

```mermaid
graph TD
    subgraph Orchestrator["Orchestrator (startup + dispatch ordering)"]
        direction TB

        subgraph Director["Director (high-level autonomy)"]
            D1["Conversation with user"]
            D2["Decompose into milestones"]
            D3["Plan tasks per milestone"]
            D4["Verify completed work"]
            D1 --> D2 --> D3 --> D4
            D4 -->|next milestone| D3
        end

        subgraph Foreman["Foreman (task execution)"]
            F1["Pick task from queue"]
            F2["Route to machine by type"]
            F3["Execute in isolation"]
            F4["Validate results"]
            F1 --> F2 --> F3 --> F4
        end

        Director -->|"generates tasks"| Foreman
    end

    subgraph Machines["Machine Pool"]
        M1["Inference\n(code, review, content, claude)"]
        M2["ComfyUI\n(art, music, sfx, style_exploration)"]
    end

    Foreman --> M1
    Foreman --> M2

    style Director fill:none,stroke:#4a6
    style Foreman fill:none,stroke:#46a
```

**Director** handles the strategic layer: talking to the user, decomposing directives into milestones, generating task batches, verifying results, and managing memory.

**Foreman** handles the tactical layer: dispatching tasks to machines, executing code in git worktrees, running ComfyUI workflows for art/music, and validating outputs.

The **Orchestrator** ensures correct startup order (Director gets first tick, Foreman waits) and prevents the Foreman from dispatching to machines the Director has reserved.

## Director Flow

```mermaid
graph TD
    subgraph Phase1["1. Conversation"]
        Idea["User creates directive"]
        Chat["Director chats with user\nresearches codebase, refines plan"]
        Approve["User approves plan"]
        Idea --> Chat --> Approve
    end

    subgraph Phase2["2. Decomposition"]
        Design["Generate design document"]
        Miles["Extract milestones\nwith verification criteria"]
        Design --> Miles
    end

    subgraph Phase3["3. Execution Loop"]
        Plan["Plan 1-5 tasks\nfor current milestone"]
        Dispatch["Foreman dispatches\nto machines"]
        Execute["Agents execute\n(code in worktrees,\nart via ComfyUI)"]
        Verify["Director verifies\ncompleted tasks"]
        Plan --> Dispatch --> Execute --> Verify
        Verify -->|"tasks remaining"| Dispatch
        Verify -->|"milestone done"| NextMile["Next milestone"]
        NextMile --> Plan
    end

    subgraph Phase4["4. Human Oversight"]
        Gate["Review Gate"]
        Human["Human decision"]
        Gate --> Human
        Human -->|"approve"| Resume["Resume"]
        Human -->|"reject/feedback"| Retry["Retry with feedback"]
    end

    Approve --> Design
    Miles --> Plan
    Verify -.->|"gate triggered"| Gate
    Resume -.-> Verify
    Retry -.-> Execute

    style Phase1 fill:none,stroke:#4a6
    style Phase2 fill:none,stroke:#46a
    style Phase3 fill:none,stroke:#a64
    style Phase4 fill:none,stroke:#aa4
```

## Task Types and Routing

Tasks route to different machine types based on their type:

```mermaid
graph LR
    subgraph InferenceTasks["Inference Machine Tasks"]
        Code["code — implement features"]
        Review["review — code review"]
        Content["content — docs, text"]
        Claude["claude — general AI tasks"]
    end

    subgraph ComfyUITasks["ComfyUI Machine Tasks"]
        Art["art — sprites, backgrounds"]
        Music["music — background tracks"]
        SFX["sfx — sound effects"]
        Style["style_exploration — style discovery"]
    end

    InferenceTasks --> Inference["🖥️ Inference Machine\n(Ollama / OpenRouter)"]
    ComfyUITasks --> ComfyUI["🎨 ComfyUI Machine\n(ROCm / CUDA)"]
```

## Review Gates (Human-in-the-Loop)

The Director creates review gates at key decision points. Gate behavior depends on the directive's autonomy level:

| Gate Type | Conservative | Standard | Aggressive |
|-----------|:----------:|:-------:|:---------:|
| Task verification | Pause | Pause | Pause |
| Design choice | Pause | Skip | Skip |
| Milestone completion | Pause | Pause | Skip |
| Failure escalation | Pause | Pause | Pause |
| Style selection | Pause | Pause | Pause |

Art-related review gates don't block code task planning — only the art pipeline pauses.

## Art Style System

For directives that include art assets, the Director manages style consistency:

```mermaid
graph LR
    Explore["Style Exploration\n(6 varied prompts via LLM)"] --> Review["Human Review\n(select favorite)"]
    Review -->|"select"| Lock["Style Lock\n(checkpoint + preset +\nprompt prefix + reference image)"]
    Review -->|"reject all"| Explore
    Review -->|"enhance"| Enhance["Flux Enhance\n(img2img refinement\n6 denoise levels)"]
    Lock --> Tasks["All future art tasks\nuse locked style"]
```

Style exploration generates prompts with 4–6 specific colors each, varied rendering techniques, and no UI elements. When continuous exploration is enabled, new prompts are auto-queued after each batch.

## The Pipeline (Single-Issue Execution)

For standalone issues (not part of a directive), the original pipeline still operates:

```mermaid
graph LR
    Scout["🔍 Scout\n(read-only)"]
    Implement["⚙️ Implement\n(read + write)"]
    BuildGate{"🔨 Build\nGate"}
    TestWrite["🧪 Test-Write\n(write tests only)"]
    TestGate{"✅ Test\nGate"}
    Review["📋 Review\n(11 lenses)"]
    GitOps["🚀 GitOps\n(commit + push + PR)"]

    Scout -->|file manifest| Implement
    Implement --> BuildGate
    BuildGate -->|pass| TestWrite
    BuildGate -->|"fail (up to 3x)"| Implement
    TestWrite --> TestGate
    TestGate -->|pass| Review
    TestGate -->|"fail (up to 3x)"| Implement
    Review -->|accept| GitOps
    Review -->|reject| Implement
```

See [Pipeline Stages](02-pipeline-stages.md) for details.

## Review Lenses

Every code change gets reviewed through focused lenses — like having multiple specialists look at the same PR:

```mermaid
graph LR
    subgraph Core["Core Lenses"]
        G["⬜ General"]
        S["🟠 Security"]
        U["🟣 UI"]
        P["🔵 Performance"]
        T["🟢 Testing"]
        E["🔴 Error Handling"]
    end

    subgraph Stack["Stack-Specific Lenses"]
        R["⚛️ React"]
        TS["📘 TypeScript"]
        N["🟩 Node"]
        EX["📡 Express"]
        SQ["🗄️ SQLite"]
    end

    Code["Code Changes"] --> Core --> Stack --> Done["✅ All Clear"]
```

Reviews use a cache-friendly three-part prompt structure (system + shared context + lens-specific instructions) for ~77% token savings across lenses. See [Review Lenses](03-review-lenses.md) for all 11 lenses.

## Memory System

The Director maintains persistent knowledge across tasks:

```mermaid
graph TD
    subgraph SweDir[".swe/ Directory"]
        Conv["conventions/\nProject rules\n(highest priority)"]
        Proc["conventions/procedural/\nHow-to workflows"]
        Sem["memory/semantic/\nStable knowledge"]
        Epi["memory/episodic/\nDaily activity logs"]
        ArtDir["art/\nStyle lock + references"]
    end

    subgraph Operations
        Search["memsearch CLI\nSemantic search"]
        Extract["Task Knowledge Extractor\nPost-completion learning"]
        Prune["Episodic Pruner\n30-day auto-prune"]
    end

    Extract -->|writes| Sem
    Prune -->|cleans| Epi
    Search -->|queries| Sem
    Search -->|queries| Epi
```

- **Conventions** and **procedural** docs are always injected into Director context
- **Semantic** and **episodic** memories are searched via memsearch (not dumped)
- **Task Knowledge Extractor** analyzes completed tasks (git diff + agent output) for reusable patterns: conventions, API patterns, gotchas, architecture decisions
- **Episodic logs** auto-prune at 30 days (patterns extracted first via LLM)
- **Unattributed commit tracking** detects manual/external commits not linked to foreman tasks

## Epics & Stories (Pipeline System)

Large features can be broken into independent stories that run in parallel:

```mermaid
graph TD
    Epic["📦 Epic: Add Auth System"]

    S1["Story 1\nUser model + schema"]
    S2["Story 2\nLogin endpoint"]
    S3["Story 3\nRegistration UI"]
    S4["Story 4\nSession management"]

    Epic --> S1
    Epic --> S2
    Epic --> S3
    Epic --> S4

    S1 -->|"must finish first"| S2
    S1 -->|"must finish first"| S3
    S2 -->|"both needed"| S4
    S3 -->|"both needed"| S4

    style S1 fill:#1e3a5f
    style S2 fill:#1e3a5f
    style S3 fill:#1e3a5f
    style S4 fill:#1e3a5f
```

Stories declare dependencies (`depends_on`). Stories 2 and 3 can run in parallel since they only depend on Story 1. Story 4 waits for both.

## Example: End-to-End Directive

Here's what happens when you create a directive to "add a health check endpoint":

```mermaid
sequenceDiagram
    actor You
    participant Dir as 🎯 Director
    participant FM as ⚙️ Foreman
    participant Agent as 🤖 Agent
    participant Machine as 🖥️ Machine

    Note over You,Dir: 1. Conversation
    You->>Dir: Create directive: "Add health check endpoint"
    Dir->>You: What should it return? DB connectivity?
    You->>Dir: JSON with status, uptime, db_ok
    Dir->>You: Here's my plan...
    You->>Dir: Approve

    Note over Dir: 2. Decomposition
    Dir->>Dir: Generate design doc
    Dir->>Dir: Create milestone: "Health endpoint"
    Dir->>Dir: Verification: GET /api/health returns 200

    Note over Dir,FM: 3. Task Planning
    Dir->>FM: Task: "Implement GET /api/health"
    Note right of Dir: type: code, priority: 1
    Dir->>FM: Task: "Write health endpoint tests"
    Note right of Dir: type: code, priority: 2, depends_on: task 1

    Note over FM,Machine: 4. Execution
    FM->>FM: Acquire lease on Machine
    FM->>Agent: Execute task 1 in git worktree
    Agent->>Agent: Read api.ts, db.ts
    Agent->>Agent: Add endpoint, verify build
    Agent-->>FM: Task complete (branch: foreman/health-endpoint)

    FM->>Agent: Execute task 2 (depends_on satisfied)
    Agent->>Agent: Write tests, run them
    Agent-->>FM: Task complete

    Note over Dir: 5. Verification
    Dir->>Dir: Review completed tasks
    Dir->>Dir: Extract task knowledge → .swe/semantic/
    Dir->>Dir: Check milestone criteria
    Dir->>Dir: Milestone verified ✓

    Note over Dir: 6. GitOps
    Dir->>Dir: Merge branches, create PR
    Dir->>You: PR ready for review
```
