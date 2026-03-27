# Issue Lifecycle

## State Machine

```mermaid
stateDiagram-v2
    [*] --> Planning: "Plan with AI" or "New Issue"

    state Planning {
        Conversation --> Proposal: Requirements clear
        Proposal --> Conversation: Revise
        Proposal --> IssueCreated: Approve
    }

    IssueCreated --> Pending
    Pending --> Epic: "Break into Stories"

    state Epic {
        Story1: Story 1
        Story2: Story 2
        Story3: Story 3
        Story1 --> Story2: depends_on
        Story1 --> Story3: parallel
    }

    Pending --> Running: "Approve & Run"
    Running --> AwaitingReview: Pipeline complete
    Running --> Failed: Error / timeout
    Failed --> Running: Retry
    AwaitingReview --> Completed: "Approve PR"
    AwaitingReview --> Failed: "Reject PR"
```

## Issue Statuses

| Status | Meaning | User Actions |
|--------|---------|-------------|
| `pending` | Created, waiting for approval | Approve & Run, Break into Stories, edit lenses |
| `approved` | Approved, waiting for machine | (automatic transition) |
| `running` | Pipeline is executing | Cancel |
| `awaiting_review` | PR created, waiting for human | Approve PR, Reject PR, View Diff |
| `completed` | PR merged | (terminal) |
| `failed` | Pipeline or PR rejected | Retry All, Resume from Checkpoint |
| `epic` | Container for child stories | View stories |

## Epic Decomposition

Epics are issues with `status: "epic"` that contain child issues. Each child has:
- `parent_id` — points to the epic
- `sequence` — display order
- `depends_on` — JSON array of sibling issue IDs that must complete first

Epics can be created two ways:
1. **Planner produces `epic_proposal`** — automatically creates epic + stories
2. **"Break into Stories" button** — sends existing issue to LLM for decomposition, converts it to an epic

Epic status is derived from children in the UI (not stored):
- All completed → completed
- Any failed → failed
- Any running → running
- Otherwise → pending
