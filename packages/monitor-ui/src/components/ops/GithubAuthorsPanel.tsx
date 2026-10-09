import type { GithubAuthorsSurface } from "../../lib/monitor/product-health.js";

const dash = (value: number | null | undefined): string => (typeof value === "number" ? String(value) : "—");

/** Served author warning and admin block. Counts are not recomputed here. */
export function GithubAuthorsPanel({ surface }: { surface: GithubAuthorsSurface | undefined }) {
  if (!surface || (!surface.warning && !surface.block)) return null;
  const warning = surface.warning;
  const block = surface.block;
  return (
    <section className="ops-github-authors" data-testid="ops-github-authors" aria-label="GitHub author visibility">
      <header className="ops-panel-head">
        <h2 className="ops-panel-title">GITHUB AUTHORS</h2>
        <span className="ops-panel-note">served by the backend · not recomputed</span>
      </header>
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
          <p data-testid="ops-github-author-totals">
            {dash(block.distinctAuthors)} authors · {dash(block.distinctWallets)} wallets · {dash(block.unattributedClaims)} open claims without author evidence
          </p>
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
                  <th>{row.author}</th>
                  <td>{dash(row.openClaims)}</td>
                  <td>{dash(row.submitted)}</td>
                  <td>{dash(row.awaitingHumanReview)}</td>
                  <td>{dash(row.settled7d)} / {dash(row.settled30d)}</td>
                  <td>{row.usdcPaid ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </section>
  );
}
