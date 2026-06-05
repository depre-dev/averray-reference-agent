/* Hermes — Utilities panel (supporting row: LLM usage · suites · tester launcher)
   Calm, dim, secondary to the board. Coral appears once — Launch mission. */
const { AGENTS: AGU } = window.HERMES_DATA;

/* tiny telemetry sparkline (data viz, not decoration) */
function Sparkline({ data, color='var(--tel)', w=92, h=26 }) {
  const max = Math.max(...data, 1), min = Math.min(...data, 0);
  const span = (max - min) || 1;
  const pts = data.map((v,i) => [ (i/(data.length-1))*w, h - 3 - ((v-min)/span)*(h-6) ]);
  const d = pts.map((p,i)=> (i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ');
  const area = d + ` L ${w} ${h} L 0 ${h} Z`;
  return (
    <svg width={w} height={h} style={{ display:'block', overflow:'visible' }}>
      <path d={area} fill={color} opacity="0.12" />
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" opacity="0.7" />
      <circle cx={pts[pts.length-1][0]} cy={pts[pts.length-1][1]} r="2.2" fill={color} />
    </svg>
  );
}

function Vital({ label, value, sub, q }) {
  return (
    <div style={{ minWidth:0 }}>
      <div className="eyebrow" style={{ fontSize:9, color:'var(--hm-faint)' }}>{label}</div>
      <div className="font-display" style={{ fontSize:19, fontWeight:700, marginTop:3, color: q?'var(--hm-faint)':'var(--hm-ink)' }}>
        {q ? '?' : value}
      </div>
      <div className="mono" style={{ fontSize:10, color:'var(--hm-faint)', marginTop:1 }}>{q ? 'source unavailable' : sub}</div>
    </div>
  );
}

/* ── surface 1: LLM usage — per-model breakdown ──
   Real per-model rows; an unavailable metric shows ? (never fabricated). */
const USAGE_MODELS = [
  { model:'deepseek-v4-pro', owner:'Hermes',      ownerColor:'var(--ag-hermes)', tokens:'9.2K', calls:38, lat:'1.9s' },
  { model:'claude-sonnet-4.6', owner:'workers',   ownerColor:'var(--ag-claude)', tokens:'5.1K', calls:52, lat:'2.4s' },
  { model:'codex-large',     owner:'Codex',       ownerColor:'var(--ag-codex)',  tokens:'2.1K', calls:26, lat:null }, // latency source down → ?
  { model:'claude-haiku-4',  owner:'test-writer', ownerColor:'var(--ag-test)',   tokens:'0.6K', calls:8,  lat:'3.1s' },
];
const USAGE_TOTAL = { tokens:'17.0K', calls:124, lat:null }; // aggregate avg-latency unavailable while a source is down

function UCol({ children, w, right, head }) {
  return <div style={{ width:w, flex: w?'none':1, minWidth:0, textAlign: right?'right':'left',
    fontFamily: head?'var(--font-display)':'inherit', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{children}</div>;
}

/* per-model multi-line chart — one faint line per model over last 60 min.
   Demo series (clearly synthetic shape); real backend streams per-model tokens/min. */
function UsageChart({ series, height=150 }) {
  const w = 300, h = height, padL = 4, padR = 4, padT = 8, padB = 18;
  const n = series[0].data.length;
  const allMax = Math.max(...series.flatMap(s => s.data), 1);
  const x = (i) => padL + (i/(n-1))*(w-padL-padR);
  const y = (v) => padT + (1 - v/allMax)*(h-padT-padB);
  const line = (data) => data.map((v,i)=>(i?'L':'M')+x(i).toFixed(1)+' '+y(v).toFixed(1)).join(' ');
  const ticks = ['-60m','-45m','-30m','-15m','now'];
  return (
    <div style={{ marginTop:'auto', paddingTop:12 }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
        <div className="eyebrow" style={{ fontSize:9, color:'var(--hm-faint)' }}>Recent usage · tokens/min · per model</div>
        <span className="chip" style={{ padding:'1px 7px', fontSize:9, color:'var(--ag-claude)', borderColor:'rgba(112,72,182,0.3)' }}>demo shape</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" style={{ display:'block', overflow:'visible' }}>
        {/* gridlines */}
        {[0.25,0.5,0.75].map(g => <line key={g} x1={padL} x2={w-padR} y1={padT+g*(h-padT-padB)} y2={padT+g*(h-padT-padB)} stroke="var(--hm-line-2)" strokeWidth="1" />)}
        {/* per-model lines */}
        {series.map(s => (
          <g key={s.model}>
            <path d={line(s.data)} fill="none" stroke={s.color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" opacity="0.62" vectorEffect="non-scaling-stroke" />
            <circle cx={x(n-1)} cy={y(s.data[n-1])} r="2.4" fill={s.color} />
          </g>
        ))}
        {/* x ticks */}
        {ticks.map((t,i) => <text key={t} x={padL + (i/(ticks.length-1))*(w-padL-padR)} y={h-5} fill="var(--hm-faint)" fontSize="8" fontFamily="var(--font-mono)" textAnchor={i===0?'start':(i===ticks.length-1?'end':'middle')}>{t}</text>)}
      </svg>
      {/* legend */}
      <div style={{ display:'flex', gap:12, flexWrap:'wrap', marginTop:8 }}>
        {series.map(s => (
          <span key={s.model} style={{ display:'inline-flex', alignItems:'center', gap:6, minWidth:0 }}>
            <span style={{ width:10, height:2.5, borderRadius:2, background:s.color, flex:'none' }} />
            <span className="mono" style={{ fontSize:10, color:'var(--hm-muted)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{s.model}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/* synthetic per-model usage series (demo shape — real backend streams this) */
const USAGE_SERIES = [
  { model:'deepseek-v4-pro', color:'var(--ag-hermes)', data:[4,6,5,8,7,11,9,14,12,16,13,15,17] },
  { model:'claude-sonnet-4.6', color:'var(--ag-claude)', data:[7,9,8,6,10,9,12,8,11,10,13,11,9] },
  { model:'codex-large', color:'var(--ag-codex)', data:[2,3,2,4,3,5,4,3,6,4,5,3,4] },
  { model:'claude-haiku-4', color:'var(--ag-test)', data:[1,0,1,2,1,1,0,2,1,1,2,1,1] },
];

function UsagePanel() {
  const colHead = { fontSize:9, fontWeight:700, textTransform:'uppercase', color:'var(--hm-faint)', letterSpacing:'0' };
  return (
    <UtilCard title="LLM usage" hint="per model · last 60 min" fill>
      {/* column header */}
      <div className="font-display" style={{ display:'flex', alignItems:'center', gap:10, padding:'0 2px 7px' }}>
        <UCol head><span style={colHead}>Model</span></UCol>
        <UCol w={56} right head><span style={colHead}>Tokens</span></UCol>
        <UCol w={46} right head><span style={colHead}>Calls</span></UCol>
        <UCol w={62} right head><span style={colHead}>Latency</span></UCol>
      </div>
      {/* total row */}
      <div style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 2px', borderTop:'1px solid var(--hm-line-2)', borderBottom:'1px solid var(--hm-line-2)' }}>
        <UCol><span className="font-display" style={{ fontSize:12.5, fontWeight:700, color:'var(--hm-ink)' }}>All models</span></UCol>
        <UCol w={56} right><span className="mono" style={{ fontSize:13, fontWeight:600, color:'var(--hm-ink)' }}>{USAGE_TOTAL.tokens}</span></UCol>
        <UCol w={46} right><span className="mono" style={{ fontSize:13, fontWeight:600, color:'var(--hm-ink)' }}>{USAGE_TOTAL.calls}</span></UCol>
        <UCol w={62} right><span className="mono" style={{ fontSize:13, fontWeight:600, color: USAGE_TOTAL.lat?'var(--hm-ink)':'var(--hm-faint)' }}>{USAGE_TOTAL.lat||'?'}</span></UCol>
      </div>
      {/* per-model rows */}
      <div style={{ display:'flex', flexDirection:'column' }}>
        {USAGE_MODELS.map((m,i) => (
          <div key={m.model} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 2px', borderTop: i?'1px solid var(--hm-line-2)':'none' }}>
            <UCol>
              <div style={{ display:'flex', alignItems:'center', gap:7, minWidth:0 }}>
                <span style={{ width:6, height:6, borderRadius:'50%', background:m.ownerColor, flex:'none' }} />
                <span className="mono" style={{ fontSize:12, color:'var(--hm-ink-2)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{m.model}</span>
                <span className="font-display" style={{ fontSize:10.5, color:'var(--hm-faint)', flex:'none' }}>{m.owner}</span>
              </div>
            </UCol>
            <UCol w={56} right><span className="mono" style={{ fontSize:12, color:'var(--hm-muted)' }}>{m.tokens}</span></UCol>
            <UCol w={46} right><span className="mono" style={{ fontSize:12, color:'var(--hm-muted)' }}>{m.calls}</span></UCol>
            <UCol w={62} right><span className="mono" style={{ fontSize:12, color: m.lat?'var(--hm-muted)':'var(--hm-faint)' }}>{m.lat||'?'}</span></UCol>
          </div>
        ))}
      </div>
      {/* recent usage chart fills the remaining height */}
      <UsageChart series={USAGE_SERIES} />
    </UtilCard>
  );
}

/* ── surface 2: saved suite library (honestly empty) ── */
function SuitePanel() {
  const suites = []; // current reality: none saved
  return (
    <UtilCard title="Saved suites" hint={suites.length ? `${suites.length} saved` : 'library'}
      action={<button className="btn btn--soft btn--sm" style={{ borderStyle:'dashed' }}>+ New suite</button>}>
      {suites.length === 0 ? (
        <div style={{ display:'flex', alignItems:'center', gap:12, padding:'4px 2px' }}>
          <div style={{ width:34, height:34, borderRadius:10, flex:'none', background:'var(--hm-paper-sunken)',
            border:'1px solid var(--hm-line-2)', display:'grid', placeItems:'center', color:'var(--hm-faint)', fontSize:16 }}>·</div>
          <div style={{ minWidth:0 }}>
            <div className="font-display" style={{ fontSize:13, fontWeight:600, color:'var(--hm-muted)' }}>No saved suites yet</div>
            <div style={{ fontSize:12, color:'var(--hm-faint)', marginTop:2, textWrap:'pretty' }}>Save a launcher config or create a named suite for repeat runs.</div>
          </div>
        </div>
      ) : (
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
          {suites.map(s => (
            <div key={s.name} className="chip" style={{ padding:'6px 10px', gap:8 }}>
              <span className="font-display" style={{ fontWeight:600, color:'var(--hm-ink-2)' }}>{s.name}</span>
              <Pill tone={s.tone} style={{ minHeight:17, height:17, fontSize:9 }}>{s.verdict}</Pill>
              <button className="btn btn--sm" style={{ height:22, padding:'0 8px', background:'transparent', border:'1px solid var(--hm-line)', color:'var(--hm-muted)' }}>Run</button>
            </div>
          ))}
        </div>
      )}
    </UtilCard>
  );
}

/* ── surface 3: tester launcher ── */
const FLOWS = [
  { id:'sweep',    name:'Surface Sweep',   tag:'read-only', desc:'Read-only crawl — visits and observes, never mutates.' },
  { id:'gold',     name:'Gold Path',       tag:'testnet',   desc:'Runs a critical journey end-to-end — pass / fail.' },
  { id:'role',     name:'Role Gating',     tag:'',          desc:'Checks access controls hold for each role.' },
  { id:'citation', name:'Citation Repair', tag:'',          desc:'Domain repair against a Job ID — dry-run first.' },
];
function LauncherPanel() {
  const [flow, setFlow] = React.useState('sweep');
  const [target, setTarget] = React.useState('en.wikipedia.org');
  const [jobId, setJobId] = React.useState('');
  const [goal, setGoal] = React.useState('');
  const [approval, setApproval] = React.useState(true);
  const [saveSuite, setSaveSuite] = React.useState(false);
  const isCitation = flow === 'citation';
  const activeFlow = FLOWS.find(f => f.id === flow);
  return (
    <UtilCard title="Start a mission" hint="tester launcher">
      <div style={{ display:'grid', gap:11 }}>
        {/* flow picker */}
        <div>
          <div className="eyebrow" style={{ fontSize:9, color:'var(--hm-faint)', marginBottom:6 }}>Flow</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
            {FLOWS.map(f => {
              const on = flow===f.id;
              return (
                <button key={f.id} onClick={()=>setFlow(f.id)} className="font-display" style={{ display:'flex', alignItems:'center', gap:8,
                  textAlign:'left', height:34, padding:'0 10px', borderRadius:'var(--r-sm)', cursor:'pointer',
                  border:`1px solid ${on?'var(--act-line)':'var(--hm-line)'}`, background: on?'var(--act-soft)':'var(--hm-paper-sunken)' }}>
                  <span style={{ width:13, height:13, borderRadius:'50%', flex:'none', border:`1.5px solid ${on?'var(--act)':'var(--hm-line-strong)'}`,
                    display:'grid', placeItems:'center' }}>
                    {on && <span style={{ width:6, height:6, borderRadius:'50%', background:'var(--act)' }} />}
                  </span>
                  <span style={{ fontSize:12.5, fontWeight:600, color: on?'var(--act-text)':'var(--hm-ink-2)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{f.name}</span>
                  {f.tag && <span className="mono" style={{ marginLeft:'auto', fontSize:9.5, color:'var(--hm-faint)', flex:'none' }}>{f.tag}</span>}
                </button>
              );
            })}
          </div>
          {/* one honest line per flow (#10) */}
          {activeFlow && <div style={{ marginTop:7, fontSize:11.5, color:'var(--hm-muted)', lineHeight:1.45 }}>{activeFlow.desc}</div>}
        </div>
        {/* target / job id swap */}
        <div>
          <div className="eyebrow" style={{ fontSize:9, color:'var(--hm-faint)', marginBottom:5 }}>{isCitation ? 'Job ID' : 'Target URL'}</div>
          {isCitation
            ? <input value={jobId} onChange={e=>setJobId(e.target.value)} placeholder="citation-job-…" className="mono"
                style={{ width:'100%', height:34, padding:'0 11px', borderRadius:'var(--r-sm)', border:'1px solid var(--hm-line)', background:'var(--hm-paper-sunken)', fontSize:12.5, color:'var(--hm-ink)', outline:'none' }} />
            : <input value={target} onChange={e=>setTarget(e.target.value)} placeholder="https://…" className="mono"
                style={{ width:'100%', height:34, padding:'0 11px', borderRadius:'var(--r-sm)', border:'1px solid var(--hm-line)', background:'var(--hm-paper-sunken)', fontSize:12.5, color:'var(--hm-ink)', outline:'none' }} />}
        </div>
        {/* goal */}
        <div>
          <div className="eyebrow" style={{ fontSize:9, color:'var(--hm-faint)', marginBottom:5 }}>Goal <span style={{ textTransform:'none', fontWeight:500 }}>· optional</span></div>
          <textarea value={goal} onChange={e=>setGoal(e.target.value)} rows={2} placeholder="What should the fresh agent attempt?"
            style={{ width:'100%', padding:'8px 11px', borderRadius:'var(--r-sm)', border:'1px solid var(--hm-line)', background:'var(--hm-paper-sunken)', fontSize:12.5, fontFamily:'var(--font-body)', color:'var(--hm-ink)', resize:'none', outline:'none' }} />
        </div>
        {/* toggles */}
        <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
          <ToggleChip on={approval} set={setApproval}>request approval</ToggleChip>
          <ToggleChip on={saveSuite} set={setSaveSuite}>save as suite</ToggleChip>
        </div>
        {/* CTA — conditional + visually demoted so it never out-shouts the decision CTA (#9) */}
        <button className="btn btn--sm" style={{ width:'100%', background:'var(--hm-ink)', color:'var(--hm-paper)', border:'1px solid transparent' }}>
          {approval ? 'Propose mission' : 'Launch mission'}
        </button>
        <p style={{ margin:0, fontSize:10.5, color:'var(--hm-faint)', textWrap:'pretty' }}>
          {approval ? 'Hermes reviews before any runner claims it — lands in Your decisions.' : 'Auto-dispatch — runs immediately, without a review gate.'}
        </p>
      </div>
    </UtilCard>
  );
}

function ToggleChip({ on, set, children }) {
  return (
    <button onClick={()=>set(v=>!v)} className="chip click" style={{ height:28, gap:7,
      color: on?'var(--ok-text)':'var(--hm-faint)', borderColor: on?'var(--ok-line)':'var(--hm-line-2)' }}>
      <span style={{ width:8, height:8, borderRadius:'50%', border:'1.5px solid currentColor', background: on?'currentColor':'transparent', flex:'none' }} />
      {children}
    </button>
  );
}

/* shared card chrome (calm, dim, secondary) */
function UtilCard({ title, hint, action, children, fill }) {
  return (
    <div style={{ background:'var(--hm-paper)', border:'1px solid var(--hm-line-2)', borderRadius:'var(--r-card)', padding:'14px 15px',
      display:'flex', flexDirection:'column', minWidth:0, height: fill?'100%':'auto' }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
        <span className="font-display" style={{ fontWeight:700, fontSize:13.5, color:'var(--hm-ink-2)', whiteSpace:'nowrap', flex:'none' }}>{title}</span>
        {hint && <span className="eyebrow" style={{ fontSize:9, color:'var(--hm-faint)', flex:'none' }}>{hint}</span>}
        {action && <span style={{ marginLeft:'auto' }}>{action}</span>}
      </div>
      {children}
    </div>
  );
}

/* ── the row: collapsed strip ⇄ expanded panel ── */
function UtilitiesPanel({ open, onToggle }) {
  return (
    <div style={{ borderRadius:'var(--r-card)', background:'var(--hm-paper-sunken)', border:'1px solid var(--hm-line-2)', overflow:'hidden' }}>
      <button onClick={onToggle} style={{ width:'100%', display:'flex', alignItems:'center', justifyContent:'space-between', gap:12,
        padding:'11px 16px', background:'transparent', border:0, cursor:'pointer', textAlign:'left' }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, minWidth:0 }}>
          <span style={{ color:'var(--hm-faint)', flex:'none', display:'inline-block', transition:'transform var(--dur) var(--ease)',
            transform: open?'rotate(90deg)':'none' }}>▸</span>
          <span className="font-display" style={{ fontWeight:600, fontSize:13, color:'var(--hm-ink-2)', flex:'none' }}>Utilities</span>
          <span style={{ fontSize:13, color:'var(--hm-muted)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>LLM usage · suites · tester launcher</span>
        </div>
        <span className="mono" style={{ fontSize:12, color:'var(--hm-faint)', flex:'none' }}>{open ? 'collapse' : '17K tokens · no suites · tester ready'}</span>
      </button>
      {open && (
        <div style={{ padding:'2px 14px 14px', borderTop:'1px solid var(--hm-line-2)' }}>
          <div className="util-grid" style={{ display:'grid', gap:12, gridTemplateColumns:'1fr 1fr', alignItems:'stretch', marginTop:12 }}>
            {/* left: full-height per-model usage */}
            <UsagePanel />
            {/* right: launcher on top, compact saved-suites below */}
            <div style={{ display:'grid', gap:12, gridTemplateRows:'auto auto', minWidth:0 }}>
              <LauncherPanel />
              <SuitePanel />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

window.Utilities = { UtilitiesPanel };
