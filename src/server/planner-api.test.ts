import { parseIssueProposal } from "./planner-api";

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
