// GitHub author visibility, rendered as served.
//
// `github_author_concentration` is a warning the backend already computed.
// `githubAuthors` is the admin status block the backend already computed.
// This module copies those fields onto the board. It does not count authors,
// open claims, or payouts, and it does not decide the concentration rule.

export interface GithubAuthorWarning {
  code: "github_author_concentration";
  severity: string | null;
  message: string | null;
  openClaims: number | null;
  totalOpenClaims: number | null;
  distinctWallets: number | null;
}

export interface GithubAuthorRow {
  author: string;
  openClaims: number | null;
  submitted: number | null;
  awaitingHumanReview: number | null;
  settled7d: number | null;
  settled30d: number | null;
  distinctWallets: number | null;
  usdcPaid: string | null;
}

export interface GithubAuthorsBlock {
  distinctAuthors: number | null;
  distinctWallets: number | null;
  unattributedClaims: number | null;
  unattributedSessions: number | null;
  authors: GithubAuthorRow[];
}

export interface GithubAuthorsSurface {
  /** The served warning, or null when this payload did not include it. */
  warning: GithubAuthorWarning | null;
  /** The admin block, or null when this payload did not include it. */
  block: GithubAuthorsBlock | null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function concentrationWarning(
  warnings: readonly unknown[] | null | undefined,
): GithubAuthorWarning | null {
  for (const item of warnings ?? []) {
    const warning = record(item);
    if (!warning || warning.code !== "github_author_concentration") continue;
    return {
      code: "github_author_concentration",
      severity: typeof warning.severity === "string" ? warning.severity : null,
      message: typeof warning.message === "string" ? warning.message : null,
      openClaims: num(warning.openClaims),
      totalOpenClaims: num(warning.totalOpenClaims),
      distinctWallets: num(warning.distinctWallets),
    };
  }
  return null;
}

export function githubAuthorsBlock(value: unknown): GithubAuthorsBlock | null {
  const root = record(value);
  if (!root) return null;
  const authors = Array.isArray(root.authors) ? root.authors : [];
  return {
    distinctAuthors: num(root.distinctAuthors),
    distinctWallets: num(root.distinctWallets),
    unattributedClaims: num(root.unattributedClaims),
    unattributedSessions: num(root.unattributedSessions),
    authors: authors.flatMap((item) => {
      const row = record(item);
      if (!row || typeof row.author !== "string" || !row.author) return [];
      const paid = record(row.usdcPaid);
      const amount = typeof paid?.amount === "string" || typeof paid?.amount === "number" ? String(paid.amount) : null;
      return [{
        author: row.author,
        openClaims: num(row.openClaims),
        submitted: num(row.submitted),
        awaitingHumanReview: num(row.awaitingHumanReview),
        settled7d: num(row.settled7d),
        settled30d: num(row.settled30d),
        distinctWallets: num(row.distinctWallets),
        usdcPaid: amount,
      }];
    }),
  };
}

/** Copy the warning and the admin block. Neither count is derived here. */
export function githubAuthorSurface(input: {
  warnings?: readonly unknown[] | null;
  adminStatus?: unknown;
}): GithubAuthorsSurface {
  const admin = record(input.adminStatus);
  const blockSource = admin && "githubAuthors" in admin ? admin.githubAuthors : input.adminStatus;
  const block = githubAuthorsBlock(blockSource);
  const fromHealth = concentrationWarning(input.warnings);
  const fromAdmin = concentrationWarning(record(blockSource)?.warnings as unknown[] | undefined);
  return { warning: fromHealth ?? fromAdmin, block };
}

export async function readAdminGithubAuthors(input: {
  baseUrl?: string;
  getSession: () => Promise<{ token: string }>;
  fetchImpl: typeof fetch;
}): Promise<GithubAuthorsSurface> {
  const base = (input.baseUrl ?? "https://api.averray.com").replace(/\/+$/, "");
  try {
    const session = await input.getSession();
    const response = await input.fetchImpl(`${base}/admin/status`, {
      headers: { accept: "application/json", authorization: `Bearer ${session.token}` },
    });
    if (!response.ok) {
      return { warning: null, block: null };
    }
    return githubAuthorSurface({ adminStatus: await response.json() });
  } catch {
    return { warning: null, block: null };
  }
}
