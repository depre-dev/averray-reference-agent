// Hermes Handoff Monitor — Ask-Hermes composer (M7'/M9').
//
// A single text input that doubles as a command line:
//   /mission <url>        spawn a browser mission (M7')
//   /claude <repo> <task> propose a greenfield Claude task (O2)
//   /mute [1h|9am]        silence action alerts; /unmute clears it (M9')
//   anything else         a question for Hermes
// Enter sends, Shift+Enter inserts a newline. Parsing lives in the pure
// hermes-commands helper; this component owns only input + dispatch.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { parseHermesInput } from "../../lib/monitor/hermes-commands.js";
import type { CreateTaskInput } from "../../lib/monitor/card-types.js";

export interface AskHermesComposerProps {
  /** Spawn a browser mission against a URL (/mission <url>). */
  onSpawnMission?: (url: string) => void;
  /** Propose a greenfield Claude task (/claude <repo> <task>). */
  onSpawnClaudeTask?: (repo: string, prompt: string) => void;
  /** Propose a task (/task <agent> [<repo>#<pr>] <prompt>). */
  onCreateTask?: (input: CreateTaskInput) => void;
  /** Ask Hermes a free-form question, scoped to the focused card or the whole board. */
  onAsk?: (text: string, opts?: { scope: "card" | "board" }) => void;
  /** Prefill the composer with this text (e.g. a suggestion chip). */
  prefill?: string;
  /** Bump to (re)apply `prefill` into the input + focus it. */
  prefillToken?: number;
  /** Mute action alerts until an absolute timestamp (/mute). */
  onMute?: (untilMs: number) => void;
  /** Clear the mute (/unmute). */
  onUnmute?: () => void;
  /** Whether alerts are currently muted (shown as a chip). */
  muted?: boolean;
  /** Engage autopilot until `untilMs` (undefined → server applies the 4h cap). */
  onSetAutopilot?: (untilMs?: number) => void;
  /** Revert to supervised. */
  onSetSupervised?: () => void;
  /** Current autonomy mode (drives the toggle chip). */
  autonomyMode?: "supervised" | "autopilot";
  /** Focused card id, shown in the scope chip. */
  focusedCardId?: string | null;
  /** Bump to programmatically focus the input (the board's `a` shortcut). */
  focusToken?: number;
}

export function AskHermesComposer({
  onSpawnMission,
  onSpawnClaudeTask,
  onCreateTask,
  onAsk,
  onMute,
  onUnmute,
  muted,
  onSetAutopilot,
  onSetSupervised,
  autonomyMode,
  prefill,
  prefillToken,
  focusedCardId,
  focusToken,
}: AskHermesComposerProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Scope a question to the focused card or the whole board. When no card is
  // focused there's nothing to scope to, so it's board-only.
  const [scopeToCard, setScopeToCard] = useState(true);
  const effectiveScope: "card" | "board" = focusedCardId && scopeToCard ? "card" : "board";
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // The board's `a` shortcut bumps focusToken to bring focus here.
  useEffect(() => {
    if (focusToken) inputRef.current?.focus();
  }, [focusToken]);

  // A suggestion chip / prefill bumps prefillToken to drop its text in + focus.
  useEffect(() => {
    if (prefillToken) {
      setValue(prefill ?? "");
      setError(null);
      inputRef.current?.focus();
    }
    // Only re-apply when the token changes (an explicit prefill action).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillToken]);

  const send = () => {
    const command = parseHermesInput(value);
    switch (command.kind) {
      case "empty":
        return;
      case "error":
        setError(command.message);
        return;
      case "mission":
        onSpawnMission?.(command.url);
        setValue("");
        setError(null);
        return;
      case "claude":
        if (onSpawnClaudeTask) {
          onSpawnClaudeTask(command.repo, command.prompt);
          setValue("");
          setError(null);
        } else {
          setError("Proposing Claude tasks isn't wired here.");
        }
        return;
      case "task":
        if (onCreateTask) {
          onCreateTask({
            agent: command.agent,
            repo: command.repo,
            prompt: command.prompt,
            ...(command.pullRequestNumber !== undefined ? { pullRequestNumber: command.pullRequestNumber } : {}),
          });
          setValue("");
          setError(null);
        } else {
          setError("Proposing tasks isn't wired here.");
        }
        return;
      case "mute":
        onMute?.(command.untilMs);
        setValue("");
        setError(null);
        return;
      case "unmute":
        onUnmute?.();
        setValue("");
        setError(null);
        return;
      case "autopilot":
        if (onSetAutopilot) {
          onSetAutopilot(command.untilMs);
          setValue("");
          setError(null);
        } else {
          setError("Autonomy mode isn't wired here.");
        }
        return;
      case "supervised":
        if (onSetSupervised) {
          onSetSupervised();
          setValue("");
          setError(null);
        } else {
          setError("Autonomy mode isn't wired here.");
        }
        return;
      case "ask":
        if (onAsk) {
          onAsk(command.text, { scope: effectiveScope });
          setValue("");
          setError(null);
        } else {
          setError("Ask Hermes isn't wired here. Use /mission <url>, /claude <repo> <task>, or /mute.");
        }
        return;
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="hm-compose">
      <div className="hm-compose-toolbar">
        {/* Honest recipient label: a question posts to the Hermes collaboration
            channel as the operator. Targeting other agents isn't a wired action,
            so this is informational, not a fake toggle. */}
        <span className="hm-compose-chip is-on">to · Hermes</span>
        {/* Scope toggle: actually controls whether a question is scoped to the
            focused card or the whole board on send. Board-only with no card. */}
        {focusedCardId ? (
          <button
            type="button"
            className={"hm-compose-chip" + (scopeToCard ? " is-on" : "")}
            aria-pressed={scopeToCard}
            title={scopeToCard ? "Scoped to this card — click for the whole board" : "Whole board — click to scope to this card"}
            onClick={() => setScopeToCard((s) => !s)}
          >
            scope · {scopeToCard ? focusedCardId : "board"}
          </button>
        ) : (
          <span className="hm-compose-chip">scope · board</span>
        )}
        {onSetAutopilot && onSetSupervised ? (
          <button
            type="button"
            className="hm-compose-chip"
            aria-pressed={autonomyMode === "autopilot"}
            title={autonomyMode === "autopilot"
              ? "Hermes is in autopilot — click to take back control (supervised)"
              : "Supervised — click to put Hermes in charge (autopilot, 4h cap)"}
            onClick={() => (autonomyMode === "autopilot" ? onSetSupervised() : onSetAutopilot(undefined))}
            style={autonomyMode === "autopilot" ? { color: "var(--hm-emerald, #34d399)" } : undefined}
          >
            {autonomyMode === "autopilot" ? "● autopilot" : "○ supervised"}
          </button>
        ) : null}
        {muted ? (
          <span className="hm-compose-chip" style={{ color: "var(--hm-muted)" }}>
            alerts muted
          </span>
        ) : null}
        <span style={{ marginLeft: "auto", color: "var(--hm-muted-soft)" }}>⏎ send · ⇧⏎ newline</span>
      </div>
      <div className="hm-compose-row">
        <textarea
          ref={inputRef}
          className="hm-compose-input"
          placeholder="Ask Hermes · /task <agent> <repo> <prompt> · /mission <url> · /mute 1h"
          aria-label="Ask Hermes, propose a task, spawn a mission, or mute alerts"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onKeyDown}
        />
        <button type="button" className="hm-compose-send" onClick={send}>
          Send <span className="hm-kbd">⏎</span>
        </button>
      </div>
      {error ? (
        <div className="hm-compose-error" role="alert" style={{ color: "var(--hm-rose)", fontSize: 12, marginTop: 6 }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}
