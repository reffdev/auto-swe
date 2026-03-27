# How It Works

You describe what you want. AI agents build it, test it, review it, and open a PR.

## The Big Picture

```mermaid
graph LR
    You["🧑 You"]
    Plan["💬 Describe\nwhat you want"]
    Stories["📋 Stories\nwith requirements"]
    Agents["🤖 Agents\nresearch, code,\ntest, review"]
    PR["🔀 Pull Request\nready to merge"]

    You --> Plan --> Stories --> Agents --> PR --> You

    style You fill:#2d4a22
    style Plan fill:#1e3a5f
    style Stories fill:#1e3a5f
    style Agents fill:#1e3a5f
    style PR fill:#2d4a22
```

## From Idea to Code

```mermaid
graph TD
    subgraph Phase1["1. Planning"]
        Idea["You have an idea"]
        Chat["Chat with AI planner\nto refine requirements"]
        Issue["Structured issue created\n(or epic with stories)"]
        Idea --> Chat --> Issue
    end

    subgraph Phase2["2. Execution"]
        Research["Agent researches\nthe codebase"]
        Build["Agent implements\nthe changes"]
        Test["Agent writes\nand runs tests"]
        Research --> Build --> Test
    end

    subgraph Phase3["3. Quality"]
        Review["Automated reviews\nthrough multiple lenses"]
        Fix["Agent fixes\nany issues found"]
        Review -->|"problems found"| Fix --> Review
        Review -->|"all clear"| Ship
        Ship["Commit, push,\nopen PR"]
    end

    Issue --> Research
    Test --> Review

    style Phase1 fill:none,stroke:#4a6
    style Phase2 fill:none,stroke:#46a
    style Phase3 fill:none,stroke:#a64
```

## What Makes This Different

```mermaid
graph LR
    subgraph Traditional["Traditional AI Coding"]
        T1["One prompt"] --> T2["One response"] --> T3["Hope it works"]
    end

    subgraph ThisSystem["This System"]
        S1["Research phase\nfinds relevant code"] --> S2["Implementation\nwith full context"]
        S2 --> S3["Tests written\nautomatically"]
        S3 --> S4["Multiple review passes\n(security, UI, perf...)"]
        S4 -->|"issues found"| S2
        S4 -->|"all pass"| S5["PR created"]
    end
```

## The Agent Harness

Agents don't run free — a harness controls what they can see and do at each step.

```mermaid
graph LR
    subgraph Research["🔍 Research"]
        R["Read-only access\nExplore & find files"]
    end

    subgraph Code["⚙️ Code"]
        C["Read + write access\nMake changes & verify"]
    end

    subgraph Test["🧪 Test"]
        T["Write tests only\nNo touching implementation"]
    end

    subgraph Review["📋 Review"]
        V["Read + run access\nCheck code & run tests\nCan't change anything"]
    end

    Research -->|"file list"| Code -->|"changes"| Test -->|"results"| Review
```

Each stage gets **different tools**. The research agent can't write files. The test agent can't modify implementation code. The reviewer can't change anything — only read and run tests. This prevents agents from going off-script.

## Review Lenses

Every change gets reviewed through focused lenses. Think of it like having multiple specialists look at the same PR:

```mermaid
graph LR
    Code["Code\nChanges"] --> G["⬜ General\nDoes it work?\nIs the scope right?"]
    G --> S["🟠 Security\nInput validation?\nSecrets exposed?"]
    S --> U["🟣 UI\nAccessible?\nResponsive?"]
    U --> P["🔵 Performance\nN+1 queries?\nBundle size?"]
    P --> T["🟢 Testing\nMeaningful tests?\nEdge cases?"]
    T --> E["🔴 Errors\nWhat if it fails?\nSilent failures?"]
    E --> Done["✅ All Clear\n→ PR Created"]

    G -.->|"reject"| Fix["🔧 Fix & retry"]
    S -.->|"reject"| Fix
    U -.->|"reject"| Fix
    P -.->|"reject"| Fix
    T -.->|"reject"| Fix
    E -.->|"reject"| Fix
    Fix -.-> Code
```

You choose which lenses apply per issue. A backend API change might only need General + Security + Testing. A frontend feature might need General + UI + Performance.

## Epics & Stories

Large features get broken into independent stories that can run in parallel:

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
