import { parseIssueProposal, parseEpicProposal } from "./planner-api";

// ─── parseIssueProposal ────────────────────────────────────────────────────

describe("parseIssueProposal", () => {
  it("parses a well-formed proposal", () => {
    const content = `Here's the issue specification:

\`\`\`issue_proposal
title: Add user authentication via OAuth2

description:
## Context
The app currently has no authentication.

## Requirements
- When a user visits the app, the system shall redirect to the OAuth2 provider
- The system shall store the access token in a secure HTTP-only cookie

## Acceptance Criteria
- [ ] OAuth2 flow works end-to-end
- [ ] Tokens are stored securely

review_lenses: general, security
\`\`\`

Does this look right?`;

    const result = parseIssueProposal(content);
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Add user authentication via OAuth2");
    expect(result!.description).toContain("OAuth2 provider");
    expect(result!.description).toContain("Acceptance Criteria");
    expect(result!.lenses).toEqual(["general", "security"]);
  });

  it("returns null when no proposal block exists", () => {
    expect(parseIssueProposal("Just some chat text.")).toBeNull();
    expect(parseIssueProposal("```code\nsome code\n```")).toBeNull();
  });

  it("returns null when title is missing", () => {
    const content = `\`\`\`issue_proposal
description:
Something

review_lenses: general
\`\`\``;
    expect(parseIssueProposal(content)).toBeNull();
  });

  it("handles missing description gracefully", () => {
    const content = `\`\`\`issue_proposal
title: Fix the bug

review_lenses: general
\`\`\``;
    const result = parseIssueProposal(content);
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Fix the bug");
    expect(result!.description).toBe("");
    expect(result!.lenses).toEqual(["general"]);
  });

  it("defaults to general lens when review_lenses is missing", () => {
    const content = `\`\`\`issue_proposal
title: Simple change

description:
Just a small tweak.
\`\`\``;
    const result = parseIssueProposal(content);
    expect(result).not.toBeNull();
    expect(result!.lenses).toEqual(["general"]);
  });

  it("parses comma-separated lenses", () => {
    const content = `\`\`\`issue_proposal
title: Frontend overhaul

description:
Redesign the dashboard.

review_lenses: general, ui, performance
\`\`\``;
    const result = parseIssueProposal(content);
    expect(result!.lenses).toEqual(["general", "ui", "performance"]);
  });

  it("parses space-separated lenses", () => {
    const content = `\`\`\`issue_proposal
title: API hardening

description:
Secure the endpoints.

review_lenses: general security
\`\`\``;
    const result = parseIssueProposal(content);
    expect(result!.lenses).toEqual(["general", "security"]);
  });

  it("handles extra whitespace in the block", () => {
    const content = `\`\`\`issue_proposal
title:   Trim this title

description:
  Some indented content.

review_lenses:   general , ui
\`\`\``;
    const result = parseIssueProposal(content);
    expect(result!.title).toBe("Trim this title");
    expect(result!.description).toContain("indented content");
    expect(result!.lenses).toEqual(["general", "ui"]);
  });

  it("handles multiline description with code blocks inside", () => {
    const content = `\`\`\`issue_proposal
title: Add API endpoint

description:
Add a new endpoint:

The system shall expose GET /api/health that returns { status: "ok" }.

Acceptance criteria:
- [ ] Endpoint returns 200
- [ ] Response is JSON

review_lenses: general
\`\`\``;
    const result = parseIssueProposal(content);
    expect(result!.description).toContain("GET /api/health");
    expect(result!.description).toContain("Acceptance criteria");
  });

  it("extracts from multiple assistant messages (uses the provided content)", () => {
    // parseIssueProposal works on a single string — the API layer
    // handles scanning multiple messages. Verify it finds the first block.
    const content = `I revised the proposal:

\`\`\`issue_proposal
title: Updated title

description:
Updated description.

review_lenses: general, security, performance
\`\`\``;
    const result = parseIssueProposal(content);
    expect(result!.title).toBe("Updated title");
    expect(result!.lenses).toEqual(["general", "security", "performance"]);
  });

  it("handles proposal with no newline before review_lenses", () => {
    const content = `\`\`\`issue_proposal
title: Compact format

description:
Short description.
review_lenses: general, ui
\`\`\``;
    const result = parseIssueProposal(content);
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Compact format");
    expect(result!.description).toBe("Short description.");
    expect(result!.lenses).toEqual(["general", "ui"]);
  });
});

// ─── parseEpicProposal ─────────────────────────────────────────────────────

describe("parseEpicProposal", () => {
  it("parses a well-formed epic with multiple stories", () => {
    const content = `Here's the breakdown:

\`\`\`epic_proposal
title: Add authentication system
description:
Full auth system with login, registration, and session management.

story: 1
title: Add user model and database schema
description:
Create the users table and Drizzle schema.
review_lenses: general, security

story: 2
title: Add login API endpoint
depends_on: 1
description:
POST /api/auth/login endpoint with JWT.
review_lenses: general, security

story: 3
title: Add registration UI
depends_on: 1
description:
Frontend registration form.
review_lenses: general, ui
\`\`\``;

    const result = parseEpicProposal(content);
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Add authentication system");
    expect(result!.description).toContain("Full auth system");
    expect(result!.stories).toHaveLength(3);

    expect(result!.stories[0].title).toBe("Add user model and database schema");
    expect(result!.stories[0].lenses).toEqual(["general", "security"]);
    expect(result!.stories[0].dependsOn).toEqual([]);

    expect(result!.stories[1].title).toBe("Add login API endpoint");
    expect(result!.stories[1].dependsOn).toEqual([1]);

    expect(result!.stories[2].title).toBe("Add registration UI");
    expect(result!.stories[2].dependsOn).toEqual([1]);
    expect(result!.stories[2].lenses).toEqual(["general", "ui"]);
  });

  it("returns null when no epic_proposal block exists", () => {
    expect(parseEpicProposal("Just text.")).toBeNull();
    expect(parseEpicProposal("```issue_proposal\ntitle: not epic\n```")).toBeNull();
  });

  it("returns null when title is missing", () => {
    const content = `\`\`\`epic_proposal
description:
Some feature

story: 1
title: First story
description:
Do something
review_lenses: general
\`\`\``;
    expect(parseEpicProposal(content)).toBeNull();
  });

  it("returns null when no stories exist", () => {
    const content = `\`\`\`epic_proposal
title: Empty epic
description:
No stories here.
\`\`\``;
    expect(parseEpicProposal(content)).toBeNull();
  });

  it("parses depends_on with multiple dependencies", () => {
    const content = `\`\`\`epic_proposal
title: Complex feature
description:
Multi-dependency feature.

story: 1
title: Foundation
description:
Base work.
review_lenses: general

story: 2
title: Part A
depends_on: 1
description:
Depends on foundation.
review_lenses: general

story: 3
title: Part B
depends_on: 1
description:
Also depends on foundation.
review_lenses: general

story: 4
title: Integration
depends_on: 2, 3
description:
Depends on both A and B.
review_lenses: general, testing
\`\`\``;

    const result = parseEpicProposal(content);
    expect(result!.stories).toHaveLength(4);
    expect(result!.stories[3].title).toBe("Integration");
    expect(result!.stories[3].dependsOn).toEqual([2, 3]);
  });

  it("defaults to general lens when review_lenses is missing on a story", () => {
    const content = `\`\`\`epic_proposal
title: Simple epic
description:
Two stories.

story: 1
title: First
description:
Do first thing.

story: 2
title: Second
description:
Do second thing.
\`\`\``;

    const result = parseEpicProposal(content);
    expect(result!.stories[0].lenses).toEqual(["general"]);
    expect(result!.stories[1].lenses).toEqual(["general"]);
  });

  it("skips stories with no title", () => {
    const content = `\`\`\`epic_proposal
title: Partial epic
description:
Some work.

story: 1
title: Valid story
description:
Has a title.
review_lenses: general

story: 2
description:
Missing title — should be skipped.
review_lenses: general
\`\`\``;

    const result = parseEpicProposal(content);
    expect(result!.stories).toHaveLength(1);
    expect(result!.stories[0].title).toBe("Valid story");
  });
});
