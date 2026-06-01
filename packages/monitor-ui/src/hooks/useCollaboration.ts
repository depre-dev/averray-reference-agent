// Hermes Handoff Monitor — co-pilot collaboration feed (M8').
//
// Polls slack-operator's /monitor/collaboration for the operator ↔ Hermes
// ↔ Codex turn stream, and posts operator questions back. Posting a
// question records it and schedules an async Hermes reply server-side; the
// reply shows up on the next poll, so the rail "answers" without any
// bespoke streaming. Dependency-injected (fetcher, poster) for tests.

import { useCallback, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import type { CollaborationMessage, CollaborationRelatedPr } from "../lib/monitor/collaboration.js";

const DEFAULT_URL = "/monitor/collaboration";
const DEFAULT_REFRESH_MS = 4000;

export interface AskInput {
  text: string;
  relatedPr?: CollaborationRelatedPr;
}

export interface UseCollaborationOptions {
  /** When false the hook neither fetches nor polls (rail stays inert). Default true. */
  enabled?: boolean;
  url?: string;
  fetcher?: (url: string) => Promise<CollaborationMessage[]>;
  poster?: (input: AskInput) => Promise<void>;
  refreshIntervalMs?: number;
  limit?: number;
}

export interface CollaborationState {
  messages: CollaborationMessage[];
  /** Ask Hermes; optionally scoped to a PR. Records + triggers a revalidate. */
  ask: (text: string, relatedPr?: CollaborationRelatedPr) => void;
  isLoading: boolean;
  error: unknown;
  /** Whether the rail is wired to a live collaboration channel at all. */
  enabled: boolean;
  /** True from the moment a question is posted until Hermes's reply lands
   *  (or the post fails) — drives the "Hermes thinking…" indicator. */
  pending: boolean;
  /** Set when the POST itself failed; surfaced inline so the operator
   *  knows the question did not reach Hermes (no silent drop). */
  sendError: string | null;
  /** Clear a prior send error (e.g. when the operator edits the input). */
  clearSendError: () => void;
}

async function defaultFetcher(url: string): Promise<CollaborationMessage[]> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`collaboration fetch failed: ${res.status}`);
  const body = (await res.json()) as { messages?: CollaborationMessage[] };
  return Array.isArray(body.messages) ? body.messages : [];
}

function makeDefaultPoster(url: string): (input: AskInput) => Promise<void> {
  return async (input) => {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        author: "operator",
        kind: "chat",
        addressedTo: "hermes",
        text: input.text,
        ...(input.relatedPr ? { relatedPr: input.relatedPr } : {}),
      }),
    });
  };
}

export function useCollaboration(opts: UseCollaborationOptions = {}): CollaborationState {
  const enabled = opts.enabled ?? true;
  const url = opts.url ?? DEFAULT_URL;
  const fetcher = opts.fetcher ?? defaultFetcher;
  const poster = opts.poster ?? makeDefaultPoster(url);
  const refreshInterval = opts.refreshIntervalMs ?? DEFAULT_REFRESH_MS;

  // A null key disables SWR entirely — no fetch, no poll.
  const key = enabled ? (opts.limit ? `${url}?limit=${opts.limit}` : url) : null;

  const { data, error, isLoading, mutate } = useSWR<CollaborationMessage[]>(key, fetcher, {
    refreshInterval,
    revalidateOnFocus: false,
  });

  // Optimistic operator messages: rendered immediately so an Ask-Hermes
  // action never sits silent for a poll interval. Each is reconciled away
  // once the same text shows up in the fetched feed (server is the source
  // of truth); on POST failure it's dropped and `sendError` is set.
  const [optimistic, setOptimistic] = useState<CollaborationMessage[]>([]);
  const [pending, setPending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const seq = useRef(0);

  const serverMessages = data ?? [];

  // Drop any optimistic message the server feed has now echoed back, so we
  // don't render the operator's question twice.
  const pendingOptimistic = optimistic.filter(
    (o) => !serverMessages.some((m) => m.author === "operator" && m.text === o.text),
  );
  const messages = useMemo(
    () => [...serverMessages, ...pendingOptimistic],
    [serverMessages, pendingOptimistic],
  );

  const clearSendError = useCallback(() => setSendError(null), []);

  const ask = useCallback(
    (text: string, relatedPr?: CollaborationRelatedPr) => {
      const trimmed = text.trim();
      if (!trimmed || !enabled) return;
      seq.current += 1;
      const optimisticId = `optimistic-${seq.current}`;
      const optimisticMessage: CollaborationMessage = {
        id: optimisticId,
        ts: Date.now(), // "now" so the feed (sorted ascending by ts) renders it newest/last
        author: "operator",
        kind: "chat",
        text: trimmed,
        addressedTo: "hermes",
        ...(relatedPr ? { relatedPr } : {}),
      };
      setOptimistic((prev) => [...prev, optimisticMessage]);
      setSendError(null);
      setPending(true);
      void poster({ text: trimmed, ...(relatedPr ? { relatedPr } : {}) })
        .then(() => mutate())
        .catch(() => {
          // Do NOT swallow: roll back the optimistic message and surface
          // the failure inline so the operator knows it didn't send.
          setOptimistic((prev) => prev.filter((m) => m.id !== optimisticId));
          setSendError("Couldn't reach Hermes — your question wasn't sent. Try again.");
        })
        .finally(() => setPending(false));
    },
    [enabled, poster, mutate],
  );

  return {
    messages,
    ask,
    isLoading,
    error,
    enabled,
    pending,
    sendError,
    clearSendError,
  };
}
