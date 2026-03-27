# Data Model

```mermaid
erDiagram
    PROJECT ||--o{ ISSUE : contains
    PROJECT {
        string id PK
        string name
        string workdir
        string git_remote
        string model_id
        string build_command
        string test_command
    }

    ISSUE ||--o{ RUN : has
    ISSUE ||--o{ ISSUE : "parent/child (epic)"
    ISSUE {
        string id PK
        string project_id FK
        string title
        string status
        string review_lenses
        string parent_id FK
        string depends_on
        int sequence
    }

    RUN ||--o{ LLM_REQUEST : logs
    RUN {
        string id PK
        string issue_id FK
        string stage
        string status
        text output
        int duration_ms
    }

    MACHINE {
        string id PK
        string base_url
        string model_id
        string status
    }

    PLANNER_CONVERSATION ||--o{ PLANNER_MESSAGE : contains
    PLANNER_CONVERSATION {
        string id PK
        string project_id FK
        string status
        string issue_id
    }

    LLM_REQUEST {
        string id PK
        string issue_id FK
        string run_id FK
        int prompt_tokens
        int completion_tokens
        int duration_ms
    }
```

## Tables

| Table | Purpose |
|-------|---------|
| `machines` | LLM server endpoints (base_url, model_id, status, context_limit) |
| `projects` | Git repos to work on (workdir, remote, default branch, build/test commands) |
| `issues` | Work items — standalone, epic parents, or epic children |
| `runs` | One per pipeline stage execution (scout, implement, build_gate, test_write, test_gate, review:lens, git_ops) |
| `llm_requests` | Per-step LLM call logs with token counts and duration |
| `planner_conversations` | Interactive planning sessions |
| `planner_messages` | Messages within planning conversations |

## Key Relationships

- **Machine → Issue**: A machine works on one issue at a time (`status: "working"`, `current_run_id`)
- **Issue → Issue**: Epic parent/child via `parent_id`. Dependencies via `depends_on` (JSON array of issue IDs)
- **Issue → Run**: Multiple runs per issue (one per stage, plus retries)
- **Run → LLM Request**: Multiple LLM calls per run (one per agent step)
- **Planner Conversation → Issue**: A conversation produces an issue on approval (`issue_id`)
