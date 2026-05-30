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
    expect(onSpawnMission).toHaveBeenCalledWith("https://staging.averray.com/onboarding");
    expect(input.value).toBe("");
  });

  test("Enter sends; Shift+Enter does not", () => {
    const onSpawnMission = vi.fn();
    const { container } = render(<AskHermesComposer onSpawnMission={onSpawnMission} />);
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;

    type(input, "/mission https://x.test/a");
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSpawnMission).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
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
    expect(onAsk).toHaveBeenCalledWith("what's blocking #548?");
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
