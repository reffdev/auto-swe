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
        BuildCheck["Build gate\n(automated)"]
        Test["Agent writes\nand runs tests"]
        TestCheck["Test gate\n(automated)"]
        Research --> Build --> BuildCheck --> Test --> TestCheck
        BuildCheck -.->|"fail"| Build
        TestCheck -.->|"fail"| Build
    end

    subgraph Phase3["3. Quality"]
        Review["Automated reviews\nthrough multiple lenses"]
        Fix["Agent fixes\nany issues found"]
        Review -->|"problems found"| Fix --> Review
        Review -->|"all clear"| Ship
        Ship["Commit, push,\nopen PR"]
    end

    Issue --> Research
    TestCheck --> Review

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

## Example: End-to-End Walkthrough

Here's what actually happens when you ask the system to add a health check endpoint:

```mermaid
sequenceDiagram
    actor You
    participant Planner as 💬 Planner
    participant Scout as 🔍 Scout
    participant Impl as ⚙️ Implement
    participant BG as 🔨 Build Gate
    participant TW as 🧪 Test-Write
    participant TG as ✅ Test Gate
    participant Rev as 📋 Review
    participant Git as 🚀 GitOps

    Note over You,Planner: 1. Planning
    You->>Planner: "Add a health check endpoint"
    Planner->>You: What should it return?
    You->>Planner: JSON with status, uptime, and DB connectivity
    Planner->>You: Here's the issue proposal...
    Note right of Planner: title: Add /api/health endpoint<br/>description: GET /api/health returns<br/>{ status, uptime, db_ok }<br/>lenses: general, error_handling
    You->>Planner: Looks good, create it

    Note over Scout,Impl: 2. Research
    Scout->>Scout: searchFiles("health")
    Scout->>Scout: readFile("src/server/api.ts")
    Scout->>Scout: readFile("src/server/db.ts")
    Scout->>Scout: listDirectory("src/server")
    Note right of Scout: Manifest:<br/>- src/server/api.ts (pattern)<br/>- src/server/db.ts (DB access)<br/>- src/server/index.ts (mounting)

    Note over Impl,BG: 3. Implementation
    Impl->>Impl: readRelevantFiles()
    Note right of Impl: Gets all 3 files in one call
    Impl->>Impl: replaceInFile("api.ts", add endpoint)
    Impl->>Impl: checkBuild()
    Note right of Impl: "success" ✓

    Note over BG: 4. Build Gate
    BG->>BG: Run: npx tsc --noEmit
    Note right of BG: Exit 0 → pass ✓

    Note over TW,TG: 5. Test Writing
    TW->>TW: readFile("src/server/api.test.ts")
    TW->>TW: writeFile("add health endpoint tests")
    TW->>TW: checkTests()
    Note right of TW: 3 tests pass ✓

    Note over TG: 6. Test Gate
    TG->>TG: Run: npx jest
    Note right of TG: All pass → pass ✓

    Note over Rev: 7. Review — General Lens
    Rev->>Rev: readFile("src/server/api.ts")
    Rev->>Rev: checkBuild()
    Rev->>Rev: checkTests()
    Note right of Rev: ✓ Addresses the issue<br/>✓ Additive change<br/>✓ No rewrites<br/>→ status: accept

    Note over Rev: 8. Review — Error Handling Lens
    Rev->>Rev: readFile("src/server/api.ts")
    Note right of Rev: ✓ DB check has try/catch<br/>✓ Returns 503 if DB is down<br/>→ status: accept

    Note over Git: 9. GitOps
    Git->>Git: Create GitHub issue #42
    Git->>Git: git commit "Add /api/health endpoint (#42)"
    Git->>Git: git push
    Git->>Git: Create PR → Closes #42
    Note right of Git: PR #15 ready for your review

    Git->>You: PR ready — Approve or Reject?
```

### What the agent actually sees at each step

**Scout's file manifest:**
```
- src/server/api.ts (590 lines) — endpoint patterns to follow
- src/server/db.ts (425 lines) — DB access for health check
- src/server/index.ts (94 lines) — route mounting pattern
```

**Implementer's first action:**
```
Tool: readRelevantFiles()
Result: ### src/server/api.ts (590 lines)
        [full file contents]
        ### src/server/db.ts (425 lines)
        [full file contents]
        ...
```

**Build gate output:**
```
success
```

**Review verdict (General):**
```
status: accept
summary: Endpoint is additive, follows existing patterns,
         no signature changes, tests cover the key behaviors.
```

**Review verdict (Error Handling):**
```
status: accept
summary: DB connectivity check uses try/catch, returns 503
         on failure with useful error message. Timeout is set.
```

**Final PR:**
```
Title: Add /api/health endpoint (#42)
Body: GET /api/health returns { status: "ok", uptime: 1234, db_ok: true }
      Closes #42
```
