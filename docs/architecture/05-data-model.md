# Data Model

SQLite database with WAL mode. Drizzle ORM for schema, raw SQL for complex queries. Migrations in `db.ts` `migrate()` method.

## Entity Relationships

```mermaid
erDiagram
    PROJECT ||--o{ ISSUE : contains
    PROJECT ||--o{ ANALYSIS_CONFIG : has
    PROJECT ||--o{ PLANNER_CONVERSATION : has
    PROJECT {
        string id PK
        string name
        string workdir
        string git_remote
        string default_branch
        string model_id
        string build_command
        string test_command
        string lint_command
    }

    MACHINE {
        string id PK
        string name
        string base_url
        string model_id
        string machine_type
        string status
        int max_concurrent
        string api_key
    }

    ISSUE ||--o{ RUN : has
    ISSUE ||--o{ ISSUE : "parent/child (epic)"
    ISSUE {
        string id PK
        string project_id FK
        string title
        string description
        string status
        string review_lenses
        string parent_id FK
        string depends_on
        int sequence
        string branch
        string pr_url
    }

    RUN ||--o{ LLM_REQUEST : logs
    RUN {
        string id PK
        string issue_id FK
        string machine_id FK
        string stage
        string status
        text output
        int duration_ms
    }

    LLM_REQUEST {
        string id PK
        string issue_id FK
        string run_id FK
        string foreman_run_id FK
        int prompt_tokens
        int completion_tokens
        int cache_read_tokens
        int cache_write_tokens
        int duration_ms
    }

    DIRECTOR_DIRECTIVE ||--o{ DIRECTOR_MILESTONE : has
    DIRECTOR_DIRECTIVE ||--o{ DIRECTOR_CONVERSATION : has
    DIRECTOR_DIRECTIVE ||--o{ DIRECTOR_REVIEW : has
    DIRECTOR_DIRECTIVE ||--o{ FOREMAN_TASK : generates
    DIRECTOR_DIRECTIVE {
        string id PK
        string project_id FK
        string title
        string status
        string autonomy_level
        text design_doc
        text user_brief
    }

    DIRECTOR_MILESTONE {
        string id PK
        string directive_id FK
        string title
        string status
        int sequence
        text verification_criteria
    }

    DIRECTOR_REVIEW {
        string id PK
        string directive_id FK
        string type
        string status
        text context
        text response
    }

    DIRECTOR_CONVERSATION ||--o{ DIRECTOR_MESSAGE : contains
    DIRECTOR_CONVERSATION {
        string id PK
        string directive_id FK
        string status
    }

    DIRECTOR_MESSAGE {
        string id PK
        string conversation_id FK
        string role
        text content
    }

    FOREMAN_TASK ||--o{ FOREMAN_RUN : has
    FOREMAN_TASK {
        string id PK
        string directive_id FK
        string milestone_id FK
        string project_id FK
        string title
        string type
        string status
        int priority
        text description
        text acceptance_criteria
        string depends_on
        string branch
    }

    FOREMAN_RUN {
        string id PK
        string task_id FK
        string machine_id FK
        string status
        text output
        text validation_result
        int duration_ms
        int prompt_tokens
        int completion_tokens
    }

    FOREMAN_CONFIG {
        string key PK
        text value
    }

    ANALYSIS_CONFIG ||--o{ ANALYSIS_RUN : triggers
    ANALYSIS_CONFIG {
        string id PK
        string project_id FK
        string lens_key
        string frequency
    }

    ANALYSIS_RUN {
        string id PK
        string config_id FK
        string status
        text findings
    }

    PLANNER_CONVERSATION ||--o{ PLANNER_MESSAGE : contains
    PLANNER_CONVERSATION {
        string id PK
        string project_id FK
        string status
        string issue_id
    }

    PLANNER_MESSAGE {
        string id PK
        string conversation_id FK
        string role
        text content
    }
```

## Table Groups

### Core Tables

| Table | Purpose |
|-------|---------|
| `machines` | LLM/ComfyUI server endpoints. Fields: base_url, model_id, machine_type (`inference`/`comfyui`), status, max_concurrent, api_key |
| `projects` | Git repos to work on. Fields: workdir, git_remote, default_branch, build/test/lint commands, model_id override |
| `issues` | Issues Pipeline work items — standalone, epic parents, or epic children. Fields: status, review_lenses, parent_id, depends_on, branch, pr_url |
| `runs` | Issues Pipeline stage executions (scout, implement, build_gate, test_write, test_gate, review:lens, git_ops). Token tracking per run |
| `llm_requests` | Per-step LLM call audit log with prompt/completion/cache token counts and duration |

### Director Tables

| Table | Purpose |
|-------|---------|
| `director_directives` | Top-level goals with autonomy_level (conservative/standard/aggressive), status, design_doc, milestone tracking |
| `director_milestones` | Sequenced phases within directives, each with verification_criteria and status |
| `director_reviews` | Human-in-the-loop review gates. Types: task_verify, design_choice, milestone_gate, failure_escalation, style_selection |
| `director_conversations` | Conversation sessions per directive |
| `director_messages` | Individual messages within conversations |

### Foreman Tables

| Table | Purpose |
|-------|---------|
| `foreman_tasks` | Work units queued for execution. Types: code, art, music, sfx, style_exploration, review, content, claude. Fields: priority, depends_on, acceptance_criteria, branch |
| `foreman_runs` | Execution attempts per task with output, validation_result, token usage |
| `foreman_config` | Global settings: enabled, tasks_dir, priority_mode, tick_interval, director_reserved_machine, analysis toggle, continuous_exploration |

### Planning & Analysis Tables

| Table | Purpose |
|-------|---------|
| `planner_conversations` | Interactive planning sessions for issues |
| `planner_messages` | Messages within planning conversations |
| `analysis_configs` | Per-project, per-lens analysis configuration with frequency |
| `analysis_runs` | Analysis execution results with findings |

## Key Relationships

- **Machine → Foreman Task**: A machine works on tasks via leases managed by Machine Manager
- **Directive → Milestone**: Sequenced 1:N, milestones advance in order
- **Directive → Foreman Task**: Director generates tasks during planning phases
- **Directive → Review**: Gates created at decision points, pause the directive
- **Foreman Task → Foreman Run**: Multiple execution attempts per task
- **Issue → Issue**: Epic parent/child via `parent_id`. Dependencies via `depends_on` (JSON array)
- **Issue → Run**: Multiple runs per issue (one per pipeline stage, plus retries)
- **Run → LLM Request**: Multiple LLM calls per run (one per agent step)
- **LLM Request → Foreman Run**: LLM calls also tracked for foreman executions via `foreman_run_id`
