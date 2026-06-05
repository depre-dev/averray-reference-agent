/* Hermes — board (left column): top bar, banner, toolbar, DECIDE / WATCH / HIDE */
const { AGENTS } = window.HERMES_DATA;

/* tiny author line: presence dot (agent color) + name + mono id */
function AuthorLine({ authorId, mono, freshness }) {
  const a = AGENTS[authorId] || AGENTS.system;
  return (
    <div style={{ display:'flex', alignItems:'center', gap:8, minWidth:0 }}>
      <PresenceDot presence={a.presence} color={a.color} size={8} ring={false} />
      <span className="font-display" style={{ fontWeight:600, fontSize:12.5, color:a.color }}>{a.name}</span>
      {mono && <span className="mono" style={{ fontSize:12, color:'var(--hm-muted)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{mono}</span>}
      {freshness && (
        <span style={{ marginLeft:'auto', display:'inline-flex', alignItems:'center', gap:6, flex:'none' }}>
          <span style={{ width:6, height:6, borderRadius:'50%', background:'var(--ok)' }} />
          <span className="font-display" style={{ fontSize:11, fontWeight:600, textTransform:'uppercase', color:'var(--hm-faint)' }}>{freshness}</span>
        </span>
      )}
    </div>
  );
}

/* ───────────────── top bar ───────────────── */
function TopBar({ clock, cards, controls, onToggleControls }) {
  const { SELF_HEAL, CONTROLS } = window.HERMES_DATA;
  controls = controls || CONTROLS;
  cards = cards || window.HERMES_DATA.CARDS;
  const decisions = cards.filter(c => c.waitingOn === 'operator').length;
  const running = cards.filter(c => c.state && c.state.kind === 'running').length;
  const done = cards.filter(c => c.stage === 'done').length;
  const chips = [
    { id:'dec',  label:'Decisions', count:decisions, primary:true },
    { id:'run',  label:'Running',   count:running },
    { id:'done', label:'Done',      count:done },
  ];
  return (
    <header style={{ display:'flex', alignItems:'center', gap:16, padding:'12px 20px', background:'var(--hm-paper-veil)',
      borderBottom:'1px solid var(--hm-line)', backdropFilter:'blur(12px)', flex:'none', zIndex:30 }}>
      <div style={{ display:'flex', alignItems:'center', gap:12, flex:'none' }}>
        <BrandMark size={40} label="A" />
        <div>
          <div className="font-display" style={{ fontWeight:700, fontSize:19, lineHeight:1 }}>Hermes</div>
          <div className="eyebrow" style={{ fontSize:10, marginTop:3 }}>Handoff monitor · Averray</div>
        </div>
      </div>

      <div className="scroll-y" style={{ display:'flex', alignItems:'center', gap:8, overflowX:'auto', overflowY:'hidden', flex:1, padding:'2px 0' }}>
        {chips.map(c => <StatusChip key={c.id} c={c} />)}
        <span className="pill pill--ok" style={{ flex:'none', height:30 }} title="Overall production health"><span className="dot" />Prod healthy</span>
        <span className="chip" style={{ flex:'none', height:30, borderRadius:'var(--r-pill)' }}>{SELF_HEAL}</span>
        <span className="chip" style={{ flex:'none', height:30, borderRadius:'var(--r-pill)' }} title="Heartbeat needs a real backend signal — not fabricated">heartbeat —</span>
      </div>

      <div style={{ display:'flex', alignItems:'center', gap:8, flex:'none' }}>
        {/* global controls — design-only, not yet wired (preview) */}
        <button onClick={onToggleControls} className="chip click" title="Operating mode and grants — preview, not wired"
          style={{ height:34, gap:7, paddingRight:9 }}>
          <span style={{ width:7, height:7, borderRadius:'50%', background:'var(--ok)', flex:'none' }} />
          <span className="font-display" style={{ fontWeight:600, fontSize:12, color:'var(--hm-ink-2)' }}>Mode: {controls.mode}</span>
          <span style={{ fontSize:9, padding:'1px 5px', borderRadius:4, background:'var(--hm-paper-sunken)', color:'var(--hm-faint)', textTransform:'uppercase', fontWeight:700, letterSpacing:'0' }}>preview</span>
        </button>
        <button className="btn btn--ghost btn--sm" title="Pause all agents — preview, not wired"
          style={{ height:34 }} aria-label="Pause agents (preview, not wired)">
          <span aria-hidden="true" style={{ display:'inline-flex', gap:2.5, marginRight:5 }}>
            <span style={{ width:3, height:11, background:'var(--hm-muted)', borderRadius:1 }} />
            <span style={{ width:3, height:11, background:'var(--hm-muted)', borderRadius:1 }} />
          </span>
          Pause agents
        </button>
        <span className="pill pill--ok" style={{ height:34, fontFamily:'var(--font-mono)', fontWeight:600, fontSize:12 }}>
          <span className="dot live-dot" />LIVE · {clock}
        </span>
        <button className="btn btn--ghost btn--sm" style={{ height:34 }} aria-label="Refresh board">⟳ Refresh</button>
      </div>
    </header>
  );
}

/* global controls popover (design-only — honest/inert) */
function ControlsSheet({ open, onClose }) {
  const { CONTROLS, ROLES } = window.HERMES_DATA;
  if (!open) return null;
  return (
    <>
      <div onClick={onClose} style={{ position:'fixed', inset:0, zIndex:64 }} />
      <div className="anim-rise" style={{ position:'fixed', top:60, right:18, width:'min(360px,92vw)', zIndex:65,
        background:'var(--hm-paper)', border:'1px solid var(--hm-line)', borderRadius:'var(--r-card)', boxShadow:'var(--sh-lift)', padding:'16px 17px' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:4 }}>
          <span className="font-display" style={{ fontWeight:700, fontSize:15 }}>Operating mode</span>
          <span style={{ fontSize:9, padding:'2px 7px', borderRadius:5, background:'var(--hm-paper-sunken)', color:'var(--hm-faint)', textTransform:'uppercase', fontWeight:700 }}>preview · not wired</span>
        </div>
        <p style={{ margin:'0 0 12px', fontSize:12.5, color:'var(--hm-muted)', lineHeight:1.5 }}>
          Supervised — agents propose, you approve every mutation, merge and deploy.
        </p>
        <div style={{ display:'grid', gap:7 }}>
          <div className="eyebrow" style={{ fontSize:9, color:'var(--hm-faint)' }}>This mode grants agents</div>
          {['observe','propose tasks','open PRs','run CI'].map(g => (
            <div key={g} style={{ display:'flex', alignItems:'center', gap:8, fontSize:12.5, color:'var(--hm-ink-2)' }}>
              <span style={{ color:'var(--ok-text)', flex:'none' }}>✓</span>{g}
            </div>
          ))}
          <div className="eyebrow" style={{ fontSize:9, color:'var(--hm-faint)', marginTop:6 }}>It restricts</div>
          {['merge','deploy','spend','touch prod data'].map(g => (
            <div key={g} style={{ display:'flex', alignItems:'center', gap:8, fontSize:12.5, color:'var(--hm-faint)' }}>
              <span style={{ flex:'none' }}>✕</span><span style={{ textDecoration:'line-through' }}>{g}</span>
            </div>
          ))}
        </div>
        <div style={{ marginTop:13, paddingTop:12, borderTop:'1px solid var(--hm-line-2)', fontSize:11, color:'var(--hm-faint)', lineHeight:1.5 }}>
          Switching modes and pausing agents need the real control backend — inert in this prototype.
        </div>
      </div>
    </>
  );
}
function StatusChip({ c }) {
  const primary = c.primary && c.count > 0;
  return (
    <span className="font-display" style={{
      flex:'none', display:'inline-flex', alignItems:'center', gap:8, height:30, padding:'0 12px',
      borderRadius:'var(--r-pill)', fontSize:11.5, fontWeight:700, textTransform:'uppercase',
      border:`1px solid ${primary ? 'var(--hm-line-strong)' : 'var(--hm-line)'}`,
      background: c.count>0 ? 'var(--hm-paper)' : 'transparent',
      color: c.count>0 ? 'var(--hm-ink-2)' : 'var(--hm-faint)' }}>
      {primary && <span style={{ width:6, height:6, borderRadius:'50%', background:'var(--act)', flex:'none' }} />}
      <span style={{ fontFamily:'var(--font-mono)', fontWeight:600, color: c.count>0?'var(--hm-ink)':'var(--hm-faint)' }}>{c.count}</span>
      {c.label}
    </span>
  );
}

/* ───────────────── needs-you banner — compact status bar with a primary action ───────────────── */
function NeedsYouBanner({ clock, onJump, wide, cards }) {
  cards = cards || window.HERMES_DATA.CARDS;
  const decisions = cards.filter(c => c.waitingOn === 'operator');
  const n = decisions.length;
  const urgent = decisions.find(c => c.urgent) || decisions[0];
  const [collapsed, setCollapsed] = React.useState(false);

  /* calm state (0 decisions) — single line */
  if (n === 0) {
    return (
      <div style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 16px',
        borderRadius:'var(--r-btn)', background:'var(--hm-paper)', border:'1px solid var(--ok-line)' }}>
        <span style={{ flex:'none', width:24, height:24, borderRadius:7, background:'var(--ok-soft)', display:'grid', placeItems:'center', color:'var(--ok-text)', fontSize:13 }}>✓</span>
        <span className="font-display" style={{ fontWeight:700, fontSize:14, color:'var(--ok-text)', flex:'none' }}>Nothing needs you</span>
        <span style={{ fontSize:13, color:'var(--hm-muted)' }}>Prod healthy · agents working — watch the lanes below.</span>
        <span className="mono" style={{ marginLeft:'auto', fontSize:11.5, color:'var(--hm-faint)', flex:'none' }}>{clock}</span>
      </div>
    );
  }

  /* collapsed by operator — single coral line */
  if (collapsed) {
    return (
      <button onClick={()=>setCollapsed(false)} style={{ width:'100%', textAlign:'left', display:'flex', alignItems:'center', gap:11,
        padding:'9px 14px', borderRadius:'var(--r-btn)', cursor:'pointer',
        background:'linear-gradient(120deg, var(--act-soft), transparent 70%, var(--hm-paper))', border:'1px solid var(--act-line)' }}>
        <span className="dot live-dot" style={{ width:7, height:7, borderRadius:'50%', background:'var(--act)', flex:'none' }} />
        <span className="font-display" style={{ fontWeight:700, fontSize:13.5, color:'var(--act-text)', flex:'none' }}>{n} waiting on you</span>
        <span style={{ fontSize:12.5, color:'var(--hm-muted)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
          most urgent: {urgent.title}
        </span>
        <span className="font-display" style={{ marginLeft:'auto', fontSize:11.5, fontWeight:600, color:'var(--hm-faint)', flex:'none' }}>expand ▾</span>
      </button>
    );
  }

  /* default — dense status bar: badge · one-line summary · chips · inline CTA */
  return (
    <div className="breathe" style={{ position:'relative', overflow:'hidden',
      padding:'15px 17px 14px 19px', borderRadius:'var(--r-card)',
      background:'linear-gradient(120deg, var(--act-soft), transparent 64%, var(--hm-paper))', border:'1px solid var(--act-line)' }}>
      <span style={{ position:'absolute', left:0, top:0, bottom:0, width:4, background:'var(--act)' }} />

      {/* row 1: badge + headline/context + inline CTA */}
      <div style={{ display:'flex', alignItems:'center', gap:14 }}>
        <div style={{ position:'relative', flex:'none', width:44, height:44, borderRadius:12, background:'var(--act-soft-2)',
          display:'grid', placeItems:'center', color:'var(--act-text)', fontFamily:'var(--font-display)', fontWeight:700, fontSize:21, boxShadow:'var(--act-glow)' }}>
          {n}
          <span className="breathe-ring" style={{ position:'absolute', inset:0, borderRadius:12, boxShadow:'0 0 0 2.5px var(--act)' }} />
        </div>

        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:3, minWidth:0 }}>
            <span className="dot live-dot" style={{ width:6, height:6, borderRadius:'50%', background:'var(--act)', flex:'none' }} />
            <h1 className="font-display" style={{ margin:0, fontWeight:700, fontSize:18, lineHeight:1.1, color:'var(--hm-ink)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', minWidth:0 }}>{n} decisions waiting on you</h1>
          </div>
          <div style={{ fontSize:12.5, color:'var(--hm-muted)', minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
            Most urgent: <strong style={{ color:'var(--hm-ink-2)', fontWeight:600 }}>{urgent.title}</strong>
            {urgent.decision && <> — suggests <span style={{ color:'var(--act-text)', fontWeight:600 }}>{urgent.decision.recommended}</span></>}
          </div>
        </div>

        <div style={{ display:'flex', alignItems:'center', gap:7, flex:'none' }}>
          <button className="btn btn--act btn--sm" onClick={onJump} style={{ whiteSpace:'nowrap' }}>Review most urgent ↵</button>
          <button onClick={()=>setCollapsed(true)} title="Collapse" aria-label="Collapse status bar"
            style={{ width:28, height:28, borderRadius:7, border:'1px solid var(--act-line)', background:'transparent', color:'var(--act-text)', cursor:'pointer', fontSize:12, lineHeight:1, flex:'none' }}>▴</button>
        </div>
      </div>

      {/* row 2: most-urgent-because chips */}
      {urgent.reasonChips && (
        <div style={{ display:'flex', alignItems:'center', gap:7, marginTop:12, paddingLeft:58, flexWrap:'wrap' }}>
          <span className="eyebrow" style={{ fontSize:8.5, color:'var(--hm-faint)', flex:'none' }}>most urgent because</span>
          {urgent.reasonChips.map((r,i) => (
            <span key={i} className="chip" style={{ padding:'2px 9px', fontSize:11, color:'var(--hm-ink-2)', flex:'none' }}>{r}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ───────────────── toolbar ───────────────── */
function Toolbar({ active, onFilter }) {
  const { FILTERS } = window.HERMES_DATA;
  return (
    <div style={{ display:'flex', alignItems:'center', gap:14, flexWrap:'wrap' }}>
      <div style={{ position:'relative', flex:'none', width:280 }}>
        <input placeholder="Search PR, repo, correlation" className="mono" style={{ width:'100%', height:38, padding:'0 36px 0 14px',
          borderRadius:'var(--r-btn)', border:'1px solid var(--hm-line)', background:'var(--hm-paper)', fontSize:12.5, color:'var(--hm-ink)', outline:'none' }} />
        <span className="chip" style={{ position:'absolute', right:7, top:7, padding:'2px 7px' }}>/</span>
      </div>
      <span style={{ fontSize:12.5, color:'var(--hm-muted)' }}>focus on the lane that needs you</span>
      <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:10 }}>
        <span style={{ fontSize:12, color:'var(--hm-faint)' }}>sorted by next-action urgency</span>
        <div style={{ display:'flex', gap:6 }}>
          {FILTERS.map(f => (
            <button key={f.id} onClick={() => onFilter(f.id)} className="font-display" style={{
              display:'inline-flex', alignItems:'center', gap:7, height:30, padding:'0 12px', borderRadius:'var(--r-pill)',
              cursor:'pointer', fontSize:12, fontWeight:600,
              border:`1px solid ${active===f.id ? 'transparent':'var(--hm-line)'}`,
              background: active===f.id ? 'var(--hm-ink)' : 'var(--hm-paper)',
              color: active===f.id ? 'var(--hm-paper)' : (f.count>0?'var(--hm-ink-2)':'var(--hm-faint)') }}>
              {f.label}<span className="mono" style={{ fontSize:11, opacity:0.8 }}>{f.count}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function UtilitiesRow() {
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12,
      padding:'10px 16px', borderRadius:'var(--r-btn)', background:'var(--hm-paper-sunken)', border:'1px solid var(--hm-line-2)' }}>
      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
        <span style={{ color:'var(--hm-faint)' }}>▸</span>
        <span className="font-display" style={{ fontWeight:600, fontSize:13 }}>Utilities</span>
        <span style={{ fontSize:13, color:'var(--hm-muted)' }}>LLM usage · suites · tester launcher</span>
      </div>
      <span className="mono" style={{ fontSize:12, color:'var(--hm-faint)' }}>17K tokens · no suites · tester ready</span>
    </div>
  );
}

/* ───────────────── tier heading ───────────────── */
function TierHead({ eyebrow, title, count, act, dim }) {
  return (
    <div style={{ display:'flex', alignItems:'flex-end', justifyContent:'space-between', gap:12, marginBottom:12, opacity: dim?0.72:1 }}>
      <div>
        {eyebrow && <Lab act={act} style={{ display:'block', marginBottom:4 }}>{eyebrow}</Lab>}
        <div className="font-display" style={{ fontWeight:700, fontSize:dim?15:17, color:dim?'var(--hm-muted)':'var(--hm-ink)' }}>{title}</div>
      </div>
      {count!=null && <span className="eyebrow" style={{ flex:'none' }}><CountTween value={count} /> cards</span>}
    </div>
  );
}

/* ───────────────── DECIDE ───────────────── */
function DecideTier({ onOpenCard, expandedId, setExpandedId }) {
  const { DECIDE } = window.HERMES_DATA;
  return (
    <section data-screen-label="DECIDE">
      <TierHead eyebrow={DECIDE.eyebrow} title={DECIDE.title} count={DECIDE.cards.length} act />
      <div style={{ background:'linear-gradient(180deg, rgba(217,119,87,0.05), transparent 40%)',
        border:'1px solid var(--act-line)', borderRadius:'var(--r-lane)', padding:'var(--pad-lane)' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <span className="font-display" style={{ fontWeight:700, fontSize:15, whiteSpace:'nowrap' }}>{DECIDE.lane.name}</span>
            <Pill tone="act" style={{ minHeight:20, height:20, fontSize:10 }}>{DECIDE.cards.length}</Pill>
          </div>
          <Lab act>{DECIDE.lane.sub}</Lab>
        </div>
        <div style={{ display:'grid', gap:'var(--gap-cards)' }}>
          {DECIDE.cards.map(card => (
            <DecideCard key={card.id} card={card}
              expanded={expandedId===card.id}
              onToggle={() => setExpandedId(expandedId===card.id ? null : card.id)}
              onOpen={() => onOpenCard(card.id)} />
          ))}
        </div>
      </div>
    </section>
  );
}

function DecideCard({ card, expanded, onToggle, onOpen }) {
  return (
    <article id={card.id} className={cx('anim-slide hover-lift', card.urgent && expanded && 'breathe')} style={{
      background:'var(--hm-paper)', borderRadius:'var(--r-card)', border:'1px solid var(--hm-line)',
      borderLeft:`3px solid ${expanded ? 'var(--act)' : 'var(--hm-line)'}`, boxShadow:'var(--sh-sm)', overflow:'hidden' }}>
      <div className="click" onClick={onToggle} style={{ padding:'var(--pad-card)' }}>
        <AuthorLine authorId={card.author} mono={card.id} freshness={card.freshness} />
        <h3 className="font-display" style={{ margin:'12px 0 6px', fontSize:19, fontWeight:700 }}>{card.title}</h3>
        <div style={{ fontSize:14, color:'var(--warn-text)', fontWeight:500 }}>{card.status}</div>

        <div style={{ display:'flex', alignItems:'center', gap:10, marginTop:14, flexWrap:'wrap' }}>
          <Lab>Tester run</Lab>
          <Pill tone="warn" dot>{card.tester.verdict} {card.tester.pct}</Pill>
          <span className="mono" style={{ fontSize:12, color:'var(--hm-muted)' }}>{card.tester.target}</span>
        </div>

        <div style={{ marginTop:12 }}>
          <Lab style={{ display:'block', marginBottom:5 }}>{card.blocker.label}</Lab>
          <div style={{ display:'inline-flex', alignItems:'center', gap:8, padding:'7px 12px', borderRadius:'var(--r-sm)',
            background:'var(--warn-soft)', border:'1px solid var(--warn-line)' }}>
            <span style={{ width:7, height:7, borderRadius:'50%', background:'var(--warn)' }} />
            <span className="font-display" style={{ fontSize:12.5, fontWeight:600, textTransform:'uppercase', color:'var(--warn-text)', whiteSpace:'nowrap' }}>{card.blocker.value}</span>
          </div>
        </div>

        <div style={{ display:'flex', gap:7, marginTop:12, flexWrap:'wrap' }}>
          {card.chips.map((c,i) => <span key={i} className="chip">{c}</span>)}
        </div>
        <p style={{ margin:'12px 0 0', fontSize:13.5, color:'var(--hm-muted)', display:'-webkit-box', WebkitLineClamp:expanded?99:2, WebkitBoxOrient:'vertical', overflow:'hidden' }}>{card.body}</p>
      </div>

      {expanded && (
        <div className="anim-rise" style={{ padding:'0 var(--pad-card) var(--pad-card)' }}>
          {/* agent discussion */}
          <div style={{ background:'var(--hm-paper-sunken)', border:'1px solid var(--hm-line-2)', borderRadius:'var(--r-sm)', padding:'12px 14px', marginBottom:14 }}>
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
              <PresenceDot presence="active" color={AGENTS.hermes.color} size={8} />
              <Lab>Agent discussion</Lab>
            </div>
            <div style={{ display:'flex', gap:10 }}>
              <AgentAvatar agent={AGENTS[card.discussion.author]} size={26} />
              <div style={{ minWidth:0 }}>
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <span className="font-display" style={{ fontWeight:600, fontSize:13, color:AGENTS[card.discussion.author].color }}>{AGENTS[card.discussion.author].name}</span>
                  <span className="mono" style={{ fontSize:11, color:'var(--hm-faint)' }}>{card.discussion.time}</span>
                </div>
                <p style={{ margin:'4px 0 0', fontSize:13.5, color:'var(--hm-ink-2)', lineHeight:1.6 }}>{card.discussion.text}</p>
                <span className="chip" style={{ marginTop:9 }}>testbed</span>
              </div>
            </div>
          </div>

          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
            <Lab>Waiting on</Lab>
            <Pill tone="act" dot style={{ minHeight:22 }}>→ Operator</Pill>
          </div>

          <div className="focus-row" style={{ display:'grid', gridTemplateColumns:'1.2fr 1fr 1fr', gap:9, marginBottom:12 }}>
            {card.actions.map(a => (
              <button key={a.id} className={cx('btn', a.kind==='act'?'btn--act':'btn--ghost')}>{a.label}</button>
            ))}
          </div>

          <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px', borderRadius:'var(--r-sm)',
            background:'var(--ok-soft)', border:'1px solid var(--ok-line)' }}>
            <Lab style={{ color:'var(--ok-text)' }}>Hermes verdict</Lab>
            <span style={{ fontSize:13.5, color:'var(--ok-text)', fontWeight:500 }}>{card.verdict}</span>
            <button className="btn btn--sm" onClick={(e)=>{e.stopPropagation();onOpen();}} style={{ marginLeft:'auto', background:'transparent', color:'var(--ok-text)', border:'1px solid var(--ok-line)' }}>Open card ↗</button>
          </div>
        </div>
      )}

      {!expanded && (
        <div className="click" onClick={onToggle} style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
          padding:'10px var(--pad-card)', borderTop:'1px solid var(--hm-line-2)', background:'var(--hm-paper-sunken)' }}>
          <span style={{ display:'flex', alignItems:'center', gap:8 }}>
            <Lab>Waiting on</Lab><Pill tone="act" style={{ minHeight:20, height:20, fontSize:10 }}>→ Operator</Pill>
          </span>
          <span className="font-display" style={{ fontSize:12.5, fontWeight:600, color:'var(--act-text)' }}>Expand to decide ↓</span>
        </div>
      )}
    </article>
  );
}

window.Board = { TopBar, ControlsSheet, NeedsYouBanner, Toolbar, TierHead, DecideTier, AuthorLine };
