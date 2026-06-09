import { useId, useState, type FormEvent } from "react";
import type {
  MissionLaunchInput,
  MissionLaunchMode,
  MissionLaunchOutcome,
  MissionLaunchResult,
  SaveTestSuiteInput,
} from "../lib/monitor/mission-launch.js";
import { UtilCard } from "./UtilCard.js";

const DEFAULT_TARGET = "https://app.averray.com";

/**
 * The mission flows, with a plain-language line each (the operator's #1 pain was
 * bare radios with no hint what "Role Gating" or "Citation Repair" does). The
 * tag mirrors the server's mutation posture; the description is the honest
 * one-liner shown under the picker for the selected flow.
 */
const FLOWS: { mode: MissionLaunchMode; name: string; tag: string; desc: string }[] = [
  { mode: "surface_sweep", name: "Surface Sweep", tag: "read-only", desc: "Read-only crawl — visits and observes, never mutates." },
  { mode: "gold_path", name: "Gold Path", tag: "testnet", desc: "Runs a critical journey end-to-end on testnet — pass / fail." },
  { mode: "siwe_auth", name: "Role Gating", tag: "read-only", desc: "Checks access controls hold for each role — read-only." },
  { mode: "citation_repair", name: "Citation Repair", tag: "read-only", desc: "Read-only domain repair against a Job ID — dry run, no claim or edit." },
];

export interface StartMissionLauncherProps {
  onSpawnMission?: (input: MissionLaunchInput) => MissionLaunchOutcome;
  onSaveSuite?: (input: SaveTestSuiteInput) => void;
}

type LaunchFeedback = { ok: boolean; detail: string };

export function StartMissionLauncher({ onSpawnMission, onSaveSuite }: StartMissionLauncherProps) {
  const targetId = useId();
  const jobIdId = useId();
  const goalId = useId();
  const suiteNameId = useId();
  const flowDescId = useId();
  const [targetUrl, setTargetUrl] = useState(DEFAULT_TARGET);
  const [jobId, setJobId] = useState("");
  const [mode, setMode] = useState<MissionLaunchMode>("surface_sweep");
  const [freshMemory, setFreshMemory] = useState(true);
  // Propose-by-default: the first click PROPOSES the mission for review rather
  // than auto-dispatching it (no accidental runs). Turn it off for auto-dispatch.
  const [requestApproval, setRequestApproval] = useState(true);
  const [saveSuite, setSaveSuite] = useState(false);
  const [suiteName, setSuiteName] = useState("");
  const [goal, setGoal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<LaunchFeedback | null>(null);

  const isCitation = mode === "citation_repair";
  const activeFlow = FLOWS.find((flow) => flow.mode === mode)!;

  // Turn the spawn outcome into honest feedback. `undefined` means the handler
  // is fire-and-forget (the /mission command path or a test mock) — best-effort
  // "requested". A reported { ok:false } becomes an explicit failure line.
  const applyOutcome = (outcome: MissionLaunchResult | void) => {
    setPending(false);
    if (outcome && outcome.ok === false) {
      const why = outcome.status ? `HTTP ${outcome.status}` : (outcome.error ?? "request failed");
      setFeedback({ ok: false, detail: why });
      return;
    }
    setFeedback({
      ok: true,
      detail: requestApproval
        ? "queued — approve it in the Decision Inbox"
        : "it’ll appear in the Hermes-checking lane",
    });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = targetUrl.trim();
    const trimmedJobId = jobId.trim();
    // citation_repair keys off a Job ID (or auto-selects), not a URL — so it
    // skips the http(s) target check.
    if (!isCitation && !isHttpUrl(target)) {
      setError("Use an http:// or https:// target.");
      return;
    }
    if (saveSuite && !suiteName.trim()) {
      setError("Name the suite before saving it.");
      return;
    }
    setError(null);
    setFeedback(null);
    const trimmedGoal = goal.trim();
    // Spawn first (so the mission POST precedes the suite POST), then the
    // optional suite save — both fired synchronously before we await the
    // outcome, so a fire-and-forget handler stays fully synchronous.
    const outcome = onSpawnMission?.({
      // citation_repair omits the target server-side; the launch body drops it.
      targetUrl: isCitation ? "" : target,
      mode,
      freshMemory,
      initialStatus: requestApproval ? "requested" : "ready",
      ...(isCitation && trimmedJobId ? { jobId: trimmedJobId } : {}),
      ...(trimmedGoal ? { goal: trimmedGoal } : {}),
    });
    if (saveSuite) {
      onSaveSuite?.({
        name: suiteName.trim(),
        target: isCitation ? (trimmedJobId || "auto-select") : target,
        mode,
        author: "operator",
        ...(trimmedGoal ? { goal: trimmedGoal } : {}),
      });
    }
    // A thenable result → await it for the real POST status; a sync/void handler
    // resolves immediately. The panel stays open so the feedback is visible
    // (the silent close was the "nothing happens" report).
    if (outcome && typeof (outcome as { then?: unknown }).then === "function") {
      setPending(true);
      Promise.resolve(outcome as Promise<MissionLaunchResult | void>)
        .then(applyOutcome)
        .catch(() => {
          setPending(false);
          setFeedback({ ok: false, detail: "request failed" });
        });
    } else {
      applyOutcome(outcome as MissionLaunchResult | void);
    }
  };

  return (
    <UtilCard title="Start a mission" hint="tester launcher" ariaLabel="Start a mission">
      <form className="hm-mission-launcher-form" onSubmit={submit}>
        {/* Flow as labelled cards + one honest description for the active flow. */}
        <div className="hm-flow-field">
          <span className="hm-field-eyebrow">Flow</span>
          <div className="hm-flow-grid" role="radiogroup" aria-label="Flow">
            {FLOWS.map((flow) => {
              const on = mode === flow.mode;
              return (
                <label key={flow.mode} className={`hm-flow-card${on ? " hm-flow-card--on" : ""}`}>
                  <input
                    type="radio"
                    name="mission-flow"
                    className="hm-visually-hidden"
                    checked={on}
                    onChange={() => setMode(flow.mode)}
                    aria-describedby={flowDescId}
                  />
                  <span className="hm-flow-dot" aria-hidden />
                  <span className="hm-flow-name">{flow.name}</span>
                  {flow.tag ? <span className="hm-flow-tag">{flow.tag}</span> : null}
                </label>
              );
            })}
          </div>
          <p className="hm-flow-desc" id={flowDescId}>{activeFlow.desc}</p>
        </div>

        {/* target / job-id swap — citation_repair keys off a Job ID. */}
        {isCitation ? (
          <label className="hm-field hm-field--wide" htmlFor={jobIdId}>
            <span>Job ID</span>
            <input
              id={jobIdId}
              type="text"
              value={jobId}
              onChange={(event) => setJobId(event.target.value)}
              placeholder="Leave empty to auto-select a claimable job"
            />
            <small>read-only analysis — no claim or edit (dry run)</small>
          </label>
        ) : (
          <label className="hm-field hm-field--wide" htmlFor={targetId}>
            <span>Target</span>
            <input
              id={targetId}
              type="url"
              required
              value={targetUrl}
              onChange={(event) => setTargetUrl(event.target.value)}
              placeholder={DEFAULT_TARGET}
            />
          </label>
        )}

        <fieldset className="hm-choice-group">
          <legend>Memory</legend>
          <label>
            <input
              type="radio"
              name="mission-memory"
              checked={freshMemory}
              onChange={() => setFreshMemory(true)}
            />
            <span>Fresh</span>
          </label>
          <label>
            <input
              type="radio"
              name="mission-memory"
              checked={!freshMemory}
              onChange={() => setFreshMemory(false)}
            />
            <span>Memory</span>
          </label>
        </fieldset>

        <label className="hm-field hm-field--wide" htmlFor={goalId}>
          <span>Goal</span>
          <textarea
            id={goalId}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="Optional scope or question for the browser agent"
            rows={2}
          />
        </label>

        <div className="hm-toggle-row">
          <ToggleChip checked={requestApproval} onChange={setRequestApproval}>
            Request approval
          </ToggleChip>
          {onSaveSuite ? (
            <ToggleChip checked={saveSuite} onChange={setSaveSuite}>
              Save this config as a suite
            </ToggleChip>
          ) : null}
        </div>

        {saveSuite && onSaveSuite ? (
          <label className="hm-field" htmlFor={suiteNameId}>
            <span>Suite name</span>
            <input
              id={suiteNameId}
              value={suiteName}
              onChange={(event) => setSuiteName(event.target.value)}
              placeholder="Daily app sweep"
            />
          </label>
        ) : null}

        {error ? <div className="hm-form-error" role="alert">{error}</div> : null}
        {feedback ? (
          feedback.ok ? (
            <div className="hm-form-ok" role="status">Mission requested ✓ — {feedback.detail}.</div>
          ) : (
            <div className="hm-form-error" role="alert">
              Launch failed — {feedback.detail}. The board can’t confirm it; check the tester runner.
            </div>
          )
        ) : null}

        <div className="hm-launcher-actions">
          <button type="submit" className="hm-btn hm-btn--launch" disabled={pending}>
            {pending ? "Launching…" : requestApproval ? "Propose mission" : "Launch mission"}
          </button>
          <p className="hm-launch-explainer">
            {requestApproval
              ? "Hermes reviews before any runner claims it — lands in Your decisions."
              : "Auto-dispatch — runs immediately, without a review gate."}
          </p>
        </div>
      </form>
    </UtilCard>
  );
}

/** A pill toggle that keeps a real, label-associated checkbox for a11y + tests. */
function ToggleChip({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  children: string;
}) {
  return (
    <label className={`hm-toggle-chip${checked ? " hm-toggle-chip--on" : ""}`}>
      <input
        type="checkbox"
        className="hm-visually-hidden"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="hm-toggle-dot" aria-hidden />
      <span>{children}</span>
    </label>
  );
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
