// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { UtilCard } from "./UtilCard.js";

afterEach(cleanup);

describe("UtilCard", () => {
  test("exposes the title as the section's accessible region name", () => {
    const { getByRole } = render(
      <UtilCard title="LLM usage">
        <p>body</p>
      </UtilCard>,
    );
    expect(getByRole("region", { name: "LLM usage" })).toBeTruthy();
  });

  test("renders the hint and action slot in the header", () => {
    const { getByText } = render(
      <UtilCard title="Saved suites" hint="library" action={<button type="button">+ New suite</button>}>
        <p>body</p>
      </UtilCard>,
    );
    expect(getByText("library")).toBeTruthy();
    expect(getByText("+ New suite")).toBeTruthy();
  });

  test("ariaLabel overrides the title for the region name", () => {
    const { getByRole } = render(
      <UtilCard title="Start a mission" ariaLabel="Mission launcher">
        <p>body</p>
      </UtilCard>,
    );
    expect(getByRole("region", { name: "Mission launcher" })).toBeTruthy();
  });
});
