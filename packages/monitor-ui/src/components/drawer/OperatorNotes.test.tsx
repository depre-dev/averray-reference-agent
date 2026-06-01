// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { OperatorNotes } from "./OperatorNotes.js";
import type { OperatorCardNotesValue } from "../../hooks/useOperatorNotes.js";

afterEach(cleanup);

const saved: OperatorCardNotesValue = {
  checklist: [
    { id: "read-diff", label: "Read the diff / report", done: false },
    { id: "ci-green", label: "CI is green", done: true },
  ],
  note: "watch the rollback path",
};

describe("OperatorNotes — checklist + private note (G4)", () => {
  test("loads + renders the persisted checklist and note", async () => {
    const fetchNotes = vi.fn(async () => saved);
    const { container } = render(
      <OperatorNotes cardId="agent #548" options={{ fetchNotes, saveNotes: vi.fn(async () => saved) }} />,
    );
    await waitFor(() => expect(within(container).getByText("Read the diff / report")).toBeTruthy());
    expect(fetchNotes).toHaveBeenCalledWith("agent #548");
    const note = container.querySelector(".hm-operator-note") as HTMLTextAreaElement;
    expect(note.value).toBe("watch the rollback path");
    // It announces the privacy boundary.
    expect(within(container).getByText(/never shared with agents/i)).toBeTruthy();
  });

  test("toggling a checklist item persists via saveNotes", async () => {
    const fetchNotes = vi.fn(async () => saved);
    const saveNotes = vi.fn(async (_id: string, v: OperatorCardNotesValue) => v);
    const { container } = render(
      <OperatorNotes cardId="agent #548" options={{ fetchNotes, saveNotes }} />,
    );
    await waitFor(() => expect(within(container).getByLabelText("Read the diff / report")).toBeTruthy());
    fireEvent.click(within(container).getByLabelText("Read the diff / report"));
    await waitFor(() => expect(saveNotes).toHaveBeenCalled());
    const [, value] = saveNotes.mock.calls[0]!;
    expect(value.checklist.find((i) => i.id === "read-diff")?.done).toBe(true);
  });

  test("editing the note + Save persists the new text", async () => {
    const fetchNotes = vi.fn(async () => saved);
    const saveNotes = vi.fn(async (_id: string, v: OperatorCardNotesValue) => v);
    const { container, getByRole } = render(
      <OperatorNotes cardId="agent #548" options={{ fetchNotes, saveNotes }} />,
    );
    await waitFor(() => expect(container.querySelector(".hm-operator-note")).toBeTruthy());
    const note = container.querySelector(".hm-operator-note") as HTMLTextAreaElement;
    fireEvent.change(note, { target: { value: "new private note" } });
    fireEvent.click(getByRole("button", { name: /Save note/ }));
    await waitFor(() => expect(saveNotes).toHaveBeenCalled());
    const lastCall = saveNotes.mock.calls.at(-1)!;
    expect(lastCall[1].note).toBe("new private note");
  });
});
