# Pipeline Stages

## Stage Flow

```mermaid
graph LR
    Scout["🔍 Scout\n(read-only)"]
    Implement["⚙️ Implement\n(read + write)"]
    TestWrite["🧪 Test-Write\n(write tests only)"]
    Review["📋 Review\n(read-only + run)"]
    GitOps["🚀 GitOps\n(commit + push + PR)"]

    Scout -->|file manifest| Implement
    Implement -->|code changes| TestWrite
    TestWrite -->|test results| Review
    Review -->|accept| NextLens{More lenses?}
    Review -->|reject| Implement
    NextLens -->|yes| Review
    NextLens -->|no| GitOps

    style Scout fill:#1e3a5f
    style Implement fill:#1e3a5f
    style TestWrite fill:#1e3a5f
    style Review fill:#1e3a5f
    style GitOps fill:#1e3a5f
```

## What Each Stage Sees and Does

```mermaid
graph TD
    subgraph Scout["Scout Stage"]
        S1[Explore codebase with read-only tools]
        S2[Identify relevant files]
        S3["Submit file manifest\n{files: [{path, reason}]}"]
        S1 --> S2 --> S3
    end

    subgraph Resolve["Server-Side Resolution"]
        R1["Parse manifest JSON"]
        R2["Read line counts from disk"]
        R3["Build file list for implementer"]
        R1 --> R2 --> R3
    end

    subgraph Impl["Implement Stage"]
        I1["Call readRelevantFiles\n(one tool call, all files)"]
        I2["Make code changes\nreplaceInFile / writeFile"]
        I3["Run build to verify"]
        I1 --> I2 --> I3
    end

    S3 --> R1
    R3 --> I1
```

## Stage Details

| Stage | Access | Tools | Purpose |
|-------|--------|-------|---------|
| **Scout** | Read-only | readFile, searchFiles, listDirectory, getFileInfo, saveCheckpoint | Find all files relevant to the issue |
| **Implement** | Read + Write | All filesystem tools + readRelevantFiles | Read files and make code changes |
| **Test-Write** | Read + Write (tests only) | readFile, searchFiles, writeFile, runCommand | Write and run tests for the changes |
| **Review** | Read + Run | readFile, searchFiles, runCommand, gitStatus, gitDiff | Review the implementation through focused lenses |
| **GitOps** | Git operations | (internal) | Create GitHub issue, commit, push, create PR |
