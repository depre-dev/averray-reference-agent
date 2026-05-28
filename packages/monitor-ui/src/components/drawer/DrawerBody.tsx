// Hermes Handoff Monitor — detail-drawer bodies, one per card type.
//
// Each body is driven entirely by real card fields (verdict, files,
// checks, prompt, verification, mergeStatus, …) — no fabricated CI rows
// or operator checklists. The mission body is a stub here; the rich
// browser-mission report lands in M7'.

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
  return (
    <>
      <VerdictBlock head="Mission verdict" accent="var(--hm-hermes-deep)">
        {m.verdict} · confidence {m.confidence} · target {m.target}
      </VerdictBlock>
      <section>
        <div className="hm-section-h">Full mission report</div>
        <div className="hm-files" style={{ padding: "10px 12px", color: "var(--hm-muted)" }}>
          The full browser-mission report — path, blockers, evidence, mutation boundary, recommendations — lands in M7'.
        </div>
      </section>
    </>
  );
}
