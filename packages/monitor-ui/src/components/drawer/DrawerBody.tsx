// Hermes Handoff Monitor — detail-drawer bodies, one per card type.
//
// Each body is driven entirely by real card fields (verdict, files,
// checks, prompt, verification, mergeStatus, mission report, …) — no
// fabricated CI rows or operator checklists.

import type {
  BoardCard,
  CardChecks,
  CardFile,
  DeployCard,
  DoneCard,
  MissionCard,
} from "../../lib/monitor/card-types.js";
import { ChecksBar } from "../cards/ChecksBar.js";

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
  switch (variant) {
    case "mission":
      return <MissionBody card={card as MissionCard} />;
    case "done":
      return <DoneBody card={card as DoneCard} />;
    case "deploy":
      return <DeployBody card={card as DeployCard} />;
    case "task":
      return <TaskBody card={card} />;
    case "draft":
      return <DraftBody card={card} />;
    default:
      return <PrBody card={card} />;
  }
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

function FilesSection({ files }: { files: CardFile[] | undefined }) {
  if (!files || files.length === 0) return null;
  return (
    <section>
      <div className="hm-section-h">Files &amp; risk signals</div>
      <div className="hm-files">
        {files.map((f) => (
          <div className="row" key={f.path}>
            <span className="path">{f.path}</span>
            <span className="diff">{f.diff}</span>
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

function ChecksSection({ checks }: { checks: CardChecks | undefined }) {
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
      <FilesSection files={files} />
      <ChecksSection checks={card.checks} />
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
  const { verification } = card;
  return (
    <>
      <VerdictBlock head="Post-merge verification">{card.summary || "Verifying the deploy."}</VerdictBlock>
      <section>
        <div className="hm-section-h">Verification progress</div>
        <div className="hm-verdict-block">
          <div className="head">
            {verification.current}/{verification.total} · {verification.label}
          </div>
          <div className="body">Deploy {card.deployId}.</div>
        </div>
      </section>
      <ChecksSection checks={card.checks} />
    </>
  );
}

function DoneBody({ card }: { card: DoneCard }) {
  return (
    <VerdictBlock head="Final verdict · release history" accent="var(--hm-sage-deep)">
      {card.mergeStatus === "MERGED" ? "MERGED" : "CLOSED"} · closed at <b>{card.closedAt}</b>.
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

function MissionBody({ card }: { card: MissionCard }) {
  const m = card.mission;
  const verdictColor =
    m.verdictTone === "warn"
      ? "var(--hm-amber-deep)"
      : m.verdictTone === "fail"
        ? "var(--hm-rose)"
        : "var(--hm-sage-deep)";

  return (
    <>
      <section>
        <div className="hm-section-h">
          Verdict · run #{m.runs} · {m.latency}
        </div>
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
          <div className="col">
            <span className="lbl">Scores · success · clarity · latency</span>
            <span className="val">
              {m.successScore}
              <span style={{ color: "var(--hm-muted)" }}> · </span>
              {m.clarityScore}
              <span style={{ color: "var(--hm-muted)" }}> · </span>
              {m.latencyScore}
            </span>
            <span className="meta">out of 10 · by Hermes</span>
          </div>
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
    </>
  );
}
