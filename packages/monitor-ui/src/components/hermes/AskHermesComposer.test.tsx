// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { AskHermesComposer } from "./AskHermesComposer.js";

afterEach(cleanup);

function type(el: HTMLElement, value: string) {
  fireEvent.change(el, { target: { value } });
}

describe("AskHermesComposer", () => {
  test("/mission <url> spawns a mission and clears the input", () => {
    const onSpawnMission = vi.fn();
    const { container, getByRole } = render(<AskHermesComposer onSpawnMission={onSpawnMission} />);
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    type(input, "/mission https://staging.averray.com/onboarding");
    fireEvent.click(getByRole("button", { name: /Send/ }));
    // PR-D3: a mutating command stages a Confirm gate before it fires.
    fireEvent.click(getByRole("button", { name: "Confirm" }));
    expect(onSpawnMission).toHaveBeenCalledWith("https://staging.averray.com/onboarding");
    expect(input.value).toBe("");
  });

  test("Enter sends; Shift+Enter does not", () => {
    const onSpawnMission = vi.fn();
    const { container, getByRole } = render(<AskHermesComposer onSpawnMission={onSpawnMission} />);
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;

    type(input, "/mission https://x.test/a");
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSpawnMission).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    // Enter stages the command; the operator confirms it before it fires.
    fireEvent.click(getByRole("button", { name: "Confirm" }));
    expect(onSpawnMission).toHaveBeenCalledWith("https://x.test/a");
  });

  test("/mission with no URL shows an error and does not spawn", () => {
    const onSpawnMission = vi.fn();
    const { container, getByRole } = render(<AskHermesComposer onSpawnMission={onSpawnMission} />);
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    type(input, "/mission");
    fireEvent.click(getByRole("button", { name: /Send/ }));
    expect(onSpawnMission).not.toHaveBeenCalled();
    expect(within(container).getByRole("alert").textContent).toMatch(/needs a target URL/);
    // The bad input is preserved so the operator can fix it.
    expect(input.value).toBe("/mission");
  });

  test("/claude <repo> <task> proposes a Claude task and clears the input", () => {
    const onSpawnClaudeTask = vi.fn();
    const { container, getByRole } = render(<AskHermesComposer onSpawnClaudeTask={onSpawnClaudeTask} />);
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    type(input, "/claude averray-agent/agent Add a HEALTHCHECK.md");
    fireEvent.click(getByRole("button", { name: /Send/ }));
    fireEvent.click(getByRole("button", { name: "Confirm" }));
    expect(onSpawnClaudeTask).toHaveBeenCalledWith("averray-agent/agent", "Add a HEALTHCHECK.md");
    expect(input.value).toBe("");
  });

  test("/claude with a malformed repo shows an error and does not propose", () => {
    const onSpawnClaudeTask = vi.fn();
    const { container, getByRole } = render(<AskHermesComposer onSpawnClaudeTask={onSpawnClaudeTask} />);
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    type(input, "/claude not-a-repo do the thing");
    fireEvent.click(getByRole("button", { name: /Send/ }));
    expect(onSpawnClaudeTask).not.toHaveBeenCalled();
    expect(within(container).getByRole("alert").textContent).toMatch(/not a valid owner\/repo/);
    expect(input.value).toBe("/claude not-a-repo do the thing");
  });

  test("/claude without an onSpawnClaudeTask handler surfaces a hint", () => {
    const { container, getByRole } = render(<AskHermesComposer onSpawnMission={vi.fn()} />);
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    type(input, "/claude averray-agent/agent do x");
    fireEvent.click(getByRole("button", { name: /Send/ }));
    expect(within(container).getByRole("alert").textContent).toMatch(/isn't wired here/);
  });

  test("a plain question calls onAsk when a handler is provided", () => {
    const onAsk = vi.fn();
    const { container, getByRole } = render(<AskHermesComposer onAsk={onAsk} />);
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    type(input, "what's blocking #548?");
    fireEvent.click(getByRole("button", { name: /Send/ }));
    // No focused card → the question is board-scoped.
    expect(onAsk).toHaveBeenCalledWith("what's blocking #548?", { scope: "board", target: "everyone" });
    expect(input.value).toBe("");
  });

  test("a plain question without an onAsk handler surfaces a hint", () => {
    const { container, getByRole } = render(<AskHermesComposer onSpawnMission={vi.fn()} />);
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    type(input, "hello hermes");
    fireEvent.click(getByRole("button", { name: /Send/ }));
    expect(within(container).getByRole("alert").textContent).toMatch(/isn't wired here/);
  });

  test("the scope chip reflects the focused card", () => {
    const { getByText } = render(<AskHermesComposer focusedCardId="agent #548" />);
    expect(getByText("scope · agent #548")).toBeTruthy();
  });

  test("/mute and /unmute dispatch to their handlers", () => {
    const onMute = vi.fn();
    const onUnmute = vi.fn();
    const { container } = render(<AskHermesComposer onMute={onMute} onUnmute={onUnmute} />);
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;

    type(input, "/mute 1h");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onMute).toHaveBeenCalledTimes(1);
    expect(typeof onMute.mock.calls[0]?.[0]).toBe("number");
    expect(input.value).toBe("");

    type(input, "/unmute");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onUnmute).toHaveBeenCalledTimes(1);
  });

  test("a muted state shows the muted chip", () => {
    const { getByText } = render(<AskHermesComposer muted />);
    expect(getByText("alerts muted")).toBeTruthy();
  });

  test("/task <agent> <repo> <prompt> dispatches onCreateTask and clears the input", () => {
    const onCreateTask = vi.fn();
    const { container, getByRole } = render(<AskHermesComposer onCreateTask={onCreateTask} />);
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    type(input, "/task claude averray-agent/agent Add a HEALTHCHECK.md");
    fireEvent.click(getByRole("button", { name: /Send/ }));
    fireEvent.click(getByRole("button", { name: "Confirm" }));
    expect(onCreateTask).toHaveBeenCalledWith({
      agent: "claude",
      repo: "averray-agent/agent",
      prompt: "Add a HEALTHCHECK.md",
    });
    expect(input.value).toBe("");
  });

  test("/task codex <repo>#<pr> forwards the pullRequestNumber", () => {
    const onCreateTask = vi.fn();
    const { container, getByRole } = render(<AskHermesComposer onCreateTask={onCreateTask} />);
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    type(input, "/task codex averray-agent/agent#42 tighten it");
    fireEvent.click(getByRole("button", { name: /Send/ }));
    fireEvent.click(getByRole("button", { name: "Confirm" }));
    expect(onCreateTask).toHaveBeenCalledWith({
      agent: "codex",
      repo: "averray-agent/agent",
      prompt: "tighten it",
      pullRequestNumber: 42,
    });
  });

  test("/task with an invalid agent shows an error and does not dispatch", () => {
    const onCreateTask = vi.fn();
    const { container, getByRole } = render(<AskHermesComposer onCreateTask={onCreateTask} />);
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    type(input, "/task gpt5 a/b do x");
    fireEvent.click(getByRole("button", { name: /Send/ }));
    expect(onCreateTask).not.toHaveBeenCalled();
    expect(within(container).getByRole("alert").textContent).toMatch(/not a valid agent/i);
  });
});

describe("AskHermesComposer — PR-D3 command-preview gate", () => {
  test("a mutating command stages a Confirm gate and does not fire on Send", () => {
    const onSpawnMission = vi.fn();
    const { container, getByRole, getByText } = render(<AskHermesComposer onSpawnMission={onSpawnMission} />);
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    type(input, "/mission https://x.test/a");
    fireEvent.click(getByRole("button", { name: /Send/ }));
    // staged, not fired
    expect(onSpawnMission).not.toHaveBeenCalled();
    expect(container.querySelector(".hm-compose-preview")).toBeTruthy();
    expect(getByText("Spawn browser mission")).toBeTruthy();
    expect(container.querySelector(".hm-compose-preview-detail")?.textContent).toMatch(/x\.test\/a/);
  });

  test("Cancel aborts the staged command and clears the input — nothing fires", () => {
    const onSpawnMission = vi.fn();
    const { container, getByRole } = render(<AskHermesComposer onSpawnMission={onSpawnMission} />);
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    type(input, "/mission https://x.test/a");
    fireEvent.click(getByRole("button", { name: /Send/ }));
    fireEvent.click(getByRole("button", { name: "Cancel" }));
    expect(onSpawnMission).not.toHaveBeenCalled();
    expect(container.querySelector(".hm-compose-preview")).toBeNull();
    expect(input.value).toBe("");
  });

  test("Edit dismisses the gate but keeps the typed command for fixing", () => {
    const onSpawnMission = vi.fn();
    const { container, getByRole } = render(<AskHermesComposer onSpawnMission={onSpawnMission} />);
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    type(input, "/mission https://x.test/a");
    fireEvent.click(getByRole("button", { name: /Send/ }));
    fireEvent.click(getByRole("button", { name: "Edit" }));
    expect(onSpawnMission).not.toHaveBeenCalled();
    expect(container.querySelector(".hm-compose-preview")).toBeNull();
    expect(input.value).toBe("/mission https://x.test/a");
  });

  test("autopilot is treated as mutating — it stages a confirm gate", () => {
    const onSetAutopilot = vi.fn();
    const onSetSupervised = vi.fn();
    const { container, getByRole, getByText } = render(
      <AskHermesComposer onSetAutopilot={onSetAutopilot} onSetSupervised={onSetSupervised} />
    );
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    type(input, "/autopilot");
    fireEvent.click(getByRole("button", { name: /Send/ }));
    expect(onSetAutopilot).not.toHaveBeenCalled();
    expect(getByText("Engage autopilot")).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Confirm" }));
    expect(onSetAutopilot).toHaveBeenCalledTimes(1);
  });

  test("benign commands (a question) never stage a gate — they fire directly", () => {
    const onAsk = vi.fn();
    const { container, getByRole } = render(<AskHermesComposer onAsk={onAsk} />);
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    type(input, "what is blocking the release?");
    fireEvent.click(getByRole("button", { name: /Send/ }));
    expect(container.querySelector(".hm-compose-preview")).toBeNull();
    expect(onAsk).toHaveBeenCalledTimes(1);
  });

  test("an unwired mutating command shows its honest hint, not a gate", () => {
    const { container, getByRole } = render(<AskHermesComposer onSpawnMission={vi.fn()} />);
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    type(input, "/claude averray-agent/agent do x");
    fireEvent.click(getByRole("button", { name: /Send/ }));
    expect(container.querySelector(".hm-compose-preview")).toBeNull();
    expect(within(container).getByRole("alert").textContent).toMatch(/isn't wired here/);
  });
});

describe("AskHermesComposer — G3 compose chips + prefill", () => {
  test("scope chip toggles the scope passed to onAsk", () => {
    const onAsk = vi.fn();
    const { container, getByRole, getByText } = render(
      <AskHermesComposer onAsk={onAsk} focusedCardId="agent #548" />,
    );
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    // Default: scoped to the focused card.
    type(input, "why did this fail?");
    fireEvent.click(getByRole("button", { name: /Send/ }));
    expect(onAsk).toHaveBeenLastCalledWith("why did this fail?", { scope: "card", target: "everyone" });
    // Toggle the scope chip → whole board.
    fireEvent.click(getByText(/^scope ·/).closest("button") as HTMLElement);
    type(input, "board status?");
    fireEvent.click(getByRole("button", { name: /Send/ }));
    expect(onAsk).toHaveBeenLastCalledWith("board status?", { scope: "board", target: "everyone" });
  });

  test("the target selector sends a question to a chosen agent", () => {
    const onAsk = vi.fn();
    const { container, getByLabelText, getByRole } = render(<AskHermesComposer onAsk={onAsk} />);
    const target = getByLabelText("Message target") as HTMLSelectElement;
    fireEvent.change(target, { target: { value: "codex" } });
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    type(input, "can you inspect the failing card?");
    fireEvent.click(getByRole("button", { name: /Send/ }));
    expect(onAsk).toHaveBeenCalledWith("can you inspect the failing card?", { scope: "board", target: "codex" });
  });

  test("prefill drops suggestion text into the composer when the token bumps", () => {
    const { container, rerender } = render(
      <AskHermesComposer onAsk={vi.fn()} prefill="" prefillToken={0} />,
    );
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    expect(input.value).toBe("");
    rerender(<AskHermesComposer onAsk={vi.fn()} prefill="Investigate the flaky test" prefillToken={1} />);
    expect(input.value).toBe("Investigate the flaky test");
  });
});

describe("AskHermesComposer — P0-4 feedback + honest disabled state", () => {
  test("disables the input + send and never drops text when collaboration is off", () => {
    const onAsk = vi.fn();
    const { container, getByRole, getByText } = render(
      <AskHermesComposer onAsk={onAsk} collaborationEnabled={false} />,
    );
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect((getByRole("button", { name: /Send/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(getByText(/Ask Hermes unavailable/)).toBeTruthy();
    // Even if a keyDown sneaks through, send() is a guarded no-op — no silent drop.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAsk).not.toHaveBeenCalled();
  });

  test("shows a 'Hermes thinking…' indicator while a question is pending", () => {
    const { getByText, queryByText, rerender } = render(
      <AskHermesComposer onAsk={vi.fn()} pending={false} />,
    );
    expect(queryByText(/Hermes thinking/)).toBeNull();
    rerender(<AskHermesComposer onAsk={vi.fn()} pending />);
    expect(getByText(/Hermes thinking/)).toBeTruthy();
  });

  test("shows an inline error when the POST failed (sendError)", () => {
    const { getByRole } = render(
      <AskHermesComposer onAsk={vi.fn()} sendError="Couldn't reach Hermes — your question wasn't sent. Try again." />,
    );
    expect(getByRole("alert").textContent).toMatch(/wasn't sent/);
  });

  test("a local parse error takes precedence over a stale sendError", () => {
    const { container, getByRole } = render(
      <AskHermesComposer onSpawnMission={vi.fn()} sendError="old send failure" />,
    );
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    type(input, "/mission"); // invalid → local parse error
    fireEvent.click(getByRole("button", { name: /Send/ }));
    expect(getByRole("alert").textContent).toMatch(/needs a target URL/);
  });
});
