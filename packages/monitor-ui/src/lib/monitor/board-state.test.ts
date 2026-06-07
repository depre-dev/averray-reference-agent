// Tests for board-state.js — selectors and derived state for the
// Hermes Handoff Monitor. M1 milestone.

import { test, assert } from "vitest";

import {
  kpiCounts,
  mostUrgentCard,
  boardMode,
  boardNowBanner,
  deriveBoardState,
  matchesBoardFilter,
} from "./board-state.js";

// Reused fixture factory — keep card shapes minimal but realistic.
function card(overrides) {
  return {
    id: "test-1",
    lane: "hermes-checking",
    type: "pr",
    agentType: "codex",
    title: "Test card",
    summary: "summary",
    repo: "test/repo",
    freshness: 5,
    state: "fresh",
    risk: [],
    waitingOn: { actor: "CI", tone: "info" },
    files: [],
    ...overrides,
  };
}

// ── kpiCounts ───────────────────────────────────────────────────────

test("kpiCounts: empty list returns zeros across the board", () => {
  const result = kpiCounts([]);
  assert.deepEqual(result, {
    action: 0,
    codex: 0,
    review: 0,
    checking: 0,
    queue: 0,
    deploying: 0,
    blocked: 0,
    done: 0,
    total: 0,
  });
});

test("kpiCounts: realistic mix counts each KPI correctly", () => {
  const cards = [
    card({ id: "act-1", isAction: true }),
    card({ id: "rev-1", lane: "operator-review" }),
    card({ id: "rev-2", lane: "operator-review" }),
    card({ id: "codex-1", type: "task", lane: "codex-needed" }),
    card({ id: "chk-1", lane: "hermes-checking" }),
    card({ id: "queue-1", lane: "release-queue" }),
    card({ id: "deploy-1", type: "deploy", deployId: "#1", verification: { current: 0, total: 1, label: "" } }),
    card({ id: "done-1", type: "done", lane: "done", closedAt: "2026-05-27", mergeStatus: "MERGED" }),
    card({ id: "done-2", type: "done", lane: "done", closedAt: "2026-05-27", mergeStatus: "MERGED" }),
  ];
  const result = kpiCounts(cards);
  assert.equal(result.action, 1);
  assert.equal(result.codex, 1);
  assert.equal(result.review, 2);
  assert.equal(result.checking, 1);
  assert.equal(result.queue, 1);
  assert.equal(result.deploying, 1);
  assert.equal(result.done, 2);
  // total = all live lanes (1+1+2+1+1+1) = 7
  assert.equal(result.total, 7);
  assert.equal(result.blocked, 0);
});

test("kpiCounts: blocked count includes failed-fetch + source-offline states", () => {
  const cards = [
    card({ id: "failed", state: "failed-fetch" }),
    card({ id: "offline", state: "source-offline" }),
    card({ id: "fresh", state: "fresh" }),
  ];
  const result = kpiCounts(cards);
  assert.equal(result.blocked, 2);
});

// ── mostUrgentCard ──────────────────────────────────────────────────

test("mostUrgentCard: returns undefined for empty board", () => {
  assert.equal(mostUrgentCard([]), undefined);
  assert.equal(mostUrgentCard(undefined), undefined);
});

test("mostUrgentCard: skips done-lane cards (only live work counts)", () => {
  const cards = [
    card({ id: "done-1", type: "done", lane: "done", freshness: 1, closedAt: "2026-05-27", mergeStatus: "MERGED" }),
    card({ id: "live-1", freshness: 100 }),
  ];
  const urgent = mostUrgentCard(cards);
  assert.equal(urgent.id, "live-1");
});

test("mostUrgentCard: picks the action card when one exists", () => {
  const cards = [
    card({ id: "fresh-1", freshness: 1 }),
    card({ id: "action-1", isAction: true, freshness: 200 }),
    card({ id: "fresh-2", freshness: 2 }),
  ];
  const urgent = mostUrgentCard(cards);
  assert.equal(urgent.id, "action-1");
});

test("mostUrgentCard: falls back to freshest non-action card when nothing needs the operator", () => {
  const cards = [
    card({ id: "older", freshness: 60 }),
    card({ id: "newer", freshness: 2 }),
    card({ id: "middle", freshness: 10 }),
  ];
  const urgent = mostUrgentCard(cards);
  assert.equal(urgent.id, "newer");
});

// ── boardMode ───────────────────────────────────────────────────────

test("boardMode: empty board is calm", () => {
  assert.equal(boardMode([]), "calm");
  assert.equal(boardMode(undefined), "calm");
});

test("boardMode: a single action card → action mode", () => {
  const cards = [card({ id: "a", isAction: true })];
  assert.equal(boardMode(cards), "action");
});

test("boardMode: scoped Hermes conversation on pending review card → hermes-focus", () => {
  const cards = [
    card({ id: "agent #548", lane: "operator-review", isAction: true, waitingOn: { actor: "operator", tone: "warn" } }),
  ];
  assert.equal(boardMode(cards, { hermesFocusCardId: "agent #548" }), "hermes-focus");
});

test("boardMode: blocked cards force degraded mode (overrides action)", () => {
  // A failed-fetch card means we can't trust the data — even if
  // something looks like it needs action, the truthful UI mode is
  // "the data is broken."
  const cards = [
    card({ id: "broken", state: "failed-fetch" }),
    card({ id: "act", isAction: true }),
  ];
  assert.equal(boardMode(cards), "degraded");
});

test("boardMode: streamOnline=false forces degraded regardless of cards", () => {
  // If the live stream is down, the whole board is untrustworthy
  // even if every card claims state=fresh.
  const cards = [card({ id: "a", freshness: 1, state: "fresh" })];
  assert.equal(boardMode(cards, { streamOnline: false }), "degraded");
});

test("boardMode: streamOnline=true is a no-op (calm/action driven by cards)", () => {
  assert.equal(boardMode([card({ isAction: true })], { streamOnline: true }), "action");
});

// ── boardNowBanner ──────────────────────────────────────────────────

test("boardNowBanner: action mode produces an action-toned banner with the most urgent card cited", () => {
  const cards = [
    card({
      id: "act-1",
      isAction: true,
      title: "Approve the thing",
      risk: ["secrets"],
      action: { kind: "operator-review", primary: "Approve merge" },
      decisionRecord: {
        schemaVersion: 1,
        recordType: "hermes_decision_record",
        id: "dr-act-1",
        kind: "auto_approval",
        subject: { type: "pr", id: "act-1" },
        decision: "escalated",
        reasons: ["Secret-touching change requires operator review"],
        inputs: {},
        outcome: { summary: "Waiting on operator" },
        safety: { readOnly: true, mutates: false },
        generatedAt: "2026-06-07T10:00:00.000Z",
      },
    }),
  ];
  const banner = boardNowBanner(cards, { nowLabel: "14:32:08 utc" });
  assert.equal(banner.tone, "action");
  assert.match(banner.eyebrow, /1 action needed/);
  assert.equal(banner.headline, "1 decision waiting on you");
  assert.equal(banner.sub, "Most urgent: Approve the thing — suggests Approve merge.");
  assert.equal(banner.primaryActionId, "act-1");
  assert.deepEqual(
    banner.mostUrgentReasons?.map((reason) => ({ label: reason.label, tone: reason.tone })),
    [
      { label: "blocked 5m", tone: "neutral" },
      { label: "risk: secrets", tone: "risk" },
      { label: "safe: read-only", tone: "safe" },
    ],
  );
});

test("boardNowBanner: multiple action cards pluralize correctly", () => {
  const cards = [
    card({ id: "a1", isAction: true, title: "A" }),
    card({ id: "a2", isAction: true, title: "B" }),
  ];
  const banner = boardNowBanner(cards);
  assert.match(banner.eyebrow, /2 action needed/);
  assert.equal(banner.headline, "2 decisions waiting on you");
});

test("boardNowBanner: action banner traces to existing most-urgent selection", () => {
  const cards = [
    card({ id: "later", isAction: true, title: "Later decision", freshness: 30 }),
    card({ id: "urgent", isAction: true, title: "Urgent decision", freshness: 1, action: { kind: "operator-review", primary: "Review now" } }),
  ];
  const banner = boardNowBanner(cards);
  assert.equal(mostUrgentCard(cards)?.id, "urgent");
  assert.equal(banner.primaryActionId, "urgent");
  assert.equal(banner.sub, "Most urgent: Urgent decision — suggests Review now.");
});

test("boardNowBanner: most-urgent reasons stay empty when the card has no real signals", () => {
  const banner = boardNowBanner([
    card({ id: "thin", isAction: true, title: "Thin card", freshness: undefined, risk: [] }),
  ]);
  assert.deepEqual(banner.mostUrgentReasons, []);
});

test("boardNowBanner: Hermes focus mode uses the scoped review card", () => {
  const cards = [
    card({ id: "agent #548", lane: "operator-review", isAction: true, title: "Review relay hang fix", waitingOn: { actor: "operator", tone: "warn" } }),
  ];
  const banner = boardNowBanner(cards, { nowLabel: "14:32:43 utc", hermesFocusCardId: "agent #548" });
  assert.equal(banner.tone, "hermes-focus");
  assert.match(banner.eyebrow, /in conversation with Hermes/);
  assert.match(banner.headline, /Hermes has the floor/);
  assert.match(banner.headline, /1 review decision pending/);
  assert.match(banner.sub, /Review relay hang fix/);
  assert.equal(banner.primaryActionId, "agent #548");
});

test("boardNowBanner: zero-decision board renders the first-class calm empty state", () => {
  const banner = boardNowBanner([], { nowLabel: "17:48:02 utc" });
  assert.equal(banner.tone, "calm");
  assert.match(banner.eyebrow, /you're done for now/);
  assert.match(banner.headline, /Nothing needs you right now/);
  assert.match(banner.headline, /quiet on purpose/);
  assert.match(banner.sub, /No active decisions, dispatches, or release work/);
});

test("boardNowBanner: calm sub only includes metrics the board model provides", () => {
  const cards = [
    card({ id: "done-1", type: "done", lane: "done", closedAt: "2026-05-27", mergeStatus: "MERGED" }),
  ];
  const banner = boardNowBanner(cards, {
    calmMetrics: {
      avgTimeToDecision: "4m 12s",
      disputes: 0,
      lastDeploy: { id: "#246", verifiedAt: "17:42:11" },
    },
  });
  assert.match(banner.sub, /avg time-to-decision 4m 12s/);
  assert.match(banner.sub, /0 dispute/);
  assert.match(banner.sub, /last deploy #246 verified at 17:42:11/);

  const withoutMetrics = boardNowBanner(cards);
  assert.notMatch(withoutMetrics.sub, /avg time-to-decision|dispute|last deploy/);
});

test("boardNowBanner: calm board with in-flight automation reads correctly", () => {
  const cards = [
    card({ id: "check-1", lane: "hermes-checking" }),
    card({ id: "deploy-1", type: "deploy", deployId: "#1", verification: { current: 1, total: 3, label: "" } }),
  ];
  const banner = boardNowBanner(cards);
  assert.equal(banner.tone, "calm");
  assert.match(banner.headline, /automation\/release card/);
  // 1 checking + 1 deploying = 2
  assert.match(banner.headline, /2 automation\/release card/);
});

test("boardNowBanner: calm board names Codex-owned work instead of claiming the board is empty", () => {
  const cards = [
    card({ id: "codex-1", type: "task", lane: "codex-needed", title: "Fix a failing check" }),
    card({ id: "deploy-1", type: "deploy", deployId: "#1", verification: { current: 1, total: 3, label: "" } }),
  ];
  const banner = boardNowBanner(cards);
  assert.equal(banner.tone, "calm");
  // PR-F2: the calm banner leads with the honest nothing-waiting state (no stale
  // "No operator decision needed"), but still names the in-flight work.
  assert.match(banner.headline, /Nothing needs you right now/);
  assert.notMatch(banner.headline, /No operator decision needed/);
  assert.match(banner.headline, /1 Codex-owned card/);
  assert.match(banner.headline, /1 automation\/release card/);
});

test("boardNowBanner: degraded mode (stream offline)", () => {
  const banner = boardNowBanner([], {
    streamOnline: false,
    nowLabel: "14:36:20 utc",
    lastGoodLabel: "14:32:08 utc",
  });
  assert.equal(banner.tone, "degraded");
  assert.match(banner.eyebrow, /degraded/);
  assert.match(banner.headline, /Live stream disconnected/);
  assert.match(banner.sub, /Last known good read: 14:32:08 utc/);
  assert.equal(banner.primaryActionId, undefined);
});

test("boardNowBanner: degraded mode (cards reporting failed-fetch but stream up)", () => {
  const cards = [
    card({ id: "broken-1", state: "failed-fetch" }),
    card({ id: "broken-2", state: "failed-fetch" }),
  ];
  const banner = boardNowBanner(cards);
  assert.equal(banner.tone, "degraded");
  assert.match(banner.headline, /2 card\(s\) report stale or offline upstream data/);
});

// ── deriveBoardState ───────────────────────────────────────────────

test("deriveBoardState: bundles every selector together", () => {
  const cards = [
    card({ id: "act", isAction: true, title: "Action card" }),
    card({ id: "rev", lane: "operator-review" }),
    card({ id: "done-1", type: "done", lane: "done", closedAt: "2026-05-27", mergeStatus: "MERGED" }),
  ];
  const state = deriveBoardState(cards, { nowLabel: "14:32:08 utc" });
  assert.equal(state.mode, "action");
  assert.equal(state.counts.action, 1);
  assert.equal(state.counts.review, 1);
  assert.equal(state.counts.done, 1);
  assert.equal(state.banner.tone, "action");
  assert.equal(state.banner.primaryActionId, "act");
  assert.equal(state.mostUrgent.id, "act");
  assert.equal(state.grouped["needs-attention"].length, 1);
  assert.equal(state.grouped["operator-review"].length, 1);
  assert.equal(state.grouped["done"].length, 1);
});

test("matchesBoardFilter: today-done keeps only done cards closed on the snapshot date", () => {
  const today = card({ id: "today", type: "done", lane: "done", closedAt: "2026-06-01T08:00:00.000Z", mergeStatus: "MERGED" });
  const yesterday = card({ id: "yesterday", type: "done", lane: "done", closedAt: "2026-05-31T22:00:00.000Z", mergeStatus: "MERGED" });
  assert.equal(matchesBoardFilter(today, "today-done", { todayIso: "2026-06-01T12:00:00.000Z" }), true);
  assert.equal(matchesBoardFilter(yesterday, "today-done", { todayIso: "2026-06-01T12:00:00.000Z" }), false);
});

test("matchesBoardFilter — chips narrow by the same lane derivation as the counts", () => {
  const action = card({ id: "a", isAction: true });
  const review = card({ id: "r", lane: "operator-review" });
  const ready = card({ id: "q", lane: "release-queue" });
  const running = card({ id: "c", lane: "hermes-checking" });
  const done = card({ id: "d", type: "done", lane: "done" });
  const blocked = card({ id: "b", state: "source-offline" });

  // "all" matches everything.
  for (const c of [action, review, ready, running, done, blocked]) {
    assert.equal(matchesBoardFilter(c, "all"), true);
  }
  // Lane-based chips match only their lane.
  assert.equal(matchesBoardFilter(review, "review"), true);
  assert.equal(matchesBoardFilter(running, "review"), false);
  assert.equal(matchesBoardFilter(ready, "ready"), true);
  assert.equal(matchesBoardFilter(running, "running"), true);
  assert.equal(matchesBoardFilter(done, "done"), true);
  assert.equal(matchesBoardFilter(review, "done"), false);
  // "blocked" is the cross-lane stale/offline state.
  assert.equal(matchesBoardFilter(blocked, "blocked"), true);
  assert.equal(matchesBoardFilter(running, "blocked"), false);
});
