// Hermes Handoff Monitor — create-task form (O3 board dispatch)
//
// The codex-needed lane's create affordance: pick an agent, a repo, and a
// prompt, and propose a task from the board. It only PROPOSES — the task
// lands `proposed` and the operator still approves it (on the card) before
// any runner claims it. The board feed, not this form, drives the result.

import { useState } from "react";
import type { CreateTaskInput } from "../lib/monitor/card-types.js";

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

export function CreateTaskForm({ onCreate }: { onCreate?: (input: CreateTaskInput) => void }) {
  const [agent, setAgent] = useState<"codex" | "claude">("claude");
  const [repo, setRepo] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!onCreate) return null;

  const submit = () => {
    const r = repo.trim();
    const p = prompt.trim();
    if (!REPO_RE.test(r)) {
      setError("Enter a valid owner/repo.");
      return;
    }
    if (!p) {
      setError("Enter a task prompt.");
      return;
    }
    onCreate({ agent, repo: r, prompt: p });
    setRepo("");
    setPrompt("");
    setError(null);
  };

  return (
    <form
      className="hm-task-form"
      aria-label="Propose a task"
      style={{ display: "grid", gap: 6, marginBottom: 10 }}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div style={{ display: "flex", gap: 6 }}>
        <select
          aria-label="Agent"
          value={agent}
          onChange={(e) => setAgent(e.target.value === "codex" ? "codex" : "claude")}
          style={{ fontSize: 12 }}
        >
          <option value="claude">claude</option>
          <option value="codex">codex</option>
        </select>
        <input
          aria-label="Repository (owner/repo)"
          placeholder="owner/repo"
          value={repo}
          onChange={(e) => {
            setRepo(e.target.value);
            if (error) setError(null);
          }}
          style={{ flex: 1, fontSize: 12 }}
        />
      </div>
      <textarea
        aria-label="Task prompt"
        placeholder="Describe the task…"
        value={prompt}
        rows={2}
        onChange={(e) => {
          setPrompt(e.target.value);
          if (error) setError(null);
        }}
        style={{ fontSize: 12, resize: "vertical" }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button type="submit" className="hm-btn hm-btn--action hm-btn--sm">
          Propose task
        </button>
        {error ? (
          <span role="alert" style={{ color: "var(--hm-rose)", fontSize: 12 }}>
            {error}
          </span>
        ) : (
          <span style={{ fontSize: 11, color: "var(--hm-muted-soft)" }}>
            Lands proposed — you approve before any runner claims it.
          </span>
        )}
      </div>
    </form>
  );
}
