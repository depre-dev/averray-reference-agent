// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { CreateTaskForm } from "./CreateTaskForm.js";

afterEach(cleanup);

function fields(container: HTMLElement) {
  return {
    agent: within(container).getByLabelText("Agent") as HTMLSelectElement,
    repo: within(container).getByLabelText("Repository (owner/repo)") as HTMLInputElement,
    prompt: within(container).getByLabelText("Task prompt") as HTMLTextAreaElement,
    submit: within(container).getByRole("button", { name: /Propose task/ }),
  };
}

describe("CreateTaskForm (O3 board dispatch)", () => {
  test("renders nothing when no handler is wired", () => {
    const { container } = render(<CreateTaskForm />);
    expect(container.querySelector("form")).toBeNull();
  });

  test("a valid submission posts { agent, repo, prompt } and clears the inputs", () => {
    const onCreate = vi.fn();
    const { container } = render(<CreateTaskForm onCreate={onCreate} />);
    const f = fields(container);
    fireEvent.change(f.agent, { target: { value: "claude" } });
    fireEvent.change(f.repo, { target: { value: "averray-agent/agent" } });
    fireEvent.change(f.prompt, { target: { value: "Add a HEALTHCHECK.md" } });
    fireEvent.click(f.submit);
    expect(onCreate).toHaveBeenCalledWith({
      agent: "claude",
      repo: "averray-agent/agent",
      prompt: "Add a HEALTHCHECK.md",
    });
    expect(f.repo.value).toBe("");
    expect(f.prompt.value).toBe("");
  });

  test("can propose a codex task via the agent select", () => {
    const onCreate = vi.fn();
    const { container } = render(<CreateTaskForm onCreate={onCreate} />);
    const f = fields(container);
    fireEvent.change(f.agent, { target: { value: "codex" } });
    fireEvent.change(f.repo, { target: { value: "a/b" } });
    fireEvent.change(f.prompt, { target: { value: "x" } });
    fireEvent.click(f.submit);
    expect(onCreate).toHaveBeenCalledWith({ agent: "codex", repo: "a/b", prompt: "x" });
  });

  test("can propose a test-writer specialist task via the agent select", () => {
    const onCreate = vi.fn();
    const { container } = render(<CreateTaskForm onCreate={onCreate} />);
    const f = fields(container);
    fireEvent.change(f.agent, { target: { value: "test-writer" } });
    fireEvent.change(f.repo, { target: { value: "a/b" } });
    fireEvent.change(f.prompt, { target: { value: "add tests" } });
    fireEvent.click(f.submit);
    expect(onCreate).toHaveBeenCalledWith({ agent: "test-writer", repo: "a/b", prompt: "add tests" });
  });

  test("a malformed repo blocks submit with an error", () => {
    const onCreate = vi.fn();
    const { container } = render(<CreateTaskForm onCreate={onCreate} />);
    const f = fields(container);
    fireEvent.change(f.repo, { target: { value: "not-a-repo" } });
    fireEvent.change(f.prompt, { target: { value: "x" } });
    fireEvent.click(f.submit);
    expect(onCreate).not.toHaveBeenCalled();
    expect(within(container).getByRole("alert").textContent).toMatch(/valid owner\/repo/i);
  });

  test("an empty prompt blocks submit with an error", () => {
    const onCreate = vi.fn();
    const { container } = render(<CreateTaskForm onCreate={onCreate} />);
    const f = fields(container);
    fireEvent.change(f.repo, { target: { value: "a/b" } });
    fireEvent.click(f.submit);
    expect(onCreate).not.toHaveBeenCalled();
    expect(within(container).getByRole("alert").textContent).toMatch(/prompt/i);
  });
});
