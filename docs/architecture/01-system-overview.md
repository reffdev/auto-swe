# System Overview

## Architecture Layers

```mermaid
graph TD
    subgraph Clients["Clients"]
        Browser["🌐 Browser\n(React Dashboard)"]
        ESP32["📟 ESP32\n(Voice Device)"]
        Curl["🔧 External\n(curl / monitoring)"]
    end

    subgraph Server["Express Server :3001"]
        direction LR
        API["REST API\n/api/*"]
        DirAPI["Director API\n/api/director/*"]
        ForeAPI["Foreman API\n/api/foreman/*"]
        PlannerAPI["Planner API\n/api/planner/*"]
        VoiceAPI["Voice API\n/api/voice"]
        StatsAPI["Stats API\n/api/stats"]
        WSTerminal["WebSocket\n/ws/terminal"]
        SSE["SSE\n/api/console"]
    end

    subgraph Orch["Orchestrator"]
        direction TB
        MachMgr["Machine Manager\n(lease-based access)"]
        DirSched["Director Scheduler\n(directive orchestration)"]
        ForeSched["Foreman Scheduler\n(task dispatch)"]
        AnalSched["Analysis Scheduler\n(static analysis)"]
        StatsColl["Stats Collector\n(token speed)"]
    end

    subgraph Director["Director"]
        Conversation["Conversation\n(LLM chat + research)"]
        Decomposer["Decomposer\n(design doc + milestones)"]
        Planner["Planner\n(task generation)"]
        Verifier["Verifier\n(task/milestone review)"]
        Memory["Memory System\n(.swe/ + memsearch)"]
        ReviewGates["Review Gates\n(human-in-the-loop)"]
        StyleMgr["Style Manager\n(exploration + lock)"]
        KnowledgeExt["Knowledge Extractor\n(post-task learning)"]
    end

    subgraph Foreman["Foreman"]
        Executor["Executor\n(LLM agent in worktree)"]
        ComfyExec["ComfyUI Executor\n(art/music/sfx)"]
        Validator["Validator\n(acceptance criteria)"]
        ArtFeedback["Art Feedback\n(LLM-revised prompts)"]
        CircBreaker["Circuit Breaker\n(per-machine fault tolerance)"]
        Routing["Routing\n(task type → machine type)"]
    end

    subgraph Pipeline["Pipeline (single-issue)"]
        PipeEngine["Pipeline Engine\n(LangGraph)"]
        PipePlanner["Planner LLM\n(conversation)"]
    end

    subgraph Voice["Voice Pipeline"]
        VoicePipe["STT → LLM → TTS\n(pluggable adapters)"]
    end

    subgraph Infra["Infrastructure"]
        DB[("SQLite (WAL)\n20+ tables\nDrizzle ORM")]
        Git["Git\nWorktrees,\nBranches, PRs"]
    end

    subgraph Machines["Machines"]
        M1["Inference\n(Ollama / OpenRouter /\nllama.cpp)"]
        M2["ComfyUI\n(ROCm / CUDA)"]
    end

    subgraph Audio["Audio Services (CPU)"]
        Whisper["Whisper\nSTT"]
        Piper["Piper\nTTS"]
    end

    subgraph Remote["Remote"]
        GH["GitHub / Gitea"]
    end

    Browser --> Server
    ESP32 --> VoiceAPI
    Curl --> StatsAPI

    API --> Orch
    DirAPI --> Director
    ForeAPI --> Foreman
    PlannerAPI --> Pipeline

    Orch --> Director
    Orch --> Foreman
    Orch --> Pipeline

    Director --> Foreman
    Foreman --> Machines
    Pipeline --> Machines

    Director --> DB
    Foreman --> DB
    Pipeline --> DB
    Foreman --> Git
    Pipeline --> Git
    Git --> GH

    VoiceAPI --> Voice
    Voice --> Whisper
    Voice --> Piper
    Voice --> M1
```

## Component Summary

| Component | Role |
|-----------|------|
| **Express Server** | HTTP/WS entry point — REST API, SSE log streaming, PTY WebSocket terminal |
| **Orchestrator** | Manages startup/shutdown of all background services in correct order |
| **Machine Manager** | Lease-based access control with priority queuing, auto-expiry (5min director, 30min foreman) |
| **Director** | High-level autonomy — conversations, decomposition, planning, verification, memory, review gates |
| **Foreman** | Task-level execution — dispatch, routing, execution in worktrees/ComfyUI, validation, circuit breakers |
| **Pipeline** | Original single-issue flow — scout → implement → build → test → review → PR (LangGraph) |
| **Voice** | Speech-to-speech — pluggable STT/LLM/TTS adapters |
| **Analysis** | Scheduled static analysis with per-lens frequency tracking |

## Request Flow

```mermaid
graph LR
    subgraph User Actions
        A1["Create Directive"] --> Director
        A2["Plan Issue"] --> Planner["Planner"]
        A3["Approve & Run"] --> Pipeline
        A4["Voice command"] --> Voice
        A5["View status"] --> Poll
        A6["Review gate"] --> ReviewGate["Review Gate"]
    end

    subgraph Outcomes
        Director --> Tasks["Foreman Tasks"]
        Tasks --> Execution["Code + Art + Music"]
        Planner --> Issue["Issue Created"]
        Pipeline --> PR1["PR on GitHub"]
        Voice --> Audio["Audio Response"]
        Poll --> UI["Dashboard Update"]
        ReviewGate --> Resume["Resume / Retry"]
    end
```

## Key Files

| File | Purpose |
|------|---------|
| `orchestrator.ts` | Single entry point — startup/shutdown of all services |
| `machine-manager.ts` | Lease-based machine access with priority queue |
| `llm.ts` | Unified LLM client with resilient fetch, retry, stream monitoring |
| `api.ts` | Express routes (~40+ endpoints) |
| `schema.ts` | Drizzle ORM schema (20+ tables) |
| `db.ts` | Database abstraction + migrations |
| `git.ts` | Async worktree management, commit, PR operations |
| `git-helpers.ts` | Synchronous git queries (getHeadCommit, isDirty, getDiff) |
| `stats.ts` | Token speed tracking and performance metrics |
| `analysis.ts` | Multi-stage automated codebase analysis |
| `terminal.ts` | PTY WebSocket for Claude CLI |
| `console-log.ts` | Console log aggregation for SSE streaming |
