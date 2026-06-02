import { useId, useMemo, useState, type FormEvent } from "react";
import type { MissionLaunchMode, SavedTestSuite, SaveTestSuiteInput } from "../lib/monitor/mission-launch.js";

const DEFAULT_TARGET = "https://app.averray.com";

export interface TestSuitesPanelProps {
  suites?: SavedTestSuite[];
  onRunSuite?: (id: string) => void;
  onSaveSuite?: (input: SaveTestSuiteInput) => void;
  onApproveSuite?: (id: string) => void;
  onDismissSuite?: (id: string) => void;
}

export function TestSuitesPanel({ suites = [], onRunSuite, onSaveSuite, onApproveSuite, onDismissSuite }: TestSuitesPanelProps) {
  const nameId = useId();
  const targetId = useId();
  const goalId = useId();
  const [open, setOpen] = useState(false);
  const [authoringPath, setAuthoringPath] = useState<"predefined" | "operator">("predefined");
  const [name, setName] = useState("");
  const [target, setTarget] = useState(DEFAULT_TARGET);
  const [mode, setMode] = useState<MissionLaunchMode>("surface_sweep");
  const [goal, setGoal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const sortedSuites = useMemo(
    () => suites.slice().sort((a, b) => (b.lastRun?.ts ?? b.updatedAt).localeCompare(a.lastRun?.ts ?? a.updatedAt)),
    [suites],
  );

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedTarget = target.trim();
    const trimmedName = name.trim();
    const trimmedGoal = goal.trim();
    if (!trimmedName) {
      setError("Name the suite before saving it.");
      return;
    }
    if (!isHttpUrl(trimmedTarget)) {
      setError("Use an http:// or https:// target.");
      return;
    }
    if (authoringPath === "operator" && !trimmedGoal) {
      setError("Operator-NL suites need a goal.");
      return;
    }
    setError(null);
    onSaveSuite?.({
      name: trimmedName,
      target: trimmedTarget,
      mode: authoringPath === "operator" ? "surface_sweep" : mode,
      author: authoringPath,
      ...(trimmedGoal ? { goal: trimmedGoal } : {}),
    });
    setOpen(false);
  };

  return (
    <section className="hm-test-suites" aria-label="Saved test suites">
      <div className="hm-mission-launcher-head">
        <div>
          <span className="hm-mission-launcher-kicker">Suites</span>
          <strong>Saved suite library</strong>
          <span>{suites.length > 0 ? `${suites.length} named suites` : "No saved suites yet"}</span>
        </div>
        {onSaveSuite ? (
          <button type="button" className="hm-btn hm-btn--sm" onClick={() => setOpen((value) => !value)}>
            {open ? "Close" : "+ New suite"}
          </button>
        ) : null}
      </div>

      {sortedSuites.length > 0 ? (
        <div className="hm-test-suite-list">
          {sortedSuites.map((suite) => (
            <div className="hm-test-suite-row" key={suite.id}>
              <div>
                <strong>{suite.name}</strong>
                <span>{modeLabel(suite.mode)} · {targetLabel(suite.target)}</span>
                {suite.status === "requested" ? (
                  <small>{suite.requesterAgent ?? suite.author} requested · {suite.requestReason ?? "waiting for operator approval"}</small>
                ) : null}
              </div>
              <div className="hm-test-suite-meta">
                <span className={`hm-test-suite-verdict hm-test-suite-verdict--${verdictTone(suite.lastRun?.verdict)}`}>
                  {suite.status === "requested" ? "requested" : suite.lastRun ? suite.lastRun.verdict : "never run"}
                </span>
                <small>{suite.history.length} runs</small>
              </div>
              {suite.status === "requested" ? (
                <div className="hm-test-suite-actions">
                  {onApproveSuite ? (
                    <button type="button" className="hm-btn hm-btn--action hm-btn--sm" onClick={() => onApproveSuite(suite.id)}>
                      Approve
                    </button>
                  ) : null}
                  {onDismissSuite ? (
                    <button type="button" className="hm-btn hm-btn--sm" onClick={() => onDismissSuite(suite.id)}>
                      Dismiss
                    </button>
                  ) : null}
                </div>
              ) : onRunSuite ? (
                <button type="button" className="hm-btn hm-btn--action hm-btn--sm" onClick={() => onRunSuite(suite.id)}>
                  Run
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="hm-test-suite-empty">Save a launcher config or create a named suite for repeat testbed runs.</p>
      )}

      {open ? (
        <form className="hm-mission-launcher-form hm-test-suite-form" onSubmit={submit}>
          <fieldset className="hm-choice-group">
            <legend>Authoring</legend>
            <label>
              <input
                type="radio"
                name="suite-authoring"
                checked={authoringPath === "predefined"}
                onChange={() => setAuthoringPath("predefined")}
              />
              <span>Predefined</span>
            </label>
            <label>
              <input
                type="radio"
                name="suite-authoring"
                checked={authoringPath === "operator"}
                onChange={() => setAuthoringPath("operator")}
              />
              <span>Operator-NL</span>
            </label>
          </fieldset>
          <label className="hm-field" htmlFor={nameId}>
            <span>Name</span>
            <input id={nameId} value={name} onChange={(event) => setName(event.target.value)} placeholder="Daily surface sweep" />
          </label>
          <label className="hm-field" htmlFor={targetId}>
            <span>Target</span>
            <input id={targetId} type="url" value={target} onChange={(event) => setTarget(event.target.value)} placeholder={DEFAULT_TARGET} />
          </label>
          {authoringPath === "predefined" ? (
            <fieldset className="hm-choice-group hm-choice-group--suite-flow">
              <legend>Flow</legend>
              <label>
                <input type="radio" name="suite-flow" checked={mode === "surface_sweep"} onChange={() => setMode("surface_sweep")} />
                <span>Surface Sweep</span>
              </label>
              <label>
                <input type="radio" name="suite-flow" checked={mode === "gold_path"} onChange={() => setMode("gold_path")} />
                <span>Gold Path</span>
              </label>
              <label>
                <input type="radio" name="suite-flow" checked={mode === "siwe_auth"} onChange={() => setMode("siwe_auth")} />
                <span>Role Gating</span>
              </label>
            </fieldset>
          ) : null}
          <label className="hm-field hm-field--wide" htmlFor={goalId}>
            <span>Goal</span>
            <textarea id={goalId} value={goal} onChange={(event) => setGoal(event.target.value)} rows={2} placeholder="What should the tester prove?" />
          </label>
          {error ? <div className="hm-form-error" role="alert">{error}</div> : null}
          <div className="hm-mission-launcher-actions">
            <button type="submit" className="hm-btn hm-btn--action">
              Save suite
            </button>
            <span>Saved suites still use server-side mutation safety when run.</span>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function modeLabel(mode: MissionLaunchMode): string {
  if (mode === "gold_path") return "Gold Path";
  if (mode === "siwe_auth") return "Role Gating";
  return "Surface Sweep";
}

function targetLabel(value: string): string {
  try {
    const parsed = new URL(value);
    return parsed.host;
  } catch {
    return value;
  }
}

function verdictTone(verdict: string | undefined): string {
  if (verdict === "pass" || verdict === "completed") return "pass";
  if (verdict === "fail" || verdict === "failed") return "fail";
  if (verdict === "partial" || verdict === "running" || verdict === "requested" || verdict === "ready") return "partial";
  return "unknown";
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
