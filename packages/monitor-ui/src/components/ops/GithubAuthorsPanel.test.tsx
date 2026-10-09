// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import type { GithubAuthorsSurface } from "../../lib/monitor/product-health.js";
import { GithubAuthorsPanel } from "./GithubAuthorsPanel.js";

afterEach(cleanup);

const missing: GithubAuthorsSurface = {
  warning: null,
  unavailable: "missing",
  block: {
    distinctAuthors: null,
    distinctWallets: null,
    unattributedClaims: null,
    unattributedSessions: null,
    authors: [{
      author: "worker",
      openClaims: null,
      submitted: null,
      awaitingHumanReview: null,
      settled7d: null,
      settled30d: null,
      distinctWallets: null,
      usdcPaid: null,
      missingPayoutEvidence: "no payout evidence",
    }],
  },
};

describe("GithubAuthorsPanel", () => {
  test("missing data is not reported, never 0, and names the payout gap", () => {
    const view = render(<GithubAuthorsPanel surface={missing} />);
    const text = view.getByTestId("ops-github-authors").textContent ?? "";
    expect(text).toContain("not reported");
    expect(text).toContain("GitHub accounts bound to a claim, not verified people");
    expect(view.getByTestId("ops-github-author-worker").textContent).toContain("no payout evidence");
    expect(view.getByTestId("ops-github-author-worker").textContent).not.toContain("0");
    expect(view.getByTestId("ops-github-author-totals").textContent).not.toContain("0 authors");
  });

  test("unauthorised with no block says authors not reported", () => {
    const view = render(<GithubAuthorsPanel surface={{ warning: null, block: null, unavailable: "unauthorised" }} />);
    const note = view.getByTestId("ops-github-authors-missing");
    expect(note.textContent).toBe("authors not reported — unauthorised");
    expect(note.getAttribute("data-tone")).toBe("degraded");
  });

  test("a real zero still renders as zero", () => {
    const view = render(
      <GithubAuthorsPanel
        surface={{
          ...missing,
          unavailable: null,
          block: {
            ...missing.block!,
            distinctAuthors: 0,
            authors: [{ ...missing.block!.authors[0]!, openClaims: 0, usdcPaid: "0", missingPayoutEvidence: null }],
          },
        }}
      />,
    );
    expect(view.getByTestId("ops-github-author-totals").textContent).toContain("0 authors");
    expect(view.getByTestId("ops-github-author-worker").textContent).toContain("0");
  });
});
