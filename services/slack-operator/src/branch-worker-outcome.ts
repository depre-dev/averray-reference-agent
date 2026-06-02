export type BranchWorkerOutcome =
  | {
      opened: true;
      pullRequestUrl?: string;
      pullRequestNumber?: number;
      summary?: string;
    }
  | {
      opened: false;
      reason: string;
      summary?: string;
    };

export const BRANCH_WORKER_OUTCOME_PREFIX = "AVERRAY_BRANCH_WORKER_OUTCOME ";

export function formatBranchWorkerOutcome(outcome: BranchWorkerOutcome): string {
  return `${BRANCH_WORKER_OUTCOME_PREFIX}${JSON.stringify(outcome)}`;
}

export function parseBranchWorkerOutcome(value: string): BranchWorkerOutcome | undefined {
  const line = value
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.startsWith(BRANCH_WORKER_OUTCOME_PREFIX));
  if (!line) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(BRANCH_WORKER_OUTCOME_PREFIX.length));
  } catch {
    return undefined;
  }
  return isBranchWorkerOutcome(parsed) ? parsed : undefined;
}

function isBranchWorkerOutcome(value: unknown): value is BranchWorkerOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.opened === true) {
    return optionalString(record.pullRequestUrl)
      && optionalNumber(record.pullRequestNumber)
      && optionalString(record.summary);
  }
  if (record.opened === false) {
    return typeof record.reason === "string"
      && record.reason.trim().length > 0
      && optionalString(record.summary);
  }
  return false;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === "number";
}
