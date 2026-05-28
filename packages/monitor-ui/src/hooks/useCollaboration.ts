// Hermes Handoff Monitor — co-pilot collaboration feed (M8').
//
// Polls slack-operator's /monitor/collaboration for the operator ↔ Hermes
// ↔ Codex turn stream, and posts operator questions back. Posting a
// question records it and schedules an async Hermes reply server-side; the
// reply shows up on the next poll, so the rail "answers" without any
// bespoke streaming. Dependency-injected (fetcher, poster) for tests.

import { useCallback } from "react";
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

  const ask = useCallback(
    (text: string, relatedPr?: CollaborationRelatedPr) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      void poster({ text: trimmed, ...(relatedPr ? { relatedPr } : {}) })
        .then(() => mutate())
        .catch(() => {
          /* surfaced via the feed / error state, not thrown */
        });
    },
    [poster, mutate],
  );

  return { messages: data ?? [], ask, isLoading, error };
}
