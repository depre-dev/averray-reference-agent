/* Hermes seed data — exported to window.HERMES_DATA
   ─────────────────────────────────────────────────────────────
   HONESTY CONTRACT (port note for engineers):
   • Cards/threads below are the REAL board snapshot.
   • Fields that need a real backend the prototype lacks — heartbeat,
     real cost, confirmed dedupe, live "since you last looked" deltas —
     are NOT fabricated. They carry honest placeholders (—, ?, "awaiting
     data") and are tagged `needsData:true` where relevant.
   • `DEMO_TIMELINE` is a SYNTHETIC design-eval scaffold (Demo toggle only,
     every entry demo:true) and MUST be stripped from the production port.
   • Data model is 1:1 with monitor-ui.
*/

const AGENTS = {
  hermes:   { id:'hermes',      name:'Hermes',      mark:'H', color:'var(--ag-hermes)', role:'orchestrator', presence:'active' },
  claude:   { id:'claude',      name:'Claude',      mark:'C', color:'var(--ag-claude)', role:'worker',       presence:'online' },
  codex:    { id:'codex',       name:'Codex',       mark:'X', color:'var(--ag-codex)',  role:'worker',       presence:'online' },
  test:     { id:'test-writer', name:'Test-writer', mark:'T', color:'var(--ag-test)',   role:'tester',       presence:'idle' },
  operator: { id:'operator',    name:'You',         mark:'●', color:'var(--ag-op)',     role:'operator',     presence:'online' },
  system:   { id:'system',      name:'System',      mark:'S', color:'var(--ag-system)', role:'system',       presence:'online' },
};

/* ── cast roster (I) — per-role capabilities. observe / mutate / approve ── */
const ROLES = [
  { id:'hermes', name:'Hermes', title:'Orchestrator', blurb:'Reviews output and routes work. Proposes and gates — never merges or deploys on its own.',
    can:['observe','approve','route'], cannot:['mutate code','merge','deploy'], active:true },
  { id:'claude', name:'Claude', title:'Builder', blurb:'Worker agent. Writes and changes code, opens PRs. Cannot merge or deploy.',
    can:['observe','mutate code','open PR'], cannot:['merge','deploy','approve'], active:true },
  { id:'codex', name:'Codex', title:'Builder', blurb:'Worker agent. Writes and changes code, opens PRs. Cannot merge or deploy.',
    can:['observe','mutate code','open PR'], cannot:['merge','deploy','approve'], active:true },
  { id:'test', name:'Test-writer', title:'QA', blurb:'Writes tests and replays captured traces. Observes only — never touches product code.',
    can:['observe','write tests','replay'], cannot:['mutate product code','merge','approve'], active:true },
  { id:'security', name:'Security', title:'Specialist', blurb:'Review-only security specialist. Not engaged on the current board.',
    can:['observe','approve'], cannot:['mutate code','deploy'], active:false },
  { id:'docs', name:'Docs', title:'Specialist', blurb:'Documentation specialist. Not engaged on the current board.',
    can:['observe','write docs'], cannot:['mutate code','merge','deploy'], active:false },
  { id:'operator', name:'You', title:'Operator', blurb:'The human. The only actor that can approve mutations, merges and deploys.',
    can:['observe','approve','merge','deploy','reject'], cannot:[], active:true },
];

/* ── top status rail ── */
const SELF_HEAL = 'Self-heal 1 open · dispatch 0/10 · quiet 27';
/* heartbeat needs a real backend signal — honest placeholder, never faked */
const HEARTBEAT = { value:null, label:'awaiting data', needsData:true };
/* "since you last looked" needs a real session backend — this marker is design-only */
const LAST_LOOKED = { time:'13:18', needsData:true };
/* global controls (design-only, not yet wired) */
const CONTROLS = { mode:'supervised', paused:false, preview:true };

const FILTERS = [
  { id:'all', label:'All', count:9 },
  { id:'blocked', label:'Blocked', count:2 },
  { id:'review', label:'Decisions', count:6 },
  { id:'running', label:'Running', count:2 },
  { id:'done', label:'Done', count:4 },
];

/* =========================================================
   UNIFIED CARD STORE (single source of truth)
   stage ∈ codex | checking | opreview | queue | deploying | done
   waitingOn:'operator' → appears in the Decision Inbox (actionable)
   Badge families (G): state · risk · evidence · gate
   ========================================================= */
const MISSION_BODY = 'Read-only mission — the agent stopped before any mutation.';

const CARDS = [
  /* ---- failed browser mission — most-urgent decision ---- */
  {
    id:'fresh-agent-browser-mission--mpz9rsmn-1c', threadId:'mpz9rsmn-1c',
    stage:'opreview', waitingOn:'operator', urgent:true,
    author:'hermes', type:'browser mission', title:'Fresh-agent browser mission', repo:'en.wikipedia.org',
    state:{ label:'Failed', kind:'failed' },
    risk:{ level:'low', type:'test' },
    failureClass:'Infra',
    evidence:[ {k:'traces', n:8}, {k:'shots', n:2}, {k:'video'}, {k:'replay'} ],
    gate:'operator',
    whySeeing:'Automation stopped: a fresh-agent run timed out and needs your call before any retry.',
    reasonChips:['blocked 4h','blocks 2 tasks','low risk','safe rerun'],
    unblock:null,
    env:{ environment:'testbed', identity:'fresh agent · no memory', dataMode:'read-only', browser:'chromium 124', viewport:'1280×800' },
    contract:{ target:'https://en.wikipedia.org/', flow:'Surface Sweep (read-only)', mode:'read-only · no mutation', success:'reaches citation block, no boundary crossed', stop:'45s nav budget or any mutation attempt', budget:'≤ 1 run · 45s', artifacts:'traces · screenshots · video · replay' },
    forensic:{
      expectedObserved:[
        { field:'first paint', expected:'< 5s', observed:'timed out at 30s', ok:false },
        { field:'mutation boundary', expected:'none crossed', observed:'none crossed', ok:true },
        { field:'console errors', expected:'0', observed:'awaiting data', needsData:true },
      ],
      timeline:[
        { t:'+0.0s', e:'runner claimed testbed slot' },
        { t:'+0.4s', e:'chromium launched (headless)' },
        { t:'+0.6s', e:'GET en.wikipedia.org · budget 45s' },
        { t:'+30.0s', e:'nav budget exceeded — no first paint' },
        { t:'+30.1s', e:'runner aborted · 8 traces captured' },
      ],
      failureFrame:'last frame before abort',
    },
    body: MISSION_BODY + ' Runner failed before crossing any boundary.',
    whatNext:'Approving dispatches a fresh read-only re-run; you’ll watch it live and decide again on the result.',
    convertPreview:{ creates:'Bug in depre-dev/agent', title:'Fresh-agent mission times out before first paint', labels:['infra','testbed'], assignee:'unassigned', needsData:true },
    decision:{
      recommended:'Rerun once with 45s nav budget',
      why:'Timed out before first paint; a cold fresh-agent run needs more nav headroom.',
      grants:'browser test only · read-only · 45s timeout · no code changes',
      denies:'no merge · no deploy · no spend · no prod data',
      blast:{ repo:'en.wikipedia.org (target)', branch:'—', env:'testbed', area:'browser-runner', users:'none' },
      rollback:'Nothing to roll back — read-only test. On failure it returns here to your inbox.',
      choices:['Rerun once with 45s nav budget','Reject','Convert to bug','Ask Hermes','Open replay','Dismiss'],
    },
    discussion:{ author:'hermes', time:'11:04',
      text:'I created a fresh-agent browser mission for https://en.wikipedia.org/. The mission is now on the board as testbed-mission-mpz9rsmn-1c. I will hand it to the Hermes testbed runner; when the runner returns a structured report, I will attach it here and explain what changed.' },
  },
  /* ---- failed dry run — policy store down ---- */
  {
    id:'wikipedia-citation-repair-dry-run--mpz9gi3i-1b', threadId:'mpz9gi3i-1b',
    stage:'opreview', waitingOn:'operator',
    author:'hermes', type:'citation-repair · dry run', title:'Wikipedia citation-repair (dry run)', repo:'en.wikipedia.org',
    state:{ label:'Blocked', kind:'blocked' },
    risk:{ level:'low', type:'test' },
    failureClass:'Infra',
    evidence:[ {k:'traces', n:3} ],
    gate:'operator',
    whySeeing:'Automation stopped: the policy store returned 503, so the run could not start.',
    unblock:'Policy store reachable again (503 clears), then re-run.',
    env:{ environment:'testbed', identity:'fresh agent · no memory', dataMode:'read-only · dry run', browser:'chromium 124', viewport:'1280×800' },
    contract:{ target:'https://en.wikipedia.org/', flow:'Citation Repair (dry run)', mode:'read-only · no claim, no submission', success:'policy loads, repair plan drafted', stop:'policy-store error or mutation attempt', budget:'≤ 1 run', artifacts:'traces' },
    body: MISSION_BODY + ' Dry run — no Averray claim or submission attempted.',
    whatNext:'Holding keeps it out of your inbox until the policy store recovers; nothing runs meanwhile.',
    decision:{
      recommended:'Hold for policy-store recovery',
      why:'Blocked by a policy-store 503, not by the mission itself — retrying now will just fail again.',
      grants:'browser test only · read-only · no code changes',
      denies:'no merge · no deploy · no spend · no prod data',
      blast:{ repo:'en.wikipedia.org (target)', branch:'—', env:'testbed', area:'browser-runner', users:'none' },
      rollback:'Nothing to roll back — dry run, no claim or submission.',
      choices:['Hold for policy-store recovery','Rerun','Convert to bug','Ask Hermes','Open replay','Dismiss'],
    },
    discussion:{ author:'hermes', time:'10:56',
      text:'I created a fresh-agent browser mission for https://en.wikipedia.org/. The mission is now on the board as testbed-mission-mpz9gi3i-1b. I will hand it to the Hermes testbed runner; when the runner returns a structured report, I will attach it here and explain what changed.' },
  },
  {
    id:'wikipedia-citation-repair-dry-run--mpz9uldc-1d', threadId:'mpz9uldc-1d',
    stage:'opreview', waitingOn:'operator',
    author:'hermes', type:'citation-repair · dry run', title:'Wikipedia citation-repair (dry run)', repo:'en.wikipedia.org',
    state:{ label:'Blocked', kind:'blocked' },
    risk:{ level:'low', type:'test' },
    failureClass:'Infra',
    evidence:[ {k:'traces', n:3} ],
    gate:'operator',
    whySeeing:'Automation stopped: the policy store returned 503, so the run could not start.',
    unblock:'Policy store reachable again (503 clears), then re-run.',
    dedupe:{ label:'possible duplicate of mpz9gi3i-1b', needsData:true },
    env:{ environment:'testbed', identity:'fresh agent · no memory', dataMode:'read-only · dry run', browser:'chromium 124', viewport:'1280×800' },
    contract:{ target:'https://en.wikipedia.org/', flow:'Citation Repair (dry run)', mode:'read-only · no claim, no submission', success:'policy loads, repair plan drafted', stop:'policy-store error or mutation attempt', budget:'≤ 1 run', artifacts:'traces' },
    body: MISSION_BODY + ' Dry run — no Averray claim or submission attempted.',
    whatNext:'Rejecting closes this card as a duplicate; reopen from Done if it proves separate.',
    convertPreview:{ creates:'Bug in depre-dev/agent', title:'Policy store 503 blocks citation-repair dry runs', labels:['infra','policy-store'], assignee:'unassigned', needsData:true },
    decision:{
      recommended:'Reject as duplicate',
      why:'Looks like the same policy-store outage as mpz9gi3i-1b — but dedupe is unconfirmed (awaiting data).',
      grants:'closes this card only · no code changes',
      denies:'no merge · no deploy · no spend · no prod data',
      blast:{ repo:'en.wikipedia.org (target)', branch:'—', env:'testbed', area:'browser-runner', users:'none' },
      rollback:'Reopen from Done if it turns out to be a separate failure.',
      choices:['Reject as duplicate','Rerun','Hold','Ask Hermes','Open replay','Dismiss'],
    },
    discussion:{ author:'hermes', time:'11:10',
      text:'I created a fresh-agent browser mission for https://en.wikipedia.org/. The mission is now on the board as testbed-mission-mpz9uldc-1d. I will hand it to the Hermes testbed runner; when the runner returns a structured report, I will attach it here and explain what changed.' },
  },

  /* ---- proposed codex tasks (stage codex) — waiting on operator ---- */
  {
    id:'codex-task-testbed-mission-new-20260604T115119265Z-fk01m9',
    stage:'codex', waitingOn:'operator',
    author:'claude', type:'task', title:'Add citation_repair mission mode', repo:'depre-dev/averray-reference-agent',
    state:{ label:'Proposed', kind:'ready' },
    risk:{ level:'low', type:'code' },
    evidence:[ {k:'pr', n:null} ],
    gate:'operator',
    freshness:'Fresh 1.7h',
    whySeeing:'Policy requires approval because dispatching creates a branch and opens a PR.',
    unblock:null,
    whatNext:'Approving dispatches the task to a builder; it opens a PR and runs CI — no merge without your second approval.',
    convertPreview:{ creates:'Bug in depre-dev/averray-reference-agent', title:'citation_repair mission mode missing', labels:['feature'], assignee:'unassigned', needsData:true },
    decision:{
      recommended:'Approve & dispatch',
      why:'Read-only feature addition; no auth or prod surface touched.',
      grants:'create branch · open PR · run CI · no merge, no deploy',
      denies:'no merge · no deploy · no prod data · no spend',
      blast:{ repo:'depre-dev/averray-reference-agent', branch:'feat/citation-mode', env:'CI only', area:'missions', users:'none' },
      rollback:'Close the PR — nothing merges without a second approval.',
      choices:['Approve & dispatch','Reject','Edit task','Ask Hermes','Dismiss'],
    },
  },
  {
    id:'codex-task-testbed-mission-new-20260604T082128545Z-96otu1',
    stage:'codex', waitingOn:'operator',
    author:'claude', type:'task', title:'Fix /auth/verify KMS-JWT auth', repo:'depre-dev/averray-reference-agent',
    state:{ label:'Proposed', kind:'ready' },
    risk:{ level:'med', type:'code' },
    evidence:[ {k:'pr', n:null} ],
    gate:'operator',
    freshness:'Fresh 5.2h',
    whySeeing:'Policy requires approval because this modifies the auth path.',
    unblock:null,
    whatNext:'Approving opens a PR and runs CI; the auth change still needs your explicit merge before it reaches prod.',
    convertPreview:{ creates:'Bug in depre-dev/averray-reference-agent', title:'/auth/verify rejects valid KMS-JWT', labels:['bug','auth'], assignee:'unassigned', needsData:true },
    decision:{
      recommended:'Approve & dispatch with extra review',
      why:'Touches the auth path — medium risk; CI plus your review gate the merge.',
      grants:'create branch · open PR · run CI · no merge',
      denies:'no merge · no deploy · no prod data · no spend',
      blast:{ repo:'depre-dev/averray-reference-agent', branch:'fix/kms-jwt-verify', env:'CI only', area:'auth', users:'none until merged' },
      rollback:'Close the PR — auth changes never reach prod without your merge.',
      choices:['Approve & dispatch','Reject','Edit task','Ask Hermes','Dismiss'],
    },
  },
  {
    id:'codex-task-testbed-mission-new-20260604T082127110Z-wt0crk',
    stage:'codex', waitingOn:'operator',
    author:'claude', type:'task', title:'Harden testbed runner nav budget', repo:'depre-dev/averray-reference-agent',
    state:{ label:'Proposed', kind:'ready' },
    risk:{ level:'low', type:'code' },
    evidence:[ {k:'pr', n:null} ],
    gate:'operator',
    freshness:'Fresh 5.2h',
    whySeeing:'Policy requires approval because dispatching creates a branch and opens a PR.',
    unblock:null,
    whatNext:'Approving dispatches the task to a builder; it opens a PR and runs CI — no merge without your second approval.',
    convertPreview:{ creates:'Bug in depre-dev/averray-reference-agent', title:'Testbed runner nav budget too tight for cold starts', labels:['infra'], assignee:'unassigned', needsData:true },
    decision:{
      recommended:'Approve & dispatch',
      why:'Config-only change to the testbed runner; low blast radius.',
      grants:'create branch · open PR · run CI · no merge, no deploy',
      denies:'no merge · no deploy · no prod data · no spend',
      blast:{ repo:'depre-dev/averray-reference-agent', branch:'chore/nav-budget', env:'CI only', area:'testbed-runner', users:'none' },
      rollback:'Close the PR — nothing merges without a second approval.',
      choices:['Approve & dispatch','Reject','Edit task','Ask Hermes','Dismiss'],
    },
  },

  /* ---- running: post-merge deploy verification (stage deploying) ---- */
  {
    id:'post-production-deploy-verification', stage:'deploying', waitingOn:null,
    author:'system', type:'deploy-verify', title:'Current deploy: verifying', repo:'depre-dev/agent',
    grouped:3,
    state:{ label:'Verifying', kind:'running' },
    risk:{ level:'low', type:'deploy' },
    evidence:[ {k:'tests'}, {k:'ci'} ],
    gate:'system',
    whySeeing:null,
    checkpoints:[
      { label:'CI queued', state:'done' },
      { label:'install', state:'done' },
      { label:'unit tests', state:'done' },
      { label:'browser replay', state:'current' },
      { label:'Hermes review', state:'todo' },
      { label:'ready', state:'todo' },
    ],
    body:'3 near-identical verification cards grouped. Expand to inspect each one.',
  },

  /* ---- done (release history) ---- */
  { id:'post-production-deploy-verification--3f2a', stage:'done', waitingOn:null, author:'system', type:'deploy-verify', title:'post-production-deploy verification', repo:'depre-dev/agent', state:{ label:'Verified', kind:'done' }, gate:'system', verdict:'deploy ok' },
  { id:'post-production-deploy-verification--9b71', stage:'done', waitingOn:null, author:'system', type:'deploy-verify', title:'post-production-deploy verification', repo:'depre-dev/agent', state:{ label:'Verified', kind:'done' }, gate:'system', verdict:'deploy ok' },
  { id:'post-production-deploy-verification--c08d', stage:'done', waitingOn:null, author:'system', type:'deploy-verify', title:'post-production-deploy verification', repo:'depre-dev/agent', state:{ label:'Verified', kind:'done' }, gate:'system', verdict:'deploy ok' },
  { id:'branch-protection-sync--a14e', stage:'done', waitingOn:null, author:'system', type:'branch-sync', title:'branch-protection sync', repo:'depre-dev/agent', state:{ label:'Verified', kind:'done' }, gate:'system', verdict:'verified' },
];

/* pipeline lane definitions (left→right). gate:true lanes stay visible even empty (K). */
const LANES = [
  { id:'inbox',     name:'Your decisions',     sub:'Everything waiting on you',  tier:'decide', inbox:true, gate:true },
  { id:'codex',     name:'Builder tasks',      sub:'Proposed by Claude / Codex', tier:'watch' },
  { id:'checking',  name:'Hermes checking',    sub:'Verifying',                  tier:'watch' },
  { id:'opreview',  name:'Runs needing review',sub:'Failed / finished runs',     tier:'decide', gate:true },
  { id:'queue',     name:'Release queue',      sub:'Staged for release',         tier:'hide' },
  { id:'deploying', name:'Deploying',          sub:'Verifying post-merge',       tier:'watch' },
  { id:'done',      name:'Done',               sub:'Release history',            tier:'hide' },
];

/* ── ROOM: real threads (kind:status, hermes → you) ── */
const THREADS = [
  { id:'mpz9gi3i-1b', cardRef:'wikipedia-citation-repair-dry-run--mpz9gi3i-1b',
    turns:[ { id:'t1', author:'hermes', target:'operator', kind:'status', time:'10:56',
      text:'I created a fresh-agent browser mission for https://en.wikipedia.org/. The mission is now on the board as testbed-mission-mpz9gi3i-1b. I will hand it to the Hermes testbed runner; when the runner returns a structured report, I will attach it here and explain what changed.' } ] },
  { id:'mpz9rsmn-1c', cardRef:'fresh-agent-browser-mission--mpz9rsmn-1c',
    turns:[ { id:'t2', author:'hermes', target:'operator', kind:'status', time:'11:04',
      text:'I created a fresh-agent browser mission for https://en.wikipedia.org/. The mission is now on the board as testbed-mission-mpz9rsmn-1c. I will hand it to the Hermes testbed runner; when the runner returns a structured report, I will attach it here and explain what changed.' } ] },
  { id:'mpz9uldc-1d', cardRef:'wikipedia-citation-repair-dry-run--mpz9uldc-1d',
    turns:[ { id:'t3', author:'hermes', target:'operator', kind:'status', time:'11:10',
      text:'I created a fresh-agent browser mission for https://en.wikipedia.org/. The mission is now on the board as testbed-mission-mpz9uldc-1d. I will hand it to the Hermes testbed runner; when the runner returns a structured report, I will attach it here and explain what changed.' } ] },
];

/* ── SYNTHETIC demo timeline (Demo toggle only — stripped in prod) ── */
const DEMO_TIMELINE = [
  { at:600,  type:'presence', agent:'codex', presence:'active' },
  { at:700,  type:'typing',   threadId:'mpz9rsmn-1c', agent:'codex' },
  { at:2100, type:'turn', threadId:'mpz9rsmn-1c', turn:{
      author:'codex', target:'hermes', kind:'request_help', time:'now', demo:true,
      text:'Re-run keeps timing out before first paint. Is the nav budget the limit, or is the read-only boundary stopping the page from settling? I can\u2019t tell from the 8 traces.' } },
  { at:2600, type:'typing', threadId:'mpz9rsmn-1c', agent:'hermes' },
  { at:4200, type:'turn', threadId:'mpz9rsmn-1c', turn:{
      author:'hermes', target:'codex', kind:'proposal', time:'now', demo:true,
      text:'Proposal: raise the nav budget to 45s for this fresh-agent class and keep the read-only boundary. That covers a cold first paint without weakening the mutation guard. Needs operator ok before re-run.' } },
  { at:4600, type:'presence', agent:'codex', presence:'online' },
  { at:5400, type:'turn', threadId:'mpz9gi3i-1b', turn:{
      author:'claude', target:'everyone', kind:'chat', time:'now', demo:true,
      text:'Seeing the same policy-store 503 on the dry-run side (mpz9gi3i-1b). Likely one outage, not two missions. Holding my re-run until it clears.' } },
  { at:6000, type:'presence', agent:'test', presence:'active' },
  { at:6200, type:'turn', threadId:'mpz9rsmn-1c', turn:{
      author:'test', target:'hermes', kind:'status', time:'now', demo:true,
      text:'Replaying the 8 captured traces for mpz9rsmn-1c so the re-run starts from a known state.' } },
  { at:7400, type:'presence', agent:'test', presence:'idle' },
];

const KIND_META = {
  request_help: { label:'Needs help', tone:'act',  rank:3 },
  proposal:     { label:'Proposal',   tone:'ok',   rank:2 },
  review:       { label:'Review',     tone:'act',  rank:2 },
  chat:         { label:'Chat',       tone:'ink',  rank:1 },
  status:       { label:'Status',     tone:'tel',  rank:0 },
};

/* evidence label map (G — Evidence family) */
const EVIDENCE_LABEL = {
  traces:(n)=>`${n} traces`, shots:(n)=>`${n} shots`, video:()=>'video', replay:()=>'replay',
  pr:(n)=>n?`PR #${n}`:'no PR yet', tests:()=>'tests', ci:()=>'CI', diff:()=>'diff', files:(n)=>`${n} files`,
};

window.HERMES_DATA = {
  AGENTS, ROLES, SELF_HEAL, HEARTBEAT, LAST_LOOKED, CONTROLS, FILTERS,
  CARDS, LANES, THREADS, DEMO_TIMELINE, KIND_META, EVIDENCE_LABEL,
  CLOCK_START:'13:33:20',
};
