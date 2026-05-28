// @vitest-environment jsdom
import { afterEach, beforeAll, afterAll, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary.js";

afterEach(cleanup);

// React logs the caught error to console.error; silence it so the
// expected-failure test doesn't spam the run.
let errSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => errSpy.mockRestore());

function Boom(): never {
  throw new Error("kaboom");
}

describe("ErrorBoundary", () => {
  test("renders children when nothing throws", () => {
    const { getByText } = render(
      <ErrorBoundary>
        <div>all good</div>
      </ErrorBoundary>,
    );
    expect(getByText("all good")).toBeTruthy();
  });

  test("catches a render crash and shows a recoverable alert (not a blank screen)", () => {
    const onReload = vi.fn();
    const { getByRole } = render(
      <ErrorBoundary onReload={onReload}>
        <Boom />
      </ErrorBoundary>,
    );
    const alert = getByRole("alert");
    expect(within(alert).getByText("CRASHED")).toBeTruthy();
    expect(within(alert).getByText(/kaboom/)).toBeTruthy();
    fireEvent.click(within(alert).getByRole("button", { name: "Reload" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
