// Hermes Handoff Monitor — detail-drawer bodies, one per card type.
//
// Each body is driven entirely by real card fields (verdict, files,
// checks, prompt, verification, mergeStatus, mission report, …) — no
// fabricated CI rows or operator checklists.

import type {
  BoardCard,
  CardCheckRun,
  CardChecks,
  CardFile,
  CardReviewRequest,
  CardRiskSignal,
  DeployCard,
  DoneCard,
  HermesDecisionRecord,
  MissionBlocker,
  MissionCard,
} from "../../lib/monitor/card-types.js";
import { humanizeSignalText } from "../../lib/monitor/signal-labels.js";
import { cleanFailureText } from "../../lib/monitor/mission-failure.js";
import { laneFor } from "../../lib/monitor/lane-rules.js";
import { deployStepsForCard } from "../../lib/monitor/deploy-stepper.js";
import { DeployStepper } from "../DeployStepper.js";
import { ChecksBar } from "../cards/ChecksBar.js";
import { OperatorNotes } from "./OperatorNotes.js";

export type DrawerVariant = "mission" | "action" | "done" | "draft" | "task" | "deploy" | "pr";

export interface DrawerAccent {
  /** Border + eyebrow accent variable. */
  border: string;
  /** Eyebrow pill class. */
  pill: string;
  /** Eyebrow label. */
  label: string;
}

export const DRAWER_ACCENT: Record<DrawerVariant, DrawerAccent> = {
  mission: { border: "var(--hm-hermes)", pill: "hm-pill--hermes", label: "Browser mission · agent report" },
  action: { border: "var(--hm-amber)", pill: "hm-pill--risk", label: "Operator review · risk decision" },
  done: { border: "var(--hm-sage)", pill: "hm-pill--ok", label: "Closed · in release history" },
  draft: { border: "var(--hm-muted)", pill: "hm-pill--draft", label: "Draft · author finishes" },
  task: { border: "var(--hm-sage)", pill: "hm-pill--neutral", label: "Codex task · awaiting dispatch" },
  deploy: { border: "var(--hm-sage)", pill: "hm-pill--neutral", label: "Deploying · post-merge verification" },
  pr: { border: "var(--hm-sage)", pill: "hm-pill--ok", label: "Automation in flight" },
};

/** Pick the drawer variant. Missions render their report; then any card that
 *  is awaiting the operator's decision (isAction, or sitting in an
 *  operator-decision lane) gets the "action" risk-decision treatment — so a
 *  PR in operator-review no longer mislabels as "Automation in flight". Then
 *  closed, draft, and type. */
export function drawerVariant(card: BoardCard): DrawerVariant {
  if (card.type === "mission") return "mission";
  if (card.isAction) return "action";
  const lane = laneFor(card);
  if (lane === "operator-review" || lane === "needs-attention") return "action";
  if (card.type === "done") return "done";
  if (card.isDraft) return "draft"; // DraftCard always has isDraft:true; covers PRCards flagged draft too
  if (card.type === "task") return "task";
  if (card.type === "deploy") return "deploy";
  return "pr";
}

export function DrawerBody({ card, variant }: { card: BoardCard; variant: DrawerVariant }) {
  let body: React.ReactNode;
  switch (variant) {
    case "mission":
      body = <MissionBody card={card as MissionCard} />;
      break;
    case "done":
      body = <DoneBody card={card as DoneCard} />;
      break;
    case "deploy":
      body = <DeployBody card={card as DeployCard} />;
      break;
    case "task":
      body = <TaskBody card={card} />;
      break;
    case "draft":
      body = <DraftBody card={card} />;
      break;
    default:
      body = <PrBody card={card} />;
  }
  return (
    <>
      {body}
      <DecisionRecordSection record={card.decisionRecord} />
      <OperatorNotes cardId={card.id} />
    </>
  );
}

// ── Shared building blocks ──────────────────────────────────────────

function VerdictBlock({
  head,
  children,
  accent,
  tone,
}: {
  head: string;
  children: React.ReactNode;
  accent?: string;
  /** "warn"/"fail" tint the block so a failure doesn't read as the green "ok" box. */
  tone?: "warn" | "fail";
}) {
  return (
    <section>
      <div className="hm-section-h" style={accent ? { color: accent } : undefined}>
        {head}
      </div>
      <div className={"hm-verdict-block" + (tone ? ` hm-verdict-block--${tone}` : "")}>
        <div className="body">{children}</div>
      </div>
    </section>
  );
}

/** A card that represents a failure — its status box must not read as green/ok. */
function isFailureCard(card: BoardCard): boolean {
  if ("taskStatus" in card && (card as { taskStatus?: string }).taskStatus === "failed") return true;
  if ("missionStatus" in card && (card as { missionStatus?: string }).missionStatus === "failed") return true;
  return card.state === "failed-fetch";
}

/** Render a "+A -B" diff line as colored add/rm spans (matches the design). */
function DiffLine({ diff }: { diff: string }) {
  if (!diff) return null;
  return (
    <span className="diff">
      {diff.split(/(?=[+-])/).map((part, i) => (
        <span key={i} className={part.trim().startsWith("+") ? "add" : "rm"}>
          {part}{" "}
        </span>
      ))}
    </span>
  );
}

function FilesSection({ files }: { files: CardFile[] | undefined }) {
  if (!files || files.length === 0) return null;
  return (
    <section>
      <div className="hm-section-h">Files &amp; risk signals</div>
      <div className="hm-files">
        {files.map((f) => (
          <div className="row" key={f.path}>
            <span className="path">{f.path}</span>
            <DiffLine diff={f.diff} />
            {f.critical ? (
              <span className="hm-pill hm-pill--risk">review-gated</span>
            ) : (
              <span className="hm-pill hm-pill--neutral">low-risk</span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

const CHECK_RUN_PILL: Record<CardCheckRun["status"], string> = {
  pass: "hm-pill hm-pill--ok",
  fail: "hm-pill hm-pill--risk",
  running: "hm-pill hm-pill--running",
  neutral: "hm-pill hm-pill--neutral",
};

function ChecksSection({
  checks,
  checkRuns,
}: {
  checks: CardChecks | undefined;
  checkRuns?: CardCheckRun[] | undefined;
}) {
  if (!checks || checks.total <= 0) return null;
  return (
    <section>
      <div className="hm-section-h">
        Checks · {checks.pass}/{checks.total} passed
        {checks.running > 0 ? ` · ${checks.running} running` : ""}
        {checks.fail > 0 ? ` · ${checks.fail} failed` : ""}
      </div>
      <div className="hm-checks">
        <ChecksBar checks={checks} />
      </div>
      {checkRuns && checkRuns.length > 0 ? (
        <div className="hm-files" style={{ marginTop: 8 }}>
          {checkRuns.map((c) => (
            <div className="row" key={c.name}>
              <span className="path">{c.name}</span>
              <span className={CHECK_RUN_PILL[c.status]}>{c.status}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

const RISK_PILL: Record<CardRiskSignal["severity"], string> = {
  high: "hm-pill hm-pill--risk",
  medium: "hm-pill hm-pill--running",
  low: "hm-pill hm-pill--neutral",
};

function actorDisplayName(actor: CardReviewRequest["reviewer"]): string {
  if (actor === "hermes") return "Hermes";
  if (actor === "operator") return "Pascal";
  if (actor === "claude") return "Claude";
  return "Codex";
}

function RiskSignalsSection({ signals }: { signals: CardRiskSignal[] | undefined }) {
  if (!signals || signals.length === 0) return null;
  return (
    <section>
      <div className="hm-section-h">Risk signals · why Hermes flagged this</div>
      <div className="hm-files">
        {signals.map((s) => (
          <div className="row" key={s.code}>
            <span className="path" style={{ whiteSpace: "normal" }}>
              {humanizeSignalText(s.message)}
            </span>
            <span className={RISK_PILL[s.severity]} title={`raw code: ${s.code}`}>
              {s.severity}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ReviewRequestsSection({ requests }: { requests: CardReviewRequest[] | undefined }) {
  const active = requests?.filter((request) => request.status === "requested" || request.response) ?? [];
  if (active.length === 0) return null;
  const isPanel = active.length > 1 || active.some((request) => request.reviewMode === "panel");
  return (
    <section>
      <div className="hm-section-h">{isPanel ? "Reviewer panel" : "Cross-agent review"}</div>
      <div className="hm-files">
        {active.map((request) => (
          <div className="row" key={request.id}>
            <span className="path" style={{ whiteSpace: "normal" }}>
              <b>{actorDisplayName(request.reviewer)}</b>
              {" · "}
              {request.response
                ? `${request.response.verdict}: ${request.response.reasoning}`
                : request.reason}
            </span>
            <span className={request.response?.verdict === "block" ? "hm-pill hm-pill--risk" : "hm-pill hm-pill--neutral"}>
              {request.response?.verdict ?? "requested"}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function DecisionRecordSection({ record }: { record: HermesDecisionRecord | undefined }) {
  if (!record) return null;
  const changed = record.outcome.changed?.join(", ");
  return (
    <section>
      <div className="hm-section-h">Why Hermes did this</div>
      <div className="hm-verdict-block">
        <div className="head">
          {record.kind} · {record.decision}
        </div>
        <div className="body">
          <div>{record.outcome.summary}</div>
          {record.reasons.length > 0 ? (
            <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
              {record.reasons.slice(0, 4).map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
          <div style={{ marginTop: 8, color: "var(--hm-muted)" }}>
            {record.safety.readOnly ? "Read-only" : "Operational"} · {record.safety.mutates ? "mutates state" : "no state mutation"}
            {record.outcome.waitingNext ? ` · Next: ${record.outcome.waitingNext}` : ""}
            {changed ? ` · Changed: ${changed}` : ""}
          </div>
        </div>
      </div>
    </section>
  );
}

// ── Per-type bodies ─────────────────────────────────────────────────

function PrBody({ card }: { card: BoardCard }) {
  const verdict = "verdict" in card ? card.verdict : undefined;
  const files = "files" in card ? card.files : undefined;
  return (
    <>
      {verdict ? (
        <VerdictBlock head="Hermes verdict">{verdict}</VerdictBlock>
      ) : (
        <VerdictBlock head="Status" tone={isFailureCard(card) ? "warn" : undefined}>
          {card.summary || "No additional context yet."}
        </VerdictBlock>
      )}
      <ReviewRequestsSection requests={card.reviewRequests} />
      <RiskSignalsSection signals={card.riskSignals} />
      <FilesSection files={files} />
      <ChecksSection checks={card.checks} checkRuns={card.checkRuns} />
    </>
  );
}

function DraftBody({ card }: { card: BoardCard }) {
  const files = "files" in card ? card.files : undefined;
  return (
    <>
      <VerdictBlock head="Draft — not ready for review" accent="var(--hm-muted)">
        {card.summary ||
          "Author hasn't marked this ready. Hermes leaves drafts alone until they're marked ready for review."}
      </VerdictBlock>
      <FilesSection files={files} />
    </>
  );
}

/**
 * PR-D2b — "if converted to a bug" preview for a Codex task. Drafts what a bug
 * report would carry, entirely from the task's REAL fields (title / repo / risk
 * area / first prompt line / failure reason). Honest awaiting-data when a field
 * is missing; the whole section degrades to an awaiting-data slot when there's
 * not enough task context.
 */
function TaskBugPreview({ card, failureReason }: { card: BoardCard; prompt?: string; failureReason?: string }) {
  // Fields that aren't already shown verbatim elsewhere in the task drawer
  // (title → header, prompt → its own section). The bug a Codex task would
  // become carries its risk area + any failure reason; both are real.
  const rows: Array<[string, string | undefined]> = [
    ["area", card.risk?.[0]],
    ["failure", failureReason],
  ];
  const known = rows.filter(([, v]) => typeof v === "string" && v.trim().length > 0);
  return (
    <section>
      <div className="hm-section-h">If converted to a bug</div>
      {known.length > 0 ? (
        <div className="h4-bug">
          {rows.map(([k, v]) => (
            <div className="h4-bug-row" key={k}>
              <span className="h4-bug-k">{k}</span>
              <span className={"h4-bug-v" + (v && v.trim() ? "" : " is-empty")}>
                {v && v.trim() ? v : "awaiting data"}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <AwaitingData label="Bug preview" note="not enough task context to draft a bug yet" />
      )}
    </section>
  );
}

function TaskBody({ card }: { card: BoardCard }) {
  const prompt = "prompt" in card ? card.prompt : undefined;
  const heartbeat = "runnerHeartbeat" in card ? card.runnerHeartbeat : undefined;
  const failureReason = "failureReason" in card ? (card as { failureReason?: string }).failureReason : undefined;
  return (
    <>
      <VerdictBlock head="Proposed Codex task">{card.summary || "Awaiting operator approval to dispatch."}</VerdictBlock>
      <TaskBugPreview card={card} prompt={prompt} failureReason={failureReason} />
      {prompt ? (
        <section>
          <div className="hm-section-h">Task prompt</div>
          <div className="hm-files" style={{ padding: "10px 12px", whiteSpace: "pre-wrap" }}>
            {prompt}
          </div>
        </section>
      ) : null}
      {heartbeat ? (
        <section>
          <div className="hm-section-h">Runner</div>
          <div className="hm-verdict-block">
            <div className="head" style={{ color: heartbeat.online ? "var(--hm-sage-deep)" : "var(--hm-muted)" }}>
              {heartbeat.online ? "ONLINE" : "OFFLINE"}
            </div>
            <div className="body">Last seen {heartbeat.lastSeen}.</div>
          </div>
        </section>
      ) : null}
    </>
  );
}

/**
 * PR-D2 — an honest "awaiting data" slot for a forensic field that isn't wired
 * to a real backend signal yet. Truth-boundary: we show the field exists and is
 * unwired, never a fabricated value. Styled in the --h4 palette.
 */
function AwaitingData({ label, note }: { label: string; note?: string }) {
  return (
    <div className="h4-awaiting" role="note">
      <span className="h4-awaiting-label">{label}</span>
      <span className="h4-awaiting-chip">awaiting data</span>
      {note ? <span className="h4-awaiting-note">{note}</span> : null}
    </div>
  );
}

function DeployBody({ card }: { card: DeployCard }) {
  // These fields cross an HTTP/JSON boundary and the live backend does not
  // always populate them. A verification-less deploy card must render honest
  // pending steps, not crash or invent completed checkpoints.
  const verification = (card as { verification?: DeployCard["verification"] }).verification;
  const deployId = (card as { deployId?: string }).deployId;
  const steps = deployStepsForCard(card);
  return (
    <>
      <VerdictBlock head="Post-merge verification">{card.summary || "Verifying the deploy."}</VerdictBlock>
      <section>
        <div className="hm-section-h">Checkpoints</div>
        <div className="hm-deploy-stepper-head">
          <span>Current deploy: verifying</span>
          {verification?.label ? <span className="hm-deploy-stepper-source">source: {verification.label}</span> : null}
        </div>
        <DeployStepper steps={steps} />
        {deployId ? <div className="hm-card-meta">Deploy {deployId}.</div> : null}
      </section>
      <ChecksSection checks={card.checks} checkRuns={card.checkRuns} />
    </>
  );
}

function DoneBody({ card }: { card: DoneCard }) {
  const closedAt = (card as { closedAt?: string }).closedAt;
  return (
    <VerdictBlock head="Final verdict · release history" accent="var(--hm-sage-deep)">
      {card.mergeStatus === "MERGED" ? "MERGED" : "CLOSED"}
      {closedAt ? (
        <>
          {" "}· closed at <b>{closedAt}</b>
        </>
      ) : null}
      .
      {card.verdictText ? (
        <>
          <br />
          <br />
          {card.verdictText}
        </>
      ) : null}
    </VerdictBlock>
  );
}

function MissionSpecDetails() {
  return (
    <details className="hm-spec" open>
      <summary>Spec · /mission spawn flow</summary>
      <div className="body">
        <p style={{ margin: "0 0 8px" }}>
          A mission is a first-class work item, not a side-effect of a PR. The flow is symmetric to PR review but
          operates against a live URL, not a diff.
        </p>
        <p style={{ margin: "4px 0" }}>
          <span className="endpoint">POST /missions</span> ·{" "}
          <code>{`{ prompt, target_url, freshness: 'fresh' | 'memory', memory_seed? }`}</code> →{" "}
          <code>{`{ mission_id }`}</code>
        </p>
        <p style={{ margin: "4px 0" }}>
          <span className="endpoint">GET /missions/:id</span> · streams structured report fields as they arrive (
          <code>verdict</code>, <code>confidence</code>, <code>path</code>, <code>blockers</code>, <code>evidence</code>,{" "}
          <code>mutation_boundary</code>, <code>recommendations</code>).
        </p>
        <p style={{ margin: "4px 0" }}>
          <b>Fresh run:</b> new agent, no prior context. Reseeds confidence scoring from zero.
        </p>
        <p style={{ margin: "4px 0" }}>
          <b>Memory run:</b> agent reads the last terminal report as context. Faster, more biased.
        </p>
        <p style={{ margin: "4px 0" }}>
          <b>Create product fix:</b> takes the top recommendation and posts to{" "}
          <span className="endpoint">POST /codex/tasks</span> with the mission report appended as evidence. Operator
          approves before dispatch.
        </p>
      </div>
    </details>
  );
}

/**
 * A single mission blocker. The head/body are shown CLEANED (ANSI,
 * box-drawing, pipes stripped) so they're readable. When cleaning
 * actually changed the text — i.e. the runner left a raw multi-line dump —
 * the original is preserved under a collapsible "raw runner output", one
 * click deep. Truth-boundary: the real failure text is never dropped, just
 * de-emphasized.
 */
function MissionBlockerBlock({ blocker }: { blocker: MissionBlocker }) {
  const rawCombined = [blocker.head, blocker.body].filter(Boolean).join("\n");
  const cleanedHead = cleanFailureText(blocker.head) || blocker.head;
  const cleanedBody = cleanFailureText(blocker.body);
  // Show the raw disclosure only when cleaning meaningfully changed things
  // (otherwise it's redundant noise).
  const rawDiffers = rawCombined.trim() !== `${cleanedHead}${cleanedBody ? ` ${cleanedBody}` : ""}`.trim();
  return (
    <div className="hm-mblock">
      <div className="head">{cleanedHead}</div>
      {cleanedBody ? <div className="body">{cleanedBody}</div> : null}
      {rawDiffers && rawCombined.trim() ? (
        <details className="hm-mblock-raw" style={{ marginTop: 6 }}>
          <summary style={{ cursor: "pointer", color: "var(--hm-muted)", fontSize: 12 }}>
            Show raw runner output
          </summary>
          <pre
            style={{
              margin: "6px 0 0",
              padding: 8,
              background: "var(--hm-paper-3)",
              borderRadius: 6,
              fontSize: 11,
              lineHeight: 1.4,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              overflowX: "auto",
            }}
          >
            {rawCombined}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

/**
 * Live-follow view for a RUNNING mission. Shows only real progress — the stage
 * line + recent runner output (a rolling tail) — and a screenshot only when a
 * servable URL exists. No verdict and no per-step ledger: the agent posts the
 * verdict only in the terminal report, at which point MissionBody re-renders
 * into the full report (the `board.card.updated` SSE refreshes this ~every 2s).
 */
function MissionRunInProgress({ card }: { card: MissionCard }) {
  const progress = card.missionProgress;
  const stage = progress?.message?.trim();
  const output = progress?.output?.trim();
  const screenshot = progress?.screenshot;
  return (
    <>
      <section>
        <div className="hm-section-h">Mission · running</div>
        <div
          className="hm-verdict-block"
          style={{ background: "var(--hm-hermes-soft)", borderColor: "rgba(15,107,90,0.18)" }}
        >
          <div className="head" style={{ color: "var(--hm-hermes-deep)", display: "flex", alignItems: "center", gap: 8 }}>
            <span className="fresh-dot" style={{ background: "var(--hm-hermes)" }} aria-hidden />
            {stage || "Runner claimed the mission — starting…"}
          </div>
          <div className="body" style={{ color: "var(--hm-muted)" }}>{card.title}</div>
        </div>
      </section>

      {/* PR-D2b — live-follow frame from the #413 worker stream. Show the real
          screenshot if the stream has pushed one; otherwise an honest
          awaiting-data slot — never a fabricated frame. */}
      <section>
        <div className="hm-section-h">Latest frame</div>
        {screenshot ? (
          <img
            src={screenshot}
            alt="Latest mission screenshot"
            style={{ width: "100%", borderRadius: "var(--hm-radius)", border: "1px solid var(--hm-line)", display: "block" }}
          />
        ) : (
          <AwaitingData label="Latest frame" note="the runner has not streamed a screenshot yet" />
        )}
      </section>

      <section>
        <div className="hm-section-h">Recent runner output</div>
        {output ? (
          <pre className="hm-mission-run-output">{output}</pre>
        ) : (
          <div className="hm-verdict-block">
            <div className="body" style={{ color: "var(--hm-muted)" }}>
              No output yet — waiting for the runner's first lines.
            </div>
          </div>
        )}
        <div className="hm-mission-run-note">
          Rolling ~12KB tail — older steps scroll off. Refreshes ~every 2s while the run is live.
          No verdict until the agent posts its report.
        </div>
      </section>
    </>
  );
}

/**
 * PR-D2b — Mission forensics: a compact "expected vs observed" reconciliation
 * derived HONESTLY from the real report fields (the success criterion vs the
 * observed value — never invented pairs), plus env/identity badges (--h4 agent
 * jewel) and, on a failure, an honest awaiting-data failure-frame slot (no
 * screenshot/frame stream is wired into the terminal report yet).
 */
function MissionForensics({ card, m }: { card: MissionCard; m: NonNullable<MissionCard["mission"]> }) {
  // Honest derivations — the success criterion vs the observed value. (The bare
  // verdict already has its own section, so it's not repeated here.)
  const rows: Array<{ field: string; expected: string; observed: string; ok: boolean }> = [
    // Observed = whether the success CRITERION held (the raw confidence % has
    // its own section, so the table reports met/below — not the number again).
    { field: "Confidence", expected: "≥ 70%", observed: m.confidence >= 0.7 ? "met" : "below", ok: m.confidence >= 0.7 },
    { field: "Mutation boundary", expected: "stopped before mutation", observed: m.mutationBoundary ? "enforced" : "—", ok: Boolean(m.mutationBoundary) },
  ];
  return (
    <section>
      <div className="hm-section-h">Forensics · expected vs observed</div>
      <div className="h4-eo" role="table" aria-label="Expected vs observed">
        <div className="h4-eo-row h4-eo-head" role="row">
          <span role="columnheader">field</span>
          <span role="columnheader">expected</span>
          <span role="columnheader">observed</span>
          <span role="columnheader" aria-label="match" />
        </div>
        {rows.map((r) => (
          <div className={"h4-eo-row" + (r.ok ? "" : " is-off")} role="row" key={r.field}>
            <span role="cell">{r.field}</span>
            <span className="mono" role="cell">{r.expected}</span>
            <span className="mono" role="cell">{r.observed}</span>
            <span role="cell" aria-hidden>{r.ok ? "✓" : "✕"}</span>
          </div>
        ))}
      </div>
      <div className="h4-env">
        <span className="h4-badge h4-badge--state h4-tone--tel">agent · {card.agentType}</span>
        {m.seed ? <span className="h4-badge h4-badge--state h4-tone--tel">{m.seed}</span> : null}
        {m.target ? <span className="h4-badge h4-badge--state h4-tone--tel">{m.target}</span> : null}
      </div>
      {m.verdictTone === "fail" ? (
        <AwaitingData label="Failure frame" note="no screenshot was captured at the failing step" />
      ) : null}
    </section>
  );
}

function MissionBody({ card }: { card: MissionCard }) {
  // RUNNING → follow the run live (stage + recent output). The SAME body
  // auto-swaps to the end report once the agent posts one: the
  // `board.card.updated` SSE refreshes this card every ~2s and re-renders.
  if (card.missionStatus === "running") {
    return <MissionRunInProgress card={card} />;
  }
  // `mission` is required on the type, but a live mission card has no
  // structured report until the browser agent posts one. Read defensively.
  const m = (card as { mission?: MissionCard["mission"] }).mission;
  if (!m) {
    const finished = card.missionStatus === "completed" || card.missionStatus === "failed";
    return (
      <>
        <VerdictBlock
          head={finished ? "Mission · report unavailable" : "Mission · no report yet"}
          accent="var(--hm-hermes-deep)"
        >
          {card.summary
            || (finished
              ? "Run finished without a structured report — see recent output."
              : "No structured report yet — the browser agent hasn't posted one.")}
        </VerdictBlock>
        <MissionSpecDetails />
      </>
    );
  }
  const verdictColor =
    m.verdictTone === "warn"
      ? "var(--hm-amber-deep)"
      : m.verdictTone === "fail"
        ? "var(--hm-rose)"
        : "var(--hm-sage-deep)";

  // runs / latency / the 0–10 scores are optional: a live agent report may
  // not carry them, and showing "run #0 · " or "0 · 0 · 0" would misrepresent.
  const verdictHead =
    "Verdict" +
    (m.runs !== undefined ? ` · run #${m.runs}` : "") +
    (m.latency ? ` · ${m.latency}` : "");
  // When the report carries a full labeled score list, show that (in its own
  // section) and drop the fixed success/clarity/latency column to avoid showing
  // the same numbers twice.
  const hasGenericScores = (m.scores?.length ?? 0) > 0;
  const hasScores =
    !hasGenericScores &&
    (m.successScore !== undefined || m.clarityScore !== undefined || m.latencyScore !== undefined);
  const fmtScore = (n: number | undefined) => (n === undefined ? "—" : String(n));

  return (
    <>
      {m.goal ? (
        <VerdictBlock head="Scope" accent="var(--hm-hermes-deep)">{m.goal}</VerdictBlock>
      ) : null}
      {m.conclusion ? (
        <VerdictBlock
          head="Conclusion"
          accent={verdictColor}
          tone={m.verdictTone === "fail" ? "fail" : m.verdictTone === "warn" ? "warn" : undefined}
        >
          {m.conclusion}
        </VerdictBlock>
      ) : null}
      <section>
        <div className="hm-section-h">{verdictHead}</div>
        <div className="hm-mission-confidence">
          <div className="col">
            <span className="lbl">Verdict</span>
            <span className="val" style={{ color: verdictColor }}>
              {m.verdict}
            </span>
            <span className="meta">{m.target}</span>
          </div>
          <div className="col">
            <span className="lbl">Confidence</span>
            <span className={"val " + (m.confidence < 0.7 ? "warn" : "")}>
              {Math.round(m.confidence * 100)}
              <span style={{ fontSize: 14, color: "var(--hm-muted)" }}>%</span>
            </span>
            <span className="meta">{m.seed}</span>
          </div>
          {hasScores ? (
            <div className="col">
              <span className="lbl">Scores · success · clarity · latency</span>
              <span className="val">
                {fmtScore(m.successScore)}
                <span style={{ color: "var(--hm-muted)" }}> · </span>
                {fmtScore(m.clarityScore)}
                <span style={{ color: "var(--hm-muted)" }}> · </span>
                {fmtScore(m.latencyScore)}
              </span>
              <span className="meta">out of 10 · by Hermes</span>
            </div>
          ) : null}
        </div>
      </section>

      {hasGenericScores ? (
        <section>
          <div className="hm-section-h">Scores · out of 10</div>
          <div className="hm-checklist">
            {m.scores!.map((score) => (
              <div className="row" key={score.label}>
                <span className="box" style={{ borderColor: "var(--hm-hermes)", color: "transparent" }}>
                  ✓
                </span>
                <span>{score.label}</span>
                <span className="hint">{score.value}/10</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <MissionForensics card={card} m={m} />

      {m.narrative ? (
        <section>
          <div className="hm-section-h">What the agent did</div>
          <div className="hm-mission-narrative">
            {m.narrative
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean)
              .map((line, i) => (
                <p key={i}>{line}</p>
              ))}
          </div>
        </section>
      ) : null}

      {m.path.length > 0 ? (
        <section>
          <div className="hm-section-h">Path taken</div>
          <div className="hm-mpath">
            {m.path.map((step) => (
              <div className={"step " + step.status} key={step.n}>
                <span className="n">{step.n}</span>
                <span className="desc">{step.desc}</span>
                <span className="lat">{step.lat}</span>
                <span
                  className={
                    "hm-pill " +
                    (step.status === "ok" ? "hm-pill--ok" : step.status === "warn" ? "hm-pill--running" : "hm-pill--err")
                  }
                >
                  {step.status === "ok" ? "pass" : step.status === "warn" ? "slow" : "fail"}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {m.blockers.length > 0 ? (
        <section>
          <div className="hm-section-h">Blockers · confusing moments</div>
          <div style={{ display: "grid", gap: 10 }}>
            {m.blockers.map((b, i) => (
              <MissionBlockerBlock blocker={b} key={i} />
            ))}
          </div>
        </section>
      ) : null}

      {m.evidence.length > 0 ? (
        <section>
          <div className="hm-section-h">Evidence</div>
          <div className="hm-evidence">
            {m.evidence.map((e, i) => {
              const hasLink = typeof e.href === "string" && e.href.length > 0 && e.href !== "#";
              return (
                <div className="row" key={i}>
                  <span className="kind">{e.kind}</span>
                  {hasLink ? (
                    <a href={e.href} target="_blank" rel="noreferrer">
                      {e.label}
                    </a>
                  ) : (
                    <span>{e.label}</span>
                  )}
                  {hasLink ? <span style={{ color: "var(--hm-muted)" }}>open ↗</span> : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      <section>
        <div className="hm-section-h">Mutation boundary</div>
        <div
          className="hm-verdict-block"
          style={{ background: "var(--hm-hermes-soft)", borderColor: "rgba(15,107,90,0.18)" }}
        >
          <div className="head" style={{ color: "var(--hm-hermes-deep)" }}>
            BOUNDARY · enforced
          </div>
          <div className="body">{m.mutationBoundary}</div>
        </div>
      </section>

      {m.recommendations.length > 0 ? (
        <section>
          <div className="hm-section-h">Hermes recommends</div>
          <div className="hm-checklist">
            {m.recommendations.map((r, i) => (
              <div className="row" key={i}>
                <span className="box" style={{ borderColor: "var(--hm-hermes)", color: "transparent" }}>
                  ✓
                </span>
                <span>{r}</span>
                <span className="hint">→ codex</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      <MissionSpecDetails />
    </>
  );
}
