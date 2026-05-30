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
  /** Ask Hermes a free-form question. */
  onAsk?: (text: string) => void;
  /** Mute action alerts until an absolute timestamp (/mute). */
  onMute?: (untilMs: number) => void;
  /** Clear the mute (/unmute). */
  onUnmute?: () => void;
  /** Whether alerts are currently muted (shown as a chip). */
  muted?: boolean;
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
  focusedCardId,
  focusToken,
}: AskHermesComposerProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // The board's `a` shortcut bumps focusToken to bring focus here.
  useEffect(() => {
    if (focusToken) inputRef.current?.focus();
  }, [focusToken]);

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
      case "ask":
        if (onAsk) {
          onAsk(command.text);
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
        <span className="hm-compose-chip is-on">to · operator</span>
        <span className="hm-compose-chip">scope · {focusedCardId ?? "board"}</span>
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
