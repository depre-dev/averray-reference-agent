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
  MissionCard,
} from "../../lib/monitor/card-types.js";
import { humanizeSignalText } from "../../lib/monitor/signal-labels.js";
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

/** Pick the drawer variant. isAction wins, then closed, draft, and type. */
export function drawerVariant(card: BoardCard): DrawerVariant {
  if (card.type === "mission") return "mission";
  if (card.isAction) return "action";
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

function VerdictBlock({ head, children, accent }: { head: string; children: React.ReactNode; accent?: string }) {
  return (
    <section>
      <div className="hm-section-h" style={accent ? { color: accent } : undefined}>
        {head}
      </div>
      <div className="hm-verdict-block">
        <div className="body">{children}</div>
      </div>
    </section>
  );
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
        <VerdictBlock head="Status">{card.summary || "No additional context yet."}</VerdictBlock>
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

function TaskBody({ card }: { card: BoardCard }) {
  const prompt = "prompt" in card ? card.prompt : undefined;
  const heartbeat = "runnerHeartbeat" in card ? card.runnerHeartbeat : undefined;
  return (
    <>
      <VerdictBlock head="Proposed Codex task">{card.summary || "Awaiting operator approval to dispatch."}</VerdictBlock>
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

function DeployBody({ card }: { card: DeployCard }) {
  // `verification`/`deployId` are required on the UI type, but the live
  // backend doesn't always populate them (deploy verification is not wired
  // yet). They cross an HTTP/JSON boundary, so read defensively — a
  // verification-less deploy card must render, not crash the drawer.
  const verification = (card as { verification?: DeployCard["verification"] }).verification;
  const deployId = (card as { deployId?: string }).deployId;
  return (
    <>
      <VerdictBlock head="Post-merge verification">{card.summary || "Verifying the deploy."}</VerdictBlock>
      {verification ? (
        <section>
          <div className="hm-section-h">Verification progress</div>
          <div className="hm-verdict-block">
            <div className="head">
              {verification.current}/{verification.total} · {verification.label}
            </div>
            {deployId ? <div className="body">Deploy {deployId}.</div> : null}
          </div>
        </section>
      ) : null}
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

function MissionBody({ card }: { card: MissionCard }) {
  // `mission` is required on the type, but a live mission card has no
  // structured report until the browser agent posts one. Read defensively.
  const m = (card as { mission?: MissionCard["mission"] }).mission;
  if (!m) {
    return (
      <>
        <VerdictBlock head="Mission · no report yet" accent="var(--hm-hermes-deep)">
          {card.summary || "No structured report yet — the browser agent hasn't posted one."}
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
  const hasScores =
    m.successScore !== undefined || m.clarityScore !== undefined || m.latencyScore !== undefined;
  const fmtScore = (n: number | undefined) => (n === undefined ? "—" : String(n));

  return (
    <>
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
              <div className="hm-mblock" key={i}>
                <div className="head">{b.head}</div>
                <div className="body">{b.body}</div>
              </div>
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
