import { test, assert } from "vitest";

import { actorLabel, actorLabelForMessage, formatTurnTime, relatedPrForCard } from "./collaboration.js";
import type { BoardCard } from "./card-types.js";

test("actorLabel maps authors to display names", () => {
  assert.equal(actorLabel("hermes"), "Hermes");
  assert.equal(actorLabel("operator"), "Pascal");
  assert.equal(actorLabel("claude"), "Claude");
  assert.equal(actorLabel("test-writer"), "Test-writer");
  assert.equal(actorLabel("codex"), "Codex");
  assert.equal(actorLabel("system"), "System");
});

test("actorLabelForMessage labels Hermes live vs templated provenance", () => {
  assert.equal(actorLabelForMessage({ author: "hermes", hermesMode: "live" }), "Hermes (live)");
  assert.equal(actorLabelForMessage({ author: "hermes", hermesMode: "templated" }), "Hermes (offline — templated)");
  assert.equal(actorLabelForMessage({ author: "hermes" }), "Hermes");
  assert.equal(actorLabelForMessage({ author: "operator" }), "Pascal");
});

test("formatTurnTime renders HH:MM and tolerates a bad timestamp", () => {
  assert.match(formatTurnTime(Date.parse("2026-05-28T09:05:00")), /^\d\d:\d\d$/);
  assert.equal(formatTurnTime(Number.NaN, () => Date.parse("2026-05-28T01:02:00")), "01:02");
});

test("relatedPrForCard derives {repo, number} from a #-numbered card", () => {
  const pr = { id: "agent #548", repo: "depre-dev/agent" } as BoardCard;
  assert.deepEqual(relatedPrForCard(pr), { repo: "depre-dev/agent", number: 548 });
});

test("relatedPrForCard returns undefined for cards without a # number or repo", () => {
  assert.equal(relatedPrForCard({ id: "mission browser-onboard-04", repo: "depre-dev/site" } as BoardCard), undefined);
  assert.equal(relatedPrForCard({ id: "task starter-coding-014", repo: "depre-dev/agent" } as BoardCard), undefined);
  assert.equal(relatedPrForCard({ id: "agent #5", repo: "" } as BoardCard), undefined);
  assert.equal(relatedPrForCard(undefined), undefined);
});
