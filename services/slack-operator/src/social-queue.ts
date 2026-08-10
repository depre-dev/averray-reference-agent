// The social draft queue, read for the morning digest.
//
// The sweep in the `agent` repo opens one issue per fired signal, labelled
// `social-draft`. This reads the open ones so a signal that fired overnight
// arrives in Buzz rather than sitting in a workflow artifact nobody opens.
//
// ## What this is and is not
//
// It is a **to-do list**, not a health probe. Nothing here says anything about
// whether the product is working, and it must never be able to make the digest
// look alarmed. See the closing-line rule in morning-digest.ts.
//
// It is also **not** the approval mechanism. Closing the issue is the decision,
// taken by a human, in GitHub. Nothing in this file writes.
//
// ## Truth boundary
//
// The same rule as every other reader here: **"nothing queued" and "we could
// not ask" must never render the same.** The first means there is nothing to
// write today; the second means the queue is invisible and a signal may be
// waiting unseen. An unreachable GitHub is reported as unreadable, never as an
// empty queue.

import { resolveGithubTokenForRepo } from "./github-pr-state.js";

const GITHUB_API = "https://api.github.com";
export const QUEUE_LABEL = "social-draft";
export const DEFAULT_QUEUE_REPO = "averray-agent/agent";
const MAX_SHOWN = 5;

export interface QueuedDraft {
  number: number;
  title: string;
  url: string;
}

export interface SocialQueue {
  /** "live" — a real reading. "unreadable" — we could not ask. "off" — not configured. */
  state: "live" | "unreadable" | "off";
  drafts: QueuedDraft[];
  /** Present when state is not "live"; why the queue could not be read. */
  problem?: string;
}

/**
 * Open `social-draft` issues, oldest first.
 *
 * Oldest first because the queue is a backlog: the thing that has been waiting
 * longest is the thing most likely to go stale.
 */
export async function readSocialQueue({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
}: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
} = {}): Promise<SocialQueue> {
  const repo = (env.SOCIAL_QUEUE_REPO ?? DEFAULT_QUEUE_REPO).trim();
  if (!repo || env.SOCIAL_QUEUE_ENABLED === "0") {
    return { state: "off", drafts: [], problem: "social queue not enabled" };
  }

  const token = resolveGithubTokenForRepo(repo, env);
  if (!token) {
    // Not configured is not the same as empty, and it is not the same as
    // broken. Say which.
    return { state: "off", drafts: [], problem: `no GitHub token resolves for ${repo}` };
  }

  const url = `${GITHUB_API}/repos/${repo}/issues?labels=${QUEUE_LABEL}&state=open&sort=created&direction=asc&per_page=20`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return { state: "unreadable", drafts: [], problem: `HTTP ${response.status}` };
    }

    const body = await response.json();
    if (!Array.isArray(body)) {
      return { state: "unreadable", drafts: [], problem: "response was not a list" };
    }

    const drafts = body
      // Pull requests come back on this endpoint too and are never queue items.
      .filter((issue: { pull_request?: unknown }) => !issue.pull_request)
      .map((issue: { number: number; title?: string; html_url?: string }) => ({
        number: issue.number,
        title: String(issue.title ?? "").trim(),
        url: String(issue.html_url ?? ""),
      }));

    return { state: "live", drafts };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { state: "unreadable", drafts: [], problem: reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The digest line, or `null` when there is genuinely nothing to say.
 *
 * A live-but-empty queue produces NO line: on most mornings there is nothing
 * waiting, and printing "0 drafts waiting" every day trains the reader to skip
 * the section that will one day matter.
 *
 * An unreadable queue always produces a line, because silence would be
 * indistinguishable from an empty one.
 */
export function buildSocialQueueLine(queue: SocialQueue): { text: string; tone: string } | null {
  if (queue.state === "off") return null;

  if (queue.state === "unreadable") {
    return {
      text: `draft queue unreadable (${queue.problem ?? "unknown"}) — a post may be waiting unseen`,
      tone: "degraded",
    };
  }

  if (queue.drafts.length === 0) return null;

  const shown = queue.drafts.slice(0, MAX_SHOWN);
  const listed = shown.map((draft) => `#${draft.number} ${draft.title}`).join("; ");
  const more = queue.drafts.length - shown.length;

  return {
    text:
      queue.drafts.length === 1
        ? `1 draft waiting — ${listed}`
        : `${queue.drafts.length} drafts waiting — ${listed}${more > 0 ? `; +${more} more` : ""}`,
    tone: "ok",
  };
}
