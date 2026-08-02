// The runtime half of the inbound seam: hold the state the pure decision needs,
// and turn an "answer" verdict into exactly one published reply.
//
// Everything stateful about listening lives here so `buzz-inbound.ts` can stay
// a function of its arguments — the seen-id set, the rolling rate window, and
// the promise chain that keeps two questions from being answered at once.
//
// ── WHY TURNS ARE SERIALIZED ────────────────────────────────────────────────
//
// An agent turn costs money and takes tens of seconds. Two arriving together
// would run concurrently, interleave their replies in the channel, and double
// the spend for a question the operator asked once and rephrased. A queue of
// one, with the rest dropped and logged, keeps the cost bounded and the thread
// readable. Dropping is honest here because the dropped message is nearly
// always the same question typed again.
//
// ── WHY A FAILED TURN STILL SPEAKS ──────────────────────────────────────────
//
// If the agent cannot answer, the channel says so. The alternative is silence,
// which is indistinguishable from the listener being down — and this is the
// channel whose entire purpose is to be trustworthy when other things are not.
// The failure line is careful to be a statement about US, never about the
// system: "I could not answer" must not read as "everything is fine".

import {
  decideInboundMessage,
  describeInboundFailure,
  formatReplyForBuzz,
  type InboundContext,
  type InboundDecision,
  type InboundEvent,
} from "./buzz-inbound.js";

export interface ResponderDeps {
  /** Ask the agent. Returns its answer, or null if the turn produced nothing. */
  ask: (question: string) => Promise<string | null>;
  /** Publish a reply to the channel. */
  publish: (text: string) => Promise<{ ok: boolean; detail: string }>;
  nowMs?: () => number;
  log?: (line: string) => void;
}

export interface ResponderConfig {
  agentPubkey: string;
  channelId: string;
  startedAtSeconds: number;
  maxRepliesPerWindow: number;
  rateWindowMs: number;
  requireMention: boolean;
  mentionNames: readonly string[];
  enabled: boolean;
}

/**
 * Bounded so a long-running process cannot grow this without limit. The set
 * only has to outlive a relay's redelivery window, which is seconds.
 */
export const MAX_SEEN_IDS = 500;

export interface ResponderStats {
  answered: number;
  failed: number;
  ignored: number;
  dropped: number;
  /** Verdict of the most recent decision, for the board and for debugging. */
  lastVerdict: InboundDecision["verdict"] | null;
  busy: boolean;
}

export class BuzzResponder {
  private readonly seenIds = new Set<string>();
  private readonly seenOrder: string[] = [];
  /** Timestamps of published replies, newest last. Rolling window. */
  private readonly replyTimes: number[] = [];
  private queued = 0;
  private chain: Promise<void> = Promise.resolve();
  private stats: ResponderStats = {
    answered: 0, failed: 0, ignored: 0, dropped: 0, lastVerdict: null, busy: false,
  };

  constructor(
    private readonly config: ResponderConfig,
    private readonly deps: ResponderDeps,
  ) {}

  snapshot(): ResponderStats {
    return { ...this.stats };
  }

  private now(): number {
    return this.deps.nowMs?.() ?? Date.now();
  }

  private log(line: string): void {
    this.deps.log?.(line);
  }

  /** Drop reply timestamps that have aged out of the window. */
  private repliesInWindow(): number {
    const cutoff = this.now() - this.config.rateWindowMs;
    while (this.replyTimes.length > 0 && this.replyTimes[0]! < cutoff) this.replyTimes.shift();
    return this.replyTimes.length;
  }

  private remember(id: string): void {
    if (this.seenIds.has(id)) return;
    this.seenIds.add(id);
    this.seenOrder.push(id);
    while (this.seenOrder.length > MAX_SEEN_IDS) {
      const evicted = this.seenOrder.shift();
      if (evicted !== undefined) this.seenIds.delete(evicted);
    }
  }

  private context(): InboundContext {
    return {
      agentPubkey: this.config.agentPubkey,
      channelId: this.config.channelId,
      startedAtSeconds: this.config.startedAtSeconds,
      seenEventIds: this.seenIds,
      repliesInWindow: this.repliesInWindow(),
      maxRepliesPerWindow: this.config.maxRepliesPerWindow,
      requireMention: this.config.requireMention,
      mentionNames: this.config.mentionNames,
      enabled: this.config.enabled,
    };
  }

  /**
   * Handle one inbound event. Never throws and never blocks the socket.
   *
   * The event id is recorded BEFORE the turn runs, not after. A turn takes
   * tens of seconds, and a relay redelivery arriving mid-turn would otherwise
   * pass the seen check and start a second identical answer.
   */
  handle(event: InboundEvent): void {
    const decision = decideInboundMessage(event, this.context());
    this.stats.lastVerdict = decision.verdict;

    if (decision.verdict !== "answer") {
      this.stats.ignored += 1;
      // Self-messages are the overwhelming majority in a channel we also post
      // to; logging each one would bury everything else.
      if (decision.verdict !== "ignore-self" && decision.verdict !== "ignore-disabled") {
        this.log(`buzz inbound: ${decision.verdict} — ${decision.detail}`);
      }
      return;
    }

    if (this.queued > 0) {
      this.stats.dropped += 1;
      this.log(`buzz inbound: dropped a question while one was already running`);
      return;
    }

    this.remember(event.id);
    this.queued += 1;
    this.stats.busy = true;
    const question = decision.question!;

    this.chain = this.chain
      .then(() => this.runTurn(question))
      .catch(() => {
        // runTurn already converts failures into a published line; this is the
        // last resort so the chain itself can never break.
      })
      .finally(() => {
        this.queued -= 1;
        this.stats.busy = this.queued > 0;
      });
  }

  private async runTurn(question: string): Promise<void> {
    let answer: string | null = null;
    let failure: string | null = null;

    try {
      answer = await this.deps.ask(question);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }

    const text = formatReplyForBuzz(answer);
    // A turn that returns nothing is a failure with a specific cause, not an
    // empty answer. Naming it keeps "the agent is unreachable" distinct from
    // "the agent had nothing to say", which are different problems.
    const line = text ?? describeInboundFailure(failure ?? "the agent returned an empty answer");

    const result = await this.deps.publish(line);
    if (result.ok) {
      this.replyTimes.push(this.now());
      if (text) this.stats.answered += 1;
      else this.stats.failed += 1;
      return;
    }

    // The reply could not be delivered. Nothing more to try — publishing a
    // second message about a failed publish would fail the same way.
    this.stats.failed += 1;
    this.log(`buzz inbound: reply not delivered — ${result.detail}`);
  }
}
