import useSWR from "swr";
import type { BacklogSuggestionsResponse } from "../lib/monitor/backlog-suggestions.js";

const DEFAULT_BACKLOG_SUGGESTIONS_URL = "/monitor/backlog-suggestions";

export interface UseBacklogSuggestionsOptions {
  url?: string;
  fetcher?: (url: string) => Promise<BacklogSuggestionsResponse>;
  enabled?: boolean;
}

export interface BacklogSuggestionsState {
  data: BacklogSuggestionsResponse | undefined;
  error: unknown;
  isLoading: boolean;
}

async function defaultFetcher(url: string): Promise<BacklogSuggestionsResponse> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`backlog suggestions fetch failed: ${res.status}`);
  return (await res.json()) as BacklogSuggestionsResponse;
}

export function useBacklogSuggestions(options: UseBacklogSuggestionsOptions = {}): BacklogSuggestionsState {
  const url = options.url ?? DEFAULT_BACKLOG_SUGGESTIONS_URL;
  const fetcher = options.fetcher ?? defaultFetcher;
  const { data, error, isLoading } = useSWR<BacklogSuggestionsResponse>(
    options.enabled === false ? null : url,
    fetcher,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
    },
  );
  return { data, error, isLoading };
}
