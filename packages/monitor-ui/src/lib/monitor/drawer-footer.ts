// Hermes Handoff Monitor — drawer footer actions (truth-boundary).
//
// The DetailDrawer footer rendered active buttons that silently no-op'd. This
// turns each into either a REAL action (existing endpoints / client-side
// clipboard+GitHub) or a button DISABLED with a tooltip reason — never a live
// control that does nothing.
//
// Pure + dependency-injected (openUrl / copy / backend handlers) so every button
// is unit-tested without a DOM or network. The board never merges/deploys: the
// merge button only OPENS GitHub (the human merges there) and optionally records
// operator approval.

import type { BoardCard } from "./card-types.js";
import { relatedPrForCard } from "./collaboration.js";
import { drawerVariant } from "../../components/drawer/DrawerBody.js";

export type FooterButtonKind = "primary" | "action" | "ghost";

export interface FooterButton {
  key: string;
  label: string;
  kind: FooterButtonKind;
  /** Present ⇒ the button is enabled and this is its action. */
  run?: () => void;
  /** Present ⇒ the button is disabled and this is the tooltip reason. */
  disabledReason?: string;
}

export interface DrawerActionHandlers {
  /** Re-run a mission via POST /monitor/testbed-missions (fresh = no memory). */
  onRerunMission?: (card: BoardCard, freshness: "fresh" | "memory") => void;
  /** Propose a product-fix task with the report appended (operator approves). */
  onCreateProductFix?: (card: BoardCard) => void;
  /** Record operator approval on the board (the merge itself stays on GitHub). */
  onApproveAndMerge?: (card: BoardCard) => void;
  /** Return the item to the codex-needed/dispatch path. */
  onSendBackToCodex?: (card: BoardCard) => void;
  /** Triage a stuck/failed card off the board (server-persisted dismiss). */
  onDismiss?: (card: BoardCard) => void;
  /** Focus the co-pilot composer scoped to this card. */
  onAskHermes?: (card: BoardCard) => void;
}

export interface DrawerFooterDeps {
  handlers?: DrawerActionHandlers;
  /** Open a URL (default: window.open new tab). Injected for tests. */
  openUrl?: (url: string) => void;
  /** Copy text to the clipboard. Injected for tests. */
  copy?: (text: string) => void;
}

/** The PR-specific GitHub URL for a card (number parsed from the id), or undefined. */
export function pullRequestUrlForCard(card: BoardCard): string | undefined {
  const pr = relatedPrForCard(card);
  return pr ? `https://github.com/${pr.repo}/pull/${pr.number}` : undefined;
}

/** The GitHub URL for a card: the PR when it resolves, else the repo. */
export function githubUrlForCard(card: BoardCard): string | undefined {
  return pullRequestUrlForCard(card) ?? (card.repo ? `https://github.com/${card.repo}` : undefined);
}

/** A human-readable mission report for clipboard / fix-task evidence. */
export function missionReportText(card: BoardCard): string | undefined {
  if (card.type !== "mission" || !card.mission) return undefined;
  const m = card.mission;
  const lines = [
    `Mission report — ${card.title}`,
    `Target: ${m.target}`,
    `Verdict: ${m.verdict} (confidence ${Math.round((m.confidence ?? 0) * 100)}%)`,
    ...(m.blockers.length ? ["", "Blockers:", ...m.blockers.map((b) => `- ${b.head}: ${b.body}`)] : []),
    ...(m.recommendations.length ? ["", "Recommendations:", ...m.recommendations.map((r) => `- ${r}`)] : []),
  ];
  return lines.join("\n");
}

/**
 * Build the variant-specific footer buttons. Each is either enabled (`run`) or
 * disabled with a `disabledReason`. Lazily references deps so tests can assert
 * exactly which side-effect a click triggers.
 */
export function buildDrawerFooter(card: BoardCard, deps: DrawerFooterDeps = {}): FooterButton[] {
  const h = deps.handlers ?? {};
  const openUrl = deps.openUrl ?? ((url: string) => { if (typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer"); });
  const copy = deps.copy ?? ((text: string) => { void navigator?.clipboard?.writeText?.(text); });
  const variant = drawerVariant(card);
  const url = githubUrlForCard(card);
  const buttons: FooterButton[] = [];

  // A PROPOSED task hasn't dispatched yet — there is no PR to merge, so the
  // resolving action is to APPROVE + DISPATCH it to the runner (the O3 operator
  // gate). This makes the gate reachable from the drawer on ANY surface, incl.
  // Ops, where the lane cards that normally carry Approve are hidden.
  // onApproveAndMerge is wired to the task-approve dispatch in BoardView.
  const taskStatus = (card as { taskStatus?: string }).taskStatus;
  if (card.type === "task" && taskStatus === "proposed") {
    buttons.push({
      key: "approve-dispatch",
      label: "Approve & dispatch",
      kind: "action",
      ...(h.onApproveAndMerge
        ? { run: () => h.onApproveAndMerge!(card) }
        : { disabledReason: "Approving a task isn't available here." }),
    });
    buttons.push({
      key: "dismiss-task",
      label: "Dismiss",
      kind: "ghost",
      ...(h.onDismiss
        ? { run: () => h.onDismiss!(card) }
        : { disabledReason: "Dismissing isn't available here." }),
    });
    buttons.push({
      key: "ask-hermes",
      label: "Ask Hermes",
      kind: "ghost",
      ...(h.onAskHermes ? { run: () => h.onAskHermes!(card) } : { disabledReason: "Ask Hermes isn't available here." }),
    });
    return buttons;
  }

  if (variant === "mission") {
    buttons.push({
      key: "fresh-run",
      label: "Fresh run",
      kind: "primary",
      ...(h.onRerunMission
        ? { run: () => h.onRerunMission!(card, "fresh") }
        : { disabledReason: "Re-running a mission isn't available here." }),
    });
    buttons.push({
      key: "memory-run",
      label: "Memory run",
      kind: "ghost",
      ...(h.onRerunMission
        ? { run: () => h.onRerunMission!(card, "memory") }
        : { disabledReason: "Re-running a mission isn't available here." }),
    });
    const report = missionReportText(card);
    buttons.push({
      key: "copy-report",
      label: "Copy report",
      kind: "ghost",
      ...(report ? { run: () => copy(report) } : { disabledReason: "No mission report to copy yet." }),
    });
    buttons.push({
      key: "create-product-fix",
      label: "Create product fix → Claude",
      kind: "action",
      ...(h.onCreateProductFix
        ? { run: () => h.onCreateProductFix!(card) }
        : { disabledReason: "Proposing a fix task isn't available here." }),
    });
  } else if (variant === "action") {
    // The operator's one resolving primary depends on what's actually possible:
    //   - a card with a real PR → "Approve & merge" (opens GitHub; the board
    //     NEVER merges — the human merges there, we just record approval);
    //   - a card with NO PR (e.g. a failed task that can't be merged) → never
    //     show a dead "Approve & merge"; lead with "Dismiss" to triage it off
    //     the board, which is the honest resolving action.
    const prUrl = pullRequestUrlForCard(card);
    const hasPr = Boolean(relatedPrForCard(card));
    if (prUrl) {
      buttons.push({
        key: "approve-merge",
        label: "Approve & merge",
        kind: "action",
        run: () => { openUrl(prUrl); h.onApproveAndMerge?.(card); },
      });
    } else {
      buttons.push({
        key: "dismiss",
        label: "Dismiss",
        kind: "action",
        ...(h.onDismiss
          ? { run: () => h.onDismiss!(card) }
          : { disabledReason: "Dismissing isn't available here." }),
      });
    }
    buttons.push({
      key: "send-back-codex",
      label: "Send back to Codex",
      kind: "ghost",
      // Codex iterates an existing PR, so send-back needs a linked PR number.
      ...(h.onSendBackToCodex && hasPr
        ? { run: () => h.onSendBackToCodex!(card) }
        : { disabledReason: hasPr ? "Sending back to Codex isn't available here." : "No linked PR to send back to Codex." }),
    });
  } else if (variant === "done") {
    buttons.push({
      key: "view-github",
      label: "View on github",
      kind: "ghost",
      ...(url ? { run: () => openUrl(url) } : { disabledReason: "No GitHub link for this card." }),
    });
    buttons.push({
      key: "copy-receipt",
      label: "Copy receipt id",
      kind: "ghost",
      run: () => copy(card.id),
    });
  } else if (variant !== "harness") {
    // Open the SPECIFIC PR — never the repo-root fallback. A task with no
    // resolved PR has nothing to open yet; silently linking to the repo root
    // sends the operator to the wrong target, so disable with an honest reason.
    const prUrl = pullRequestUrlForCard(card);
    buttons.push({
      key: "open-github",
      label: "Open on github",
      kind: "primary",
      ...(prUrl
        ? { run: () => openUrl(prUrl) }
        : { disabledReason: "No PR yet — opens once the task proposes a change." }),
    });
  }

  buttons.push({
    key: "ask-hermes",
    label: "Ask Hermes",
    kind: "ghost",
    ...(h.onAskHermes
      ? { run: () => h.onAskHermes!(card) }
      : { disabledReason: "Ask Hermes isn't available here." }),
  });

  return buttons;
}
