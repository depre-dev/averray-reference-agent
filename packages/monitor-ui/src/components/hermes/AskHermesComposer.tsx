// Hermes Handoff Monitor — Ask-Hermes composer (M7').
//
// A single text input that doubles as a command line. `/mission <url>`
// spawns a browser mission; anything else is a question for Hermes.
// Enter sends, Shift+Enter inserts a newline. Parsing lives in the pure
// hermes-commands helper; this component owns only input + dispatch.
//
// In M7' the mission-spawn path is wired end-to-end; the free-form "ask
// Hermes" reply stream is M8'. When no onAsk handler is supplied, a plain
// message surfaces a short hint rather than silently doing nothing.

import { useState, type KeyboardEvent } from "react";
import { parseHermesInput } from "../../lib/monitor/hermes-commands.js";

export interface AskHermesComposerProps {
  /** Spawn a browser mission against a URL (/mission <url>). */
  onSpawnMission?: (url: string) => void;
  /** Ask Hermes a free-form question (M8'). */
  onAsk?: (text: string) => void;
  /** Focused card id, shown in the scope chip. */
  focusedCardId?: string | null;
}

export function AskHermesComposer({ onSpawnMission, onAsk, focusedCardId }: AskHermesComposerProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

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
      case "ask":
        if (onAsk) {
          onAsk(command.text);
          setValue("");
          setError(null);
        } else {
          setError("Ask Hermes lands in M8'. For now: /mission <url> spawns a browser mission.");
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
        <span className="hm-compose-chip">intent · mission spawn</span>
        <span className="hm-compose-chip">scope · {focusedCardId ?? "board"}</span>
        <span style={{ marginLeft: "auto", color: "var(--hm-muted-soft)" }}>⏎ send · ⇧⏎ newline</span>
      </div>
      <div className="hm-compose-row">
        <textarea
          className="hm-compose-input"
          placeholder="Ask Hermes, or spawn a mission · /mission https://staging.averray.com/onboarding"
          aria-label="Ask Hermes or spawn a browser mission"
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
