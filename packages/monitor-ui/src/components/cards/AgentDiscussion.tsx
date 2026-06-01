import type { CardDiscussionMessage } from "../../lib/monitor/card-types.js";
import { actorLabel, formatTurnTime } from "../../lib/monitor/collaboration.js";

export function AgentDiscussion({
  messages,
  compact = false,
}: {
  messages?: readonly CardDiscussionMessage[];
  compact?: boolean;
}) {
  if (!messages || messages.length === 0) return null;
  const visible = compact ? messages.slice(-2) : messages;
  const hidden = messages.length - visible.length;

  return (
    <section className={`hm-agent-discussion${compact ? " hm-agent-discussion--compact" : ""}`} aria-label="Agent discussion">
      <div className="hm-agent-discussion-head">
        <span className="hm-agent-discussion-dot" aria-hidden />
        <span>Agent discussion</span>
      </div>
      <div className="hm-agent-discussion-list">
        {visible.map((message) => (
          <article className={`hm-agent-discussion-row hm-agent-discussion-row--${message.author}`} key={message.id}>
            <div className="hm-agent-discussion-meta">
              <strong>{discussionActorLabel(message)}</strong>
              <span>{formatTurnTime(message.ts)}</span>
            </div>
            <p>{message.text}</p>
          </article>
        ))}
      </div>
      {hidden > 0 ? <div className="hm-agent-discussion-more">+{hidden} more in drawer</div> : null}
    </section>
  );
}

function discussionActorLabel(message: CardDiscussionMessage): string {
  if (message.author === "hermes" && message.hermesMode === "live") return "Hermes (live)";
  if (message.author === "hermes" && message.hermesMode === "templated") return "Hermes (offline - templated)";
  return actorLabel(message.author);
}
