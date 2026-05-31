import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  CollaborationValidationError,
  __resetCollaborationStoreForTests,
  classifyHermesMemoryRequest,
  listCollaborationMessages,
  listHermesMemoryNotes,
  listReviewRequests,
  recordCollaborationMessage,
  recordHermesMemoryNote,
  recordReviewPanelRequests,
  recordReviewResponse,
  recordReviewRequest,
  recordReviewResponse,
  synthesizeHermesReplyFor,
} from "../../services/slack-operator/src/monitor-collab.js";
import { listCodexTasks } from "../../services/slack-operator/src/codex-task-queue.js";

const NOW = Date.UTC(2026, 4, 18, 12, 0, 0);

describe("monitor collaboration channel", () => {
  beforeEach(() => {
    __resetCollaborationStoreForTests();
  });

  it("records a valid operator chat message with defaults", () => {
    const message = recordCollaborationMessage(
      { author: "operator", text: "Codex, pick up #137 next." },
      NOW
    );
    expect(message).toMatchObject({
      author: "operator",
      kind: "chat",
      addressedTo: "everyone",
      text: "Codex, pick up #137 next.",
      ts: NOW,
    });
    expect(message.id).toMatch(/^collab-/);
  });

  it("normalizes author/kind/addressedTo casing and trims text", () => {
    const message = recordCollaborationMessage(
      {
        author: "  Codex  ",
        kind: "PROPOSAL",
        addressedTo: "Hermes",
        text: "   Hermes, please re-check after my last push.   ",
      },
      NOW
    );
    expect(message).toMatchObject({
      author: "codex",
      kind: "proposal",
      addressedTo: "hermes",
      text: "Hermes, please re-check after my last push.",
    });
  });

  it("accepts Claude as a card-scoped agent author and target", () => {
    const message = recordCollaborationMessage(
      {
        author: "Claude",
        kind: "status",
        addressedTo: "Codex",
        text: "Codex, I reviewed this card and need a smaller repro before I can continue.",
        relatedPr: { repo: "averray-agent/agent", number: 214 },
      },
      NOW
    );

    expect(message).toMatchObject({
      author: "claude",
      kind: "status",
      addressedTo: "codex",
      text: expect.stringContaining("smaller repro"),
      relatedPr: { repo: "averray-agent/agent", number: 214 },
    });
    expect(listCollaborationMessages({ limit: 1 }, NOW + 1)[0]).toMatchObject({
      author: "claude",
      addressedTo: "codex",
      relatedPr: { repo: "averray-agent/agent", number: 214 },
    });
  });

  it("accepts the test-writer specialist as a card-scoped author and target", () => {
    const message = recordCollaborationMessage(
      {
        author: "test-writer",
        kind: "status",
        addressedTo: "Claude",
        text: "Claude, I added the failing parser coverage.",
        relatedPr: { repo: "averray-agent/agent", number: 214 },
      },
      NOW
    );

    expect(message).toMatchObject({
      author: "test-writer",
      addressedTo: "claude",
      text: expect.stringContaining("parser coverage"),
      relatedPr: { repo: "averray-agent/agent", number: 214 },
    });
  });

  it("preserves relatedPr and relatedCorrelationId when well-formed", () => {
    const message = recordCollaborationMessage(
      {
        author: "hermes",
        kind: "request_help",
        text: "Pascal, I cannot resolve a flaky test on #221.",
        addressedTo: "operator",
        relatedPr: { repo: "averray-agent/agent", number: 221 },
        relatedCorrelationId: "smoke-2026-05-18-abc",
      },
      NOW
    );
    expect(message.relatedPr).toEqual({ repo: "averray-agent/agent", number: 221 });
    expect(message.relatedCorrelationId).toBe("smoke-2026-05-18-abc");
  });

  it("drops malformed relatedPr without failing the record", () => {
    const message = recordCollaborationMessage(
      {
        author: "codex",
        text: "Status update.",
        kind: "status",
        relatedPr: { repo: "", number: 0 },
      },
      NOW
    );
    expect(message.relatedPr).toBeUndefined();
  });

  it("rejects unknown authors", () => {
    expect(() =>
      recordCollaborationMessage({ author: "stranger", text: "hi" }, NOW)
    ).toThrowError(CollaborationValidationError);
  });

  it("rejects empty text", () => {
    expect(() =>
      recordCollaborationMessage({ author: "operator", text: "   " }, NOW)
    ).toThrowError(CollaborationValidationError);
  });

  it("truncates very long text to 4000 chars", () => {
    const long = "a".repeat(5_000);
    const message = recordCollaborationMessage({ author: "operator", text: long }, NOW);
    expect(message.text).toHaveLength(4_000);
  });

  it("falls back to chat when kind is unknown", () => {
    const message = recordCollaborationMessage(
      { author: "operator", text: "hi", kind: "rant" },
      NOW
    );
    expect(message.kind).toBe("chat");
    expect(message.addressedTo).toBe("everyone");
  });

  it("rejects unknown targets instead of silently broadcasting", () => {
    expect(() =>
      recordCollaborationMessage(
        { author: "claude", text: "Codex, can you clarify this?", addressedTo: "everybody" },
        NOW
      )
    ).toThrowError(CollaborationValidationError);
  });

  it("lists messages newest-last and respects limit", () => {
    for (let i = 0; i < 5; i += 1) {
      recordCollaborationMessage(
        { author: "operator", text: `msg ${i}` },
        NOW + i
      );
    }
    const listed = listCollaborationMessages({ limit: 3 }, NOW + 1_000);
    expect(listed.map((m) => m.text)).toEqual(["msg 2", "msg 3", "msg 4"]);
  });

  it("respects sinceMs for incremental tailing", () => {
    recordCollaborationMessage({ author: "operator", text: "old" }, NOW);
    recordCollaborationMessage({ author: "codex", text: "newer" }, NOW + 5_000);
    const listed = listCollaborationMessages({ sinceMs: NOW + 1_000 }, NOW + 10_000);
    expect(listed.map((m) => m.text)).toEqual(["newer"]);
  });

  it("hides entries older than the 24h soft TTL", () => {
    recordCollaborationMessage({ author: "operator", text: "ancient" }, NOW);
    const later = NOW + 25 * 60 * 60 * 1000;
    recordCollaborationMessage({ author: "operator", text: "fresh" }, later);
    const listed = listCollaborationMessages({}, later);
    expect(listed.map((m) => m.text)).toEqual(["fresh"]);
  });

  it("caps the ring buffer at 500 entries (oldest dropped)", () => {
    for (let i = 0; i < 600; i += 1) {
      recordCollaborationMessage(
        { author: "operator", text: `m${i}` },
        NOW + i
      );
    }
    const listed = listCollaborationMessages({ limit: 500 }, NOW + 700);
    expect(listed).toHaveLength(500);
    // The first 100 should have been evicted.
    expect(listed[0].text).toBe("m100");
    expect(listed[499].text).toBe("m599");
  });
});

describe("monitor review requests", () => {
  beforeEach(() => {
    __resetCollaborationStoreForTests();
  });

  it("creates a card-scoped cross-agent review request", () => {
    const request = recordReviewRequest(
      {
        relatedPr: { repo: "depre-dev/averray-reference-agent", number: 298 },
        requestedBy: "hermes",
        reviewer: "claude",
        reason: "Second-agent review before this O5 board-health slice moves forward.",
      },
      NOW
    );

    expect(request).toMatchObject({
      requestedBy: "hermes",
      reviewer: "claude",
      status: "requested",
      relatedPr: { repo: "depre-dev/averray-reference-agent", number: 298 },
      reason: expect.stringContaining("Second-agent review"),
      createdAt: "2026-05-18T12:00:00.000Z",
      updatedAt: "2026-05-18T12:00:00.000Z",
    });
    expect(request.id).toMatch(/^review-/);
  });

  it("rejects invalid review authors and reviewers", () => {
    expect(() =>
      recordReviewRequest({
        relatedPr: { repo: "depre-dev/averray-reference-agent", number: 298 },
        requestedBy: "system",
        reviewer: "claude",
        reason: "system cannot request this advisory review",
      }, NOW)
    ).toThrowError(CollaborationValidationError);

    expect(() =>
      recordReviewRequest({
        relatedPr: { repo: "depre-dev/averray-reference-agent", number: 298 },
        requestedBy: "hermes",
        reviewer: "everyone",
        reason: "reviewer must be a concrete actor",
      }, NOW)
    ).toThrowError(CollaborationValidationError);
  });

  it("lists requests with attribution and preserves collaboration context", () => {
    recordCollaborationMessage(
      { author: "operator", text: "Hermes, keep this card parked until review lands." },
      NOW - 1
    );
    const request = recordReviewRequest(
      {
        correlationId: "agent-task-42",
        requestedBy: "operator",
        reviewer: "codex",
        reason: "Please review Claude's plan before work proceeds.",
      },
      NOW
    );

    expect(listReviewRequests({ limit: 5 })).toEqual([request]);
    expect(listReviewRequests({ status: "requested" })[0]).toMatchObject({
      requestedBy: "operator",
      reviewer: "codex",
      correlationId: "agent-task-42",
    });
    expect(listCollaborationMessages({ limit: 5 }, NOW + 1).map((message) => message.text)).toEqual([
      "Hermes, keep this card parked until review lands.",
      expect.stringContaining("Review requested from Codex"),
    ]);
  });

  it("creates review requests involving the test-writer specialist", () => {
    const request = recordReviewRequest(
      {
        correlationId: "agent-task-99",
        requestedBy: "hermes",
        reviewer: "test-writer",
        reason: "Please add coverage before this card moves forward.",
      },
      NOW
    );

    expect(request).toMatchObject({
      requestedBy: "hermes",
      reviewer: "test-writer",
      correlationId: "agent-task-99",
      status: "requested",
    });
    expect(listCollaborationMessages({ limit: 1 }, NOW + 1)[0]).toMatchObject({
      author: "hermes",
      addressedTo: "test-writer",
      text: expect.stringContaining("Test-writer"),
    });
  });

  it("requires a card scope and never creates a task as a side effect", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-request-task-queue-"));
    const queuePath = join(dir, "tasks.json");
    try {
      await expect(listCodexTasks({ path: queuePath })).resolves.toEqual([]);
      expect(() =>
        recordReviewRequest({
          requestedBy: "hermes",
          reviewer: "claude",
          reason: "missing relatedPr, relatedMission, or correlationId",
        }, NOW)
      ).toThrowError(CollaborationValidationError);

      recordReviewRequest({
        relatedMission: { id: "mission-browser-123" },
        requestedBy: "hermes",
        reviewer: "claude",
        reason: "Review the mission evidence before follow-up work.",
      }, NOW);

      await expect(listCodexTasks({ path: queuePath })).resolves.toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fans a high-risk panel into independent Hermes, Codex, and Claude review requests", () => {
    const panel = recordReviewPanelRequests(
      {
        relatedPr: { repo: "depre-dev/averray-reference-agent", number: 302 },
        requestedBy: "hermes",
        riskTier: "high",
        builder: "codex",
        reason: "High-risk deploy and secret surface touched.",
      },
      NOW
    );

    expect(panel.mode).toBe("panel");
    expect(panel.reviewers).toEqual(["hermes", "codex", "claude"]);
    expect(panel.requests).toHaveLength(3);
    expect(new Set(panel.requests.map((request) => request.panelId))).toEqual(new Set([panel.panelId]));
    expect(panel.requests.map((request) => request.reviewMode)).toEqual(["panel", "panel", "panel"]);
    expect(listReviewRequests({ status: "requested" })).toHaveLength(3);
    expect(listCollaborationMessages({ limit: 5 }, NOW + 1).map((message) => message.addressedTo)).toEqual([
      "hermes",
      "codex",
      "claude",
    ]);
  });

  it("records panel verdicts without escalating while the panel is incomplete", () => {
    const panel = recordReviewPanelRequests(
      {
        relatedPr: { repo: "depre-dev/averray-reference-agent", number: 304 },
        requestedBy: "hermes",
        riskTier: "high",
        builder: "codex",
        reason: "High-risk tester mission gate touched deploy-ops.",
      },
      NOW
    );

    const result = recordReviewResponse(
      {
        panelId: panel.panelId,
        reviewer: "hermes",
        verdict: "pass",
        reasoning: "Hermes sees the gate as advisory-only.",
      },
      NOW + 1
    );

    expect(result.reviewRequest).toMatchObject({
      reviewer: "hermes",
      status: "responded",
      response: {
        verdict: "pass",
        reasoning: "Hermes sees the gate as advisory-only.",
      },
    });
    expect(result.panelEvaluation).toMatchObject({
      agreement: "pending",
      panelVerdict: "pending",
      escalate: false,
    });
  });

  it("escalates high-risk panel disagreement as action-needed without creating tasks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-panel-task-queue-"));
    const queuePath = join(dir, "tasks.json");
    try {
      const panel = recordReviewPanelRequests(
        {
          relatedPr: { repo: "depre-dev/averray-reference-agent", number: 304 },
          requestedBy: "hermes",
          riskTier: "high",
          builder: "codex",
          reason: "High-risk tester mission gate touched deploy-ops.",
        },
        NOW
      );

      recordReviewResponse({
        panelId: panel.panelId,
        reviewer: "hermes",
        verdict: "pass",
        reasoning: "Hermes sees the gate as advisory-only.",
      }, NOW + 1);
      recordReviewResponse({
        panelId: panel.panelId,
        reviewer: "codex",
        verdict: "pass",
        reasoning: "Codex confirms no merge authority changed.",
      }, NOW + 2);
      const final = recordReviewResponse({
        panelId: panel.panelId,
        reviewer: "claude",
        verdict: "concern",
        reasoning: "Claude wants operator review before this moves forward.",
      }, NOW + 3, { boardUrl: "https://monitor.example/monitor" });

      expect(final.panelEvaluation).toMatchObject({
        agreement: "majority",
        panelVerdict: "pass",
        escalate: true,
        alert: {
          boardUrl: "https://monitor.example/monitor",
        },
      });
      expect(final.panelEvaluation?.alert?.text).toContain("Claude: concern");
      expect(listCollaborationMessages({ limit: 10 }, NOW + 10)).toContainEqual(expect.objectContaining({
        author: "hermes",
        addressedTo: "operator",
        kind: "request_help",
        text: expect.stringContaining("Advisory only"),
      }));
      await expect(listCodexTasks({ path: queuePath })).resolves.toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("escalates any blocking panel verdict with every reviewer verdict attached", () => {
    const panel = recordReviewPanelRequests(
      {
        relatedPr: { repo: "depre-dev/averray-reference-agent", number: 305 },
        requestedBy: "hermes",
        riskTier: "high",
        builder: "claude",
        reason: "High-risk chain-settlement behavior changed.",
      },
      NOW
    );

    recordReviewResponse({
      panelId: panel.panelId,
      reviewer: "hermes",
      verdict: "pass",
      reasoning: "Hermes confirms this is only a review record.",
    }, NOW + 1);
    recordReviewResponse({
      panelId: panel.panelId,
      reviewer: "codex",
      verdict: "block",
      reasoning: "Codex blocks until operator checks the chain-surface reasoning.",
    }, NOW + 2);
    const final = recordReviewResponse({
      panelId: panel.panelId,
      reviewer: "claude",
      verdict: "concern",
      reasoning: "Claude flags migration rollback ambiguity.",
    }, NOW + 3);

    expect(final.panelEvaluation).toMatchObject({
      agreement: "blocked",
      panelVerdict: "block",
      escalate: true,
    });
    expect(final.panelEvaluation?.alert?.text).toContain("Hermes: pass");
    expect(final.panelEvaluation?.alert?.text).toContain("Codex: block");
    expect(final.panelEvaluation?.alert?.text).toContain("Claude: concern");
  });

  it("keeps non-high-risk review panels on the single C1 cross-agent path", () => {
    const panel = recordReviewPanelRequests(
      {
        correlationId: "github-pr-302",
        requestedBy: "hermes",
        riskTier: "low",
        builder: "codex",
      },
      NOW
    );

    expect(panel).toMatchObject({
      mode: "single",
      reviewers: ["claude"],
    });
    expect(panel.requests).toHaveLength(1);
    expect(panel.requests[0]).toMatchObject({
      reviewer: "claude",
      reviewMode: "single",
      panelSize: 1,
    });
  });

  it("records panel reviewer verdicts against existing requests without creating tasks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-panel-response-task-queue-"));
    const queuePath = join(dir, "tasks.json");
    try {
      const panel = recordReviewPanelRequests(
        {
          relatedPr: { repo: "depre-dev/averray-reference-agent", number: 302 },
          requestedBy: "hermes",
          riskTier: "high",
          builder: "codex",
          reason: "High-risk contract-adjacent surface.",
        },
        NOW
      );

      const codex = recordReviewResponse(
        {
          panelId: panel.panelId,
          reviewer: "codex",
          verdict: "block",
          reasoning: "Settlement path needs operator proof before merge.",
        },
        NOW + 1_000
      );

      expect(codex.reviewRequest).toMatchObject({
        reviewer: "codex",
        status: "responded",
        response: {
          verdict: "block",
          reasoning: "Settlement path needs operator proof before merge.",
        },
      });
      expect(codex.panelEvaluation).toMatchObject({
        agreement: "blocked",
        panelVerdict: "block",
        escalate: true,
      });
      expect(listReviewRequests({ status: "responded" })).toHaveLength(1);
      expect(listCollaborationMessages({ limit: 1 }, NOW + 2_000)[0]).toMatchObject({
        author: "hermes",
        addressedTo: "operator",
        kind: "request_help",
        text: expect.stringContaining("Advisory only"),
      });
      await expect(listCodexTasks({ path: queuePath })).resolves.toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Hermes collaboration memory", () => {
  beforeEach(() => {
    __resetCollaborationStoreForTests();
  });

  it("learns operator guidance as global memory", () => {
    recordCollaborationMessage(
      {
        author: "operator",
        addressedTo: "hermes",
        text: "Remember: draft PRs that belong to another agent should wait until that agent finishes.",
      },
      NOW
    );
    const notes = listHermesMemoryNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      scope: "global",
      text: expect.stringContaining("draft PRs that belong to another agent"),
    });
  });

  it("records system-learned testbed mission memory with correlation context", () => {
    const note = recordHermesMemoryNote(
      {
        text: "Testbed mission report for https://testbed.example/app: verdict partial. Top blocker: unclear wallet boundary.",
        relatedCorrelationId: "testbed-mission-abc-1",
      },
      NOW
    );

    expect(note).toMatchObject({
      scope: "global",
      relatedCorrelationId: "testbed-mission-abc-1",
      text: expect.stringContaining("verdict partial"),
    });
    expect(listHermesMemoryNotes({
      relatedCorrelationId: "testbed-mission-abc-1",
    }).map((entry) => entry.text)).toEqual([
      expect.stringContaining("unclear wallet boundary"),
    ]);
  });

  it("keeps PR-scoped memory tied to the selected PR while retaining global guidance", () => {
    recordCollaborationMessage(
      {
        author: "operator",
        addressedTo: "everyone",
        text: "Remember: ask me before moving external-agent drafts.",
      },
      NOW
    );
    recordCollaborationMessage(
      {
        author: "operator",
        addressedTo: "hermes",
        text: "This draft belongs to another agent; do not ask Codex to start it yet.",
        relatedPr: { repo: "averray-agent/agent", number: 439 },
      },
      NOW + 1
    );
    recordCollaborationMessage(
      {
        author: "operator",
        addressedTo: "hermes",
        text: "This draft belongs to Codex now.",
        relatedPr: { repo: "averray-agent/agent", number: 440 },
      },
      NOW + 2
    );

    const notes = listHermesMemoryNotes({
      relatedPr: { repo: "averray-agent/agent", number: 439 },
    });
    expect(notes.map((note) => note.text).join("\n")).toContain("external-agent drafts");
    expect(notes.map((note) => note.text).join("\n")).toContain("averray-agent/agent#439");
    expect(notes.map((note) => note.text).join("\n")).not.toContain("averray-agent/agent#440");
  });

  it("learns operator outcome memory from failed task review actions", () => {
    recordCollaborationMessage(
      {
        author: "operator",
        kind: "status",
        addressedTo: "codex",
        text: "Codex, I opened the failed task output for averray-agent/agent#438. I am looking for the runner error first; the next move is either a smaller retry task or a clear no-code-change explanation.",
        relatedPr: { repo: "averray-agent/agent", number: 438 },
      },
      NOW
    );

    const notes = listHermesMemoryNotes({
      relatedPr: { repo: "averray-agent/agent", number: 438 },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      scope: "pr",
      text: expect.stringContaining("failed Codex runner output"),
      relatedPr: { repo: "averray-agent/agent", number: 438 },
    });
  });

  it("learns draft takeover and operator send-back outcomes addressed to Codex", () => {
    recordCollaborationMessage(
      {
        author: "operator",
        kind: "proposal",
        addressedTo: "codex",
        text: "Codex, please take over averray-agent/agent#439. It is still a draft, but I want you to inspect the branch, finish only the missing work you can verify, run the relevant checks, and mark it ready only if it is actually complete. Do not merge or deploy.",
        relatedPr: { repo: "averray-agent/agent", number: 439 },
      },
      NOW
    );
    recordCollaborationMessage(
      {
        author: "operator",
        kind: "request_help",
        addressedTo: "codex",
        text: "Codex, I am sending averray-agent/agent#151 back from operator review. Hermes' pre-check is not enough for me to approve it yet: backend changed. Please make the smallest justified fix, or report clearly if the right answer is no code change.",
        relatedPr: { repo: "averray-agent/agent", number: 151 },
      },
      NOW + 1
    );

    const draftNotes = listHermesMemoryNotes({
      relatedPr: { repo: "averray-agent/agent", number: 439 },
    });
    const sendBackNotes = listHermesMemoryNotes({
      relatedPr: { repo: "averray-agent/agent", number: 151 },
    });
    expect(draftNotes.map((note) => note.text).join("\n")).toContain("delegated draft takeover");
    expect(sendBackNotes.map((note) => note.text).join("\n")).toContain("sent operator review back to Codex");
  });

  it("learns local review and Codex task approval outcomes", () => {
    recordCollaborationMessage(
      {
        author: "operator",
        kind: "status",
        addressedTo: "hermes",
        text: "Hermes, I reopened my local review for averray-agent/agent#440. Keep it out of the release path until I mark it reviewed again or send it back to Codex.",
        relatedPr: { repo: "averray-agent/agent", number: 440 },
      },
      NOW
    );
    recordCollaborationMessage(
      {
        author: "operator",
        kind: "approval",
        addressedTo: "codex",
        text: "Codex, I approved the task for averray-agent/agent#440. You are allowed to pick it up now; please keep the change bounded, push only if there is a concrete fix, and let Hermes re-check after CI.",
        relatedPr: { repo: "averray-agent/agent", number: 440 },
      },
      NOW + 1
    );

    const text = listHermesMemoryNotes({
      relatedPr: { repo: "averray-agent/agent", number: 440 },
    }).map((note) => note.text).join("\n");
    expect(text).toContain("reopened local review");
    expect(text).toContain("approved the Codex task");
  });

  it("does not learn ordinary chatter or Codex-authored messages", () => {
    recordCollaborationMessage(
      { author: "operator", addressedTo: "hermes", text: "thanks, looks good" },
      NOW
    );
    recordCollaborationMessage(
      { author: "codex", addressedTo: "hermes", text: "Remember this runner path." },
      NOW + 1
    );
    expect(listHermesMemoryNotes()).toEqual([]);
  });

  it("classifies memory show and forget requests only when Hermes is addressed", () => {
    expect(classifyHermesMemoryRequest({
      author: "operator",
      addressedTo: "hermes",
      text: "Hermes, what do you remember about this PR?",
    })).toBe("show");
    expect(classifyHermesMemoryRequest({
      author: "operator",
      addressedTo: "everyone",
      text: "Hermes, forget this PR memory.",
    })).toBe("forget_pr");
    expect(classifyHermesMemoryRequest({
      author: "codex",
      addressedTo: "hermes",
      text: "what do you remember about this PR?",
    })).toBe("none");
    expect(classifyHermesMemoryRequest({
      author: "operator",
      addressedTo: "codex",
      text: "what do you remember about this PR?",
    })).toBe("none");
  });

  it("does not learn memory governance requests as guidance", () => {
    recordCollaborationMessage(
      {
        author: "operator",
        addressedTo: "hermes",
        text: "Hermes, what do you remember about this PR?",
        relatedPr: { repo: "averray-agent/agent", number: 439 },
      },
      NOW
    );
    recordCollaborationMessage(
      {
        author: "operator",
        addressedTo: "hermes",
        text: "Hermes, forget this PR memory.",
      },
      NOW + 1
    );

    expect(listHermesMemoryNotes()).toEqual([]);
  });

  it("forgets only PR-scoped memory for the selected PR", () => {
    recordCollaborationMessage(
      {
        author: "operator",
        addressedTo: "hermes",
        text: "Remember: ask me before moving external-agent drafts.",
      },
      NOW
    );
    recordCollaborationMessage(
      {
        author: "operator",
        addressedTo: "hermes",
        text: "This draft belongs to another agent; do not ask Codex to start it yet.",
        relatedPr: { repo: "averray-agent/agent", number: 439 },
      },
      NOW + 1
    );
    recordCollaborationMessage(
      {
        author: "operator",
        addressedTo: "hermes",
        text: "This draft belongs to Codex now.",
        relatedPr: { repo: "averray-agent/agent", number: 440 },
      },
      NOW + 2
    );

    recordCollaborationMessage(
      {
        author: "operator",
        addressedTo: "hermes",
        text: "Hermes, forget this PR memory.",
        relatedPr: { repo: "averray-agent/agent", number: 439 },
      },
      NOW + 3
    );

    const pr439 = listHermesMemoryNotes({
      relatedPr: { repo: "averray-agent/agent", number: 439 },
    }).map((note) => note.text).join("\n");
    const pr440 = listHermesMemoryNotes({
      relatedPr: { repo: "averray-agent/agent", number: 440 },
    }).map((note) => note.text).join("\n");

    expect(pr439).toContain("external-agent drafts");
    expect(pr439).not.toContain("averray-agent/agent#439");
    expect(pr440).toContain("averray-agent/agent#440");
  });

  it("deduplicates repeated guidance", () => {
    const input = {
      author: "operator",
      addressedTo: "hermes",
      text: "Remember: release queue means merge steward owns the next move.",
    };
    recordCollaborationMessage(input, NOW);
    recordCollaborationMessage(input, NOW + 1);
    const notes = listHermesMemoryNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].ts).toBe(NOW + 1);
  });

  it("deduplicates repeated operator outcome memory", () => {
    const input = {
      author: "operator",
      addressedTo: "codex",
      text: "Codex, I approved the task for averray-agent/agent#443. You are allowed to pick it up now; please keep the change bounded, push only if there is a concrete fix, and let Hermes re-check after CI.",
      relatedPr: { repo: "averray-agent/agent", number: 443 },
    };
    recordCollaborationMessage(input, NOW);
    recordCollaborationMessage(input, NOW + 1);
    const notes = listHermesMemoryNotes({
      relatedPr: { repo: "averray-agent/agent", number: 443 },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0].ts).toBe(NOW + 1);
  });

  it("persists learned memory when a memory path is configured", () => {
    const previousPath = process.env.HERMES_MONITOR_MEMORY_PATH;
    const dir = mkdtempSync(join(tmpdir(), "hermes-memory-"));
    const memoryPath = join(dir, "memory.json");
    try {
      process.env.HERMES_MONITOR_MEMORY_PATH = memoryPath;
      __resetCollaborationStoreForTests();
      recordCollaborationMessage(
        {
          author: "operator",
          addressedTo: "hermes",
          text: "Remember: draft PRs owned by external agents should stay out of Codex Needed.",
        },
        NOW
      );

      const persisted = JSON.parse(readFileSync(memoryPath, "utf8")) as {
        notes: Array<{ text: string }>;
      };
      expect(persisted.notes[0].text).toContain("external agents");

      __resetCollaborationStoreForTests();
      expect(listHermesMemoryNotes()[0].text).toContain("external agents");
    } finally {
      if (previousPath === undefined) {
        delete process.env.HERMES_MONITOR_MEMORY_PATH;
      } else {
        process.env.HERMES_MONITOR_MEMORY_PATH = previousPath;
      }
      __resetCollaborationStoreForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("synthesizeHermesReplyFor", () => {
  beforeEach(() => {
    __resetCollaborationStoreForTests();
  });

  function opMessage(overrides: Record<string, unknown> = {}) {
    return recordCollaborationMessage(
      {
        author: "operator",
        text: "ping",
        addressedTo: "hermes",
        ...overrides,
      },
      NOW
    );
  }

  it("does not reply to messages from non-operator authors", () => {
    const m = recordCollaborationMessage(
      { author: "codex", text: "I picked up #1.", addressedTo: "hermes" },
      NOW
    );
    expect(synthesizeHermesReplyFor(m)).toBeNull();
  });

  it("does not auto-reply to Claude agent messages", () => {
    const m = recordCollaborationMessage(
      { author: "claude", text: "Hermes, please hold this until Codex replies.", addressedTo: "hermes" },
      NOW
    );
    expect(synthesizeHermesReplyFor(m)).toBeNull();
  });

  it("does not reply to operator messages addressed only to codex", () => {
    const m = opMessage({ addressedTo: "codex" });
    expect(synthesizeHermesReplyFor(m)).toBeNull();
  });

  it("does not reply when operator addresses only themselves", () => {
    const m = opMessage({ addressedTo: "operator" });
    expect(synthesizeHermesReplyFor(m)).toBeNull();
  });

  it("replies when operator addresses hermes", () => {
    const m = opMessage({ addressedTo: "hermes" });
    const reply = synthesizeHermesReplyFor(m);
    expect(reply).not.toBeNull();
    expect(reply?.addressedTo).toBe("operator");
    expect(reply?.text.length).toBeGreaterThan(0);
  });

  it("replies when operator addresses everyone", () => {
    const m = opMessage({ addressedTo: "everyone" });
    expect(synthesizeHermesReplyFor(m)).not.toBeNull();
  });

  it("references the related PR in the reply when present", () => {
    const m = opMessage({
      addressedTo: "hermes",
      relatedPr: { repo: "averray-agent/agent", number: 137 },
    });
    const reply = synthesizeHermesReplyFor(m);
    expect(reply?.text).toContain("averray-agent/agent#137");
    expect(reply?.relatedPr).toEqual({ repo: "averray-agent/agent", number: 137 });
  });

  it("does not imply plain chat dispatched Codex work", () => {
    const m = opMessage({
      addressedTo: "hermes",
      text: "send it to codex",
    });
    const reply = synthesizeHermesReplyFor(m);
    expect(reply?.text).toContain("board-scoped chat");
    expect(reply?.text).toContain("/task codex owner/repo#PR");
    expect(reply?.text).toContain("no runner has been queued");
    expect(reply?.force).toBe(true);
  });

  it("gives the exact slash-command shape when a Codex dispatch ask is scoped to a PR", () => {
    const m = opMessage({
      addressedTo: "hermes",
      text: "please hand this back to Codex",
      relatedPr: { repo: "depre-dev/averray-reference-agent", number: 301 },
    });
    const reply = synthesizeHermesReplyFor(m);
    expect(reply?.text).toContain("depre-dev/averray-reference-agent#301");
    expect(reply?.text).toContain("/task codex depre-dev/averray-reference-agent#301");
    expect(reply?.text).toContain("no runner has been queued");
    expect(reply?.relatedPr).toEqual({ repo: "depre-dev/averray-reference-agent", number: 301 });
    expect(reply?.force).toBe(true);
  });

  it("uses a help-specific reply for request_help intent", () => {
    const m = opMessage({ kind: "request_help" });
    const reply = synthesizeHermesReplyFor(m);
    expect(reply?.text.toLowerCase()).toContain("blocker");
  });

  it("uses a proposal-specific reply for proposal intent", () => {
    const m = opMessage({
      kind: "proposal",
      relatedPr: { repo: "averray-agent/agent", number: 200 },
    });
    const reply = synthesizeHermesReplyFor(m);
    expect(reply?.text.toLowerCase()).toMatch(/noted|verdict/);
  });

  it("forwards relatedCorrelationId so the reply stays threaded to the same PR session", () => {
    const m = opMessage({
      addressedTo: "everyone",
      relatedCorrelationId: "smoke-2026-05-18-abc",
    });
    const reply = synthesizeHermesReplyFor(m);
    expect(reply?.relatedCorrelationId).toBe("smoke-2026-05-18-abc");
  });
});
