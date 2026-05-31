export type BacklogSuggestionOwner = "codex" | "claude" | "operator" | "hermes";
export type BacklogSuggestionRiskTier = "low" | "high";

export interface BacklogSuggestionRelated {
  cardId: string;
  repo?: string;
  pullRequestNumber?: number;
  correlationId?: string;
  missionTarget?: string;
  missionVerdict?: string;
}

export interface BacklogSuggestion {
  id: string;
  title: string;
  reason: string;
  suggestedOwner: BacklogSuggestionOwner;
  riskTier: BacklogSuggestionRiskTier;
  related: BacklogSuggestionRelated;
  suggestedPrompt?: string;
  confidence: number;
  evidence: string[];
}

export interface BacklogSuggestionsResponse {
  generatedAt: string;
  suggestions: BacklogSuggestion[];
  safety: {
    readOnly: true;
    createsTasks: false;
    approvesTasks: false;
    mutatesGithub: false;
    mutatesSlack: false;
    mutatesTaskQueue: false;
  };
  source: {
    cardsRead: number;
    source: "monitor_v2_board";
  };
}
