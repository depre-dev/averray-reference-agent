import type { GithubAuthorsSurface } from "../../lib/monitor/product-health.js";
import { shortLabel } from "../../lib/monitor/ops-model.js";

const reported = (value: number | null | undefined): string => (typeof value === "number" ? String(value) : "not reported");

function ageLabel(ageMs: number): string {
  const seconds = Math.max(0, Math.round(ageMs / 1000));
  return seconds < 90 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
}

function unavailableReason(reason: GithubAuthorsSurface["unavailable"]): string {
  if (reason === "unauthorised") return "unauthorised";
  if (reason === "timeout") return "timeout";
  if (reason === "unreachable") return "unreachable";
  return "missing block";
}

/** Served author warning and admin block. Counts are not recomputed here. */
export function GithubAuthorsPanel({ surface }: { surface: GithubAuthorsSurface | undefined }) {
  if (!surface || (!surface.warning && !surface.block && !surface.unavailable)) return null;
  const warning = surface.warning;
  const block = surface.block;
  return (
    <section className="ops-github-authors" data-testid="ops-github-authors" aria-label="GitHub author visibility">
      <header className="ops-panel-head">
        <h2 className="ops-panel-title">GITHUB AUTHORS</h2>
        <span className="ops-panel-note">GitHub accounts bound to a claim, not verified people</span>
      </header>
      {surface.unavailable && !block ? (
        <p data-testid="ops-github-authors-missing" data-tone="degraded">
          authors not reported — {unavailableReason(surface.unavailable)}
        </p>
      ) : null}
      {warning ? (
        <p data-testid="ops-github-author-warning" data-tone="degraded">
          {warning.message ?? warning.code}
          {warning.openClaims != null ? ` · ${warning.openClaims} open` : ""}
          {warning.totalOpenClaims != null ? ` of ${warning.totalOpenClaims}` : ""}
          {warning.distinctWallets != null ? ` · ${warning.distinctWallets} wallets` : ""}
        </p>
      ) : null}
      {block ? (
        <>
          {surface.stale ? (
            <p data-testid="ops-github-authors-stale" data-tone="degraded">
              last block {ageLabel(surface.ageMs ?? 0)}
              {surface.unavailable ? ` · ${unavailableReason(surface.unavailable)}` : ""}
            </p>
          ) : null}
          <p data-testid="ops-github-author-totals">
            {reported(block.distinctAuthors)} authors · {reported(block.distinctWallets)} wallets · {reported(block.unattributedClaims)} open claims without author evidence
          </p>
          <div className="ops-authors-scroll">
          <table>
            <thead>
              <tr>
                <th>Author</th>
                <th>Open</th>
                <th>Submitted</th>
                <th>Human review</th>
                <th>Settled 7d / 30d</th>
                <th>USDC paid</th>
              </tr>
            </thead>
            <tbody>
              {block.authors.map((row) => (
                <tr key={row.author} data-testid={`ops-github-author-${row.author}`}>
                  <th title={row.author}>{shortLabel(row.author)}</th>
                  <td>{reported(row.openClaims)}</td>
                  <td>{reported(row.submitted)}</td>
                  <td>{reported(row.awaitingHumanReview)}</td>
                  <td>{reported(row.settled7d)} / {reported(row.settled30d)}</td>
                  <td>{row.usdcPaid ?? row.missingPayoutEvidence ?? "not reported"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      ) : null}
    </section>
  );
}
