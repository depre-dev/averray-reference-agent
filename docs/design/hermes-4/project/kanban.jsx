/* Hermes — pipeline kanban + Decision Inbox
   DECIDE inbox = union of all waitingOn==='operator' cards (the ONE place to act).
   WATCH/HIDE lanes show the same cards in pipeline position, READ-ONLY.
   Badge families (G): state · risk · evidence · gate. Coral only on the single
   most-urgent recommended action (K). */
const { AGENTS: AGK, LANES, EVIDENCE_LABEL } = window.HERMES_DATA;

const TIER_META = {
  decide: { label:'Decide', text:'var(--tier-decide-text)', headBg:'var(--tier-decide-bg)', line:'var(--tier-decide-line)', countBg:'var(--act)', countFg:'var(--act-ink)' },
  watch:  { label:'Watch',  text:'var(--hm-muted)', headBg:'var(--hm-paper-sunken)', line:'var(--hm-line)', countBg:'var(--hm-ink)', countFg:'var(--hm-paper)' },
  hide:   { label:'Hide',   text:'var(--hm-faint)', headBg:'var(--hm-surface)', line:'var(--hm-line-2)', countBg:'var(--hm-faint)', countFg:'var(--hm-paper)' },
};
const STATE_TONE = { failed:'warn', blocked:'warn', running:'ok', ready:'ok', done:'tel' };
const RISK_TONE  = { low:'tel', med:'warn', high:'warn' };
const CLASS_COLOR = { Product:'var(--ag-claude)', Test:'var(--ag-test)', Infra:'var(--warn)', Agent:'var(--ag-codex)', Policy:'var(--ag-hermes)', Unknown:'var(--hm-faint)' };
const STAGE_ORDER = ['codex','checking','opreview','queue','deploying','done'];
const SEED_CHECKPOINTS = () => ([
  { label:'CI queued', state:'current' }, { label:'install', state:'todo' }, { label:'unit tests', state:'todo' },
  { label:'browser replay', state:'todo' }, { label:'Hermes review', state:'todo' }, { label:'ready', state:'todo' },
]);

const motionOn = () =>
  document.documentElement.getAttribute('data-motion') !== 'off' &&
  !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

/* ───────── G: 4 badge families ───────── */
/* per-state glyph so state is distinguishable WITHOUT color (a11y #8) */
const STATE_GLYPH = { failed:'✕', blocked:'▢', running:'◐', ready:'▲', done:'✓' };
function StatePill({ s }) {
  const tone = STATE_TONE[s.kind] || 'tel';
  const glyph = STATE_GLYPH[s.kind] || '·';
  return (
    <Pill tone={tone} style={{ minHeight:20, height:20, fontSize:10, gap:5 }}>
      <span aria-hidden="true" style={{ fontSize:9, lineHeight:1, flex:'none' }}>{glyph}</span>{s.label}
    </Pill>
  );
}
function RiskPill({ risk }) {
  // shape encodes level without relying on color (a11y #8)
  const mark = risk.level==='high' ? '◆' : risk.level==='med' ? '◣' : '○';
  return (
    <Pill tone={RISK_TONE[risk.level]||'tel'} style={{ minHeight:20, height:20, fontSize:10, gap:5 }}>
      <span aria-hidden="true" style={{ fontSize:8.5, lineHeight:1, flex:'none' }}>{mark}</span>
      Risk: {risk.level}{risk.type?` · ${risk.type}`:''}
    </Pill>
  );
}
function EvidenceChips({ evidence }) {
  return <>{evidence.map((e,i) => {
    const fn = EVIDENCE_LABEL[e.k]; const label = fn ? fn(e.n) : e.k;
    return <span key={i} className="chip" style={{ padding:'2px 7px', fontSize:10, gap:4 }}>{label}</span>;
  })}</>;
}
function GatePill({ gate }) {
  const map = { operator:{ c:'var(--act)', t:'needs you' }, agent:{ c:'var(--ag-claude)', t:'agent' }, system:{ c:'var(--hm-faint)', t:'system' } };
  const g = map[gate] || map.system;
  return (
    <span className="chip" style={{ padding:'2px 8px', fontSize:9.5, gap:5, textTransform:'uppercase', fontFamily:'var(--font-display)', fontWeight:700, color:'var(--hm-muted)' }}>
      <span style={{ width:6, height:6, borderRadius:'50%', background:g.c, flex:'none' }} />{g.t}
    </span>
  );
}
function Badges({ card, show }) {
  show = show || ['state','risk','evidence','gate'];
  return (
    <div style={{ display:'flex', gap:5, flexWrap:'wrap', marginTop:10, alignItems:'center' }}>
      {show.includes('state') && card.state && <StatePill s={card.state} />}
      {show.includes('risk') && card.risk && <RiskPill risk={card.risk} />}
      {show.includes('evidence') && card.evidence && <EvidenceChips evidence={card.evidence} />}
      {show.includes('gate') && card.gate && <GatePill gate={card.gate} />}
    </div>
  );
}

/* ───────── D: failure class chip ───────── */
function FailureClass({ card }) {
  if (!card.failureClass) return null;
  return (
    <span className="chip" style={{ padding:'2px 8px', fontSize:9.5, gap:5, textTransform:'uppercase', fontFamily:'var(--font-display)', fontWeight:700, color:'var(--hm-ink-2)' }}>
      <span style={{ width:6, height:6, borderRadius:'50%', background:CLASS_COLOR[card.failureClass]||'var(--hm-faint)', flex:'none' }} />
      {card.failureClass}
    </span>
  );
}

/* ───────── C: why am I seeing this / unblock ───────── */
function WhySeeing({ card }) {
  if (!card.whySeeing && !card.unblock) return null;
  return (
    <div style={{ marginTop:10, display:'grid', gap:6 }}>
      {card.whySeeing && (
        <div style={{ display:'flex', gap:7, fontSize:12, color:'var(--hm-muted)', lineHeight:1.5 }}>
          <span style={{ flex:'none', color:'var(--hm-faint)' }}>?</span>
          <span><span style={{ fontWeight:600, color:'var(--hm-ink-2)' }}>Why you’re seeing this · </span>{card.whySeeing}</span>
        </div>
      )}
      {card.unblock && (
        <div style={{ display:'flex', gap:7, fontSize:12, color:'var(--hm-muted)', lineHeight:1.5 }}>
          <span style={{ flex:'none', color:'var(--ok-text)' }}>→</span>
          <span><span style={{ fontWeight:600, color:'var(--ok-text)' }}>Unblock · </span>{card.unblock}</span>
        </div>
      )}
    </div>
  );
}

/* ───────── E: checkpoint stepper (replaces progress bar) ───────── */
function CheckpointStepper({ steps }) {
  return (
    <div style={{ marginTop:12, display:'flex', flexDirection:'column', gap:7 }}>
      {steps.map((s,i) => {
        const done = s.state==='done', cur = s.state==='current';
        return (
          <div key={i} style={{ display:'flex', alignItems:'center', gap:9, opacity: s.state==='todo'?0.5:1 }}>
            <span style={{ width:15, height:15, borderRadius:'50%', flex:'none', display:'grid', placeItems:'center',
              background: done?'var(--ok)':(cur?'var(--ok-soft)':'transparent'),
              border: done?'none':`1.5px solid ${cur?'var(--ok)':'var(--hm-line-strong)'}`,
              color:'var(--act-ink)', fontSize:9 }}>
              {done ? '✓' : (cur ? <span className="live-dot" style={{ width:6, height:6, borderRadius:'50%', background:'var(--ok)' }} /> : '')}
            </span>
            <span className="font-display" style={{ fontSize:12, fontWeight: cur?700:500,
              color: cur?'var(--ok-text)':(done?'var(--hm-ink-2)':'var(--hm-muted)') }}>{s.label}</span>
            {cur && <span className="mono" style={{ marginLeft:'auto', fontSize:9.5, color:'var(--hm-faint)' }}>in progress</span>}
          </div>
        );
      })}
    </div>
  );
}

/* ───────── meta + title (shared) ───────── */
function CardMeta({ card }) {
  const a = AGK[card.author] || AGK.system;
  return (
    <div style={{ display:'flex', alignItems:'center', gap:6, minWidth:0 }}>
      <PresenceDot presence={a.presence} color={a.color} size={7} ring={false} />
      <span className="font-display" style={{ fontWeight:600, fontSize:12, color:a.color, whiteSpace:'nowrap', flex:'none' }}>{a.name}</span>
      {card.type && <>
        <span style={{ color:'var(--hm-faint)', flex:'none' }}>·</span>
        <span className="mono" style={{ fontSize:10.5, color:'var(--hm-muted)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{card.type}</span>
      </>}
      {card.freshness && <span className="font-display" style={{ marginLeft:'auto', flex:'none', fontSize:10, fontWeight:700, textTransform:'uppercase', color:'var(--hm-faint)' }}>{card.freshness}</span>}
    </div>
  );
}

/* ───────── B: decision bundle ───────── */
function BundleRow({ label, children, danger }) {
  return (
    <div style={{ display:'grid', gridTemplateColumns:'92px 1fr', gap:10, padding:'7px 0', borderTop:'1px solid var(--hm-line-2)' }}>
      <span className="eyebrow" style={{ fontSize:9, color:'var(--hm-faint)', paddingTop:1 }}>{label}</span>
      <div style={{ fontSize:12.5, color: danger?'var(--warn-text)':'var(--hm-ink-2)', lineHeight:1.5 }}>{children}</div>
    </div>
  );
}
function DecisionBundle({ card, urgent, onAction, onOpenReplay, onAskHermes }) {
  const d = card.decision; if (!d) return null;
  const choiceKind = (c) => {
    const a = c.toLowerCase();
    if (/approve|dispatch|rerun/.test(a)) return 'act';
    if (/reject|dismiss|hold/.test(a)) return 'ghost';
    return 'soft';
  };
  return (
    <div className="anim-rise" style={{ marginTop:12, borderRadius:'var(--r-sm)', background:'var(--hm-paper-sunken)', border:'1px solid var(--hm-line-2)', padding:'12px 14px' }}>
      {/* recommended */}
      <div style={{ display:'flex', alignItems:'flex-start', gap:9 }}>
        <span style={{ flex:'none', marginTop:1, width:18, height:18, borderRadius:'50%', display:'grid', placeItems:'center',
          background: urgent?'var(--act-soft-2)':'var(--ok-soft)', color: urgent?'var(--act-text)':'var(--ok-text)', fontSize:11 }}>★</span>
        <div style={{ minWidth:0 }}>
          <div className="eyebrow" style={{ fontSize:9, color:'var(--hm-faint)' }}>Hermes recommends</div>
          <div className="font-display" style={{ fontSize:14, fontWeight:700, color:'var(--hm-ink)', marginTop:2 }}>{d.recommended}</div>
          <div style={{ fontSize:12, color:'var(--hm-muted)', marginTop:3, lineHeight:1.5 }}>{d.why}</div>
        </div>
      </div>

      <div style={{ marginTop:10 }}>
        <BundleRow label="Risk">
          <span style={{ fontWeight:600, color: card.risk && card.risk.level!=='low' ? 'var(--warn-text)' : 'var(--hm-ink-2)' }}>
            {card.risk ? `${card.risk.type} · ${card.risk.level}` : '—'}
          </span>
        </BundleRow>
        <BundleRow label="Grants">{d.grants}</BundleRow>
        <BundleRow label="Does not" danger>{d.denies}</BundleRow>
        <BundleRow label="Blast radius">
          <span className="mono" style={{ fontSize:11.5 }}>
            {d.blast.repo} · {d.blast.branch} · {d.blast.env} · {d.blast.area} · users: {d.blast.users}
          </span>
        </BundleRow>
        <BundleRow label="Rollback">{d.rollback}</BundleRow>
        <BundleRow label="Evidence">
          <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
            {(card.evidence||[]).map((e,i)=>{ const fn=EVIDENCE_LABEL[e.k]; return (
              <button key={i} onClick={(ev)=>{ev.stopPropagation(); onOpenReplay&&onOpenReplay();}} className="chip click" style={{ padding:'2px 8px', fontSize:10.5, color:'var(--hm-ink-2)' }}>{fn?fn(e.n):e.k} ↗</button>
            );})}
            {(!card.evidence||!card.evidence.length) && <span style={{ fontSize:11.5, color:'var(--hm-faint)' }}>none yet</span>}
          </div>
        </BundleRow>
      </div>

      {/* choices — recommended is primary (coral only when urgent, K); rest are alternatives */}
      <div style={{ display:'flex', gap:7, flexWrap:'wrap', marginTop:12, alignItems:'center' }}>
        <button onClick={(e)=>{ e.stopPropagation(); onAction && onAction(d.recommended); }}
          className={cx('btn btn--sm', urgent ? 'btn--act' : '')}
          style={ urgent ? undefined : { background:'var(--hm-ink)', color:'var(--hm-paper)', border:'1px solid transparent' } }>
          {d.recommended}
        </button>
        {d.choices.filter(c => c.toLowerCase().split(' ')[0] !== d.recommended.toLowerCase().split(' ')[0]).map((c,i) => {
          const a = c.toLowerCase();
          const kind = /reject|dismiss|hold/.test(a) ? 'ghost' : 'soft';
          const onClick = (ev) => {
            ev.stopPropagation();
            if (/ask hermes/.test(a)) return onAskHermes && onAskHermes();
            if (/replay/.test(a)) return onOpenReplay && onOpenReplay();
            onAction && onAction(c);
          };
          return <button key={i} onClick={onClick} className={cx('btn btn--sm', kind==='ghost'?'btn--ghost':'btn--soft')}>{c}</button>;
        })}
      </div>
    </div>
  );
}

/* ───────── Inbox card (actionable) ───────── */
function InboxCard({ card, urgent, expanded, onToggle, onAction, onOpen, onOpenReplay, onAskHermes, justArrived }) {
  return (
    <article data-flip-id={card.id} className={cx('kcard', justArrived && 'flash-in', urgent && expanded && 'breathe')}
      style={{ position:'relative', background:'var(--hm-paper)', borderRadius:'var(--r-card)', border:'1px solid var(--hm-line)',
        borderLeft:`3px solid ${urgent?'var(--act)':'var(--hm-line-strong)'}`, boxShadow:'var(--sh-sm)', padding:'var(--pad-card)' }}>
      <div className="click" onClick={onToggle}>
        <CardMeta card={card} />
        <h4 className="font-display" style={{ margin:'10px 0 0', fontSize:15.5, fontWeight:700, lineHeight:1.25, color:'var(--hm-ink)', textWrap:'pretty' }}>{card.title}</h4>
        {card.repo && <div className="mono" style={{ fontSize:11.5, color:'var(--hm-muted)', marginTop:5, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{card.repo}</div>}
        <div style={{ display:'flex', gap:5, flexWrap:'wrap', marginTop:10, alignItems:'center' }}>
          {card.state && <StatePill s={card.state} />}
          {card.risk && <RiskPill risk={card.risk} />}
          <FailureClass card={card} />
          {card.dedupe && <span className="chip" style={{ padding:'2px 8px', fontSize:9.5, color:'var(--hm-faint)' }} title="dedupe needs real data — unconfirmed">⊘ {card.dedupe.label}</span>}
        </div>
        <WhySeeing card={card} />
      </div>

      {expanded
        ? <DecisionBundle card={card} urgent={urgent} onAction={(c)=>onAction(card.id,c)} onOpenReplay={()=>onOpenReplay(card.id)} onAskHermes={()=>onAskHermes(card.id)} />
        : (
          <>
            {card.whatNext && (
              <div style={{ display:'flex', gap:7, marginTop:11, fontSize:11.5, color:'var(--hm-muted)', lineHeight:1.5 }}>
                <span aria-hidden="true" style={{ flex:'none', color:'var(--hm-faint)' }}>↳</span>
                <span><span style={{ fontWeight:600, color:'var(--hm-ink-2)' }}>What happens next · </span>{card.whatNext}</span>
              </div>
            )}
            <div style={{ display:'flex', alignItems:'center', gap:9, marginTop:12 }}>
              <button onClick={(e)=>{e.stopPropagation(); onAction(card.id, card.decision.recommended);}}
                className={cx('btn btn--sm', urgent?'btn--act':'')}
                style={ urgent ? { flex:1 } : { flex:1, background:'var(--hm-ink)', color:'var(--hm-paper)', border:'1px solid transparent' } }>
                {card.decision.recommended}
              </button>
              <button onClick={(e)=>{e.stopPropagation(); onToggle();}} className="btn btn--ghost btn--sm">Choices ↓</button>
            </div>
          </>
        )}
    </article>
  );
}

/* ───────── read-only pipeline card (WATCH / HIDE) ───────── */
function PipelineCard({ card, onOpen, onGoInbox, justArrived }) {
  const running = card.state && card.state.kind === 'running';
  const dim = card.stage === 'done';
  return (
    <article data-flip-id={card.id} onClick={onOpen}
      className={cx('kcard', running && 'shimmer', justArrived && 'flash-in', 'click')}
      style={{ position:'relative', background:'var(--hm-paper)', borderRadius:'var(--r-card)', border:'1px solid var(--hm-line)',
        boxShadow:'var(--sh-sm)', padding:'var(--pad-card)', opacity: dim?0.74:1, filter: dim?'saturate(0.8)':'none' }}>
      <CardMeta card={card} />
      <h4 className="font-display" style={{ margin:'10px 0 0', fontSize:15, fontWeight:700, lineHeight:1.25, color:'var(--hm-ink)', textWrap:'pretty' }}>{card.title}</h4>
      {card.repo && <div className="mono" style={{ fontSize:11.5, color:'var(--hm-muted)', marginTop:5, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{card.repo}</div>}
      {running && card.checkpoints
        ? <CheckpointStepper steps={card.checkpoints} />
        : <Badges card={card} show={dim?['state']:['state','risk','gate']} />}
      {/* read-only mirror: NOT a place to act — a quiet label pointing to the inbox (#1) */}
      {card.waitingOn === 'operator' && (
        <button onClick={(e)=>{e.stopPropagation(); onGoInbox();}}
          aria-label="This item awaits your decision in the Decision Inbox — jump to it"
          style={{ width:'100%', marginTop:12, display:'flex', alignItems:'center', gap:7, padding:'7px 10px',
            borderRadius:'var(--r-sm)', background:'transparent', border:'1px dashed var(--hm-line)', cursor:'pointer', textAlign:'left' }}>
          <span aria-hidden="true" style={{ width:6, height:6, borderRadius:'50%', background:'var(--act)', flex:'none' }} />
          <span style={{ fontSize:11.5, color:'var(--hm-muted)' }}>Awaiting your decision · in inbox</span>
          <span className="font-display" style={{ marginLeft:'auto', fontSize:11, fontWeight:600, color:'var(--hm-faint)', flex:'none' }}>jump ›</span>
        </button>
      )}
    </article>
  );
}

/* ───────── codex composer ───────── */
function ColComposer({ onAskHermes }) {
  const [open, setOpen] = React.useState(false);
  if (!open) return <button onClick={()=>setOpen(true)} className="btn btn--soft btn--sm" style={{ width:'100%', marginBottom:'var(--gap-cards)', borderStyle:'dashed' }}>+ Propose task</button>;
  return (
    <div style={{ background:'var(--hm-paper)', border:'1px solid var(--hm-line-2)', borderRadius:'var(--r-card)', padding:12, marginBottom:'var(--gap-cards)' }}>
      <div style={{ display:'flex', gap:6, marginBottom:8 }}>
        <select className="font-display" style={{ height:32, padding:'0 8px', borderRadius:'var(--r-sm)', border:'1px solid var(--hm-line)', background:'var(--hm-paper-sunken)', fontSize:12, fontWeight:600, color:'var(--hm-ink)' }}>
          <option>claude</option><option>codex</option>
        </select>
        <input placeholder="owner/repo" className="mono" style={{ flex:1, minWidth:0, height:32, padding:'0 10px', borderRadius:'var(--r-sm)', border:'1px solid var(--hm-line)', background:'var(--hm-paper-sunken)', fontSize:12, color:'var(--hm-ink)', outline:'none' }} />
      </div>
      <textarea placeholder="Describe the task…" rows={2} style={{ width:'100%', padding:'8px 10px', borderRadius:'var(--r-sm)', border:'1px solid var(--hm-line)', background:'var(--hm-paper-sunken)', fontSize:12.5, fontFamily:'var(--font-body)', color:'var(--hm-ink)', resize:'none', outline:'none' }} />
      <div style={{ display:'flex', gap:8, marginTop:9 }}>
        <button className="btn btn--soft btn--sm" style={{ flex:1, background:'var(--hm-ink)', color:'var(--hm-paper)', border:'1px solid transparent' }}>Propose</button>
        <button onClick={()=>setOpen(false)} className="btn btn--soft btn--sm">Cancel</button>
      </div>
      <p style={{ margin:'8px 0 0', fontSize:11, color:'var(--hm-faint)' }}>Lands proposed — it appears in Your decisions before any runner claims it.</p>
    </div>
  );
}

/* ───────── column ───────── */
function Column({ lane, cards, isInbox, onAction, onOpen, onOpenReplay, onAskHermes, onCollapse, onGoInbox, arrivedId, expandedId, setExpandedId }) {
  const tm = TIER_META[lane.tier];
  const urgentId = isInbox ? (cards.find(c=>c.urgent) ? cards.find(c=>c.urgent).id : (cards[0]&&cards[0].id)) : null;
  return (
    <section data-screen-label={lane.name} style={{
      flex: isInbox ? '1.25 1 0' : '1 1 0',
      minWidth: isInbox ? 'min(320px, 82vw)' : 'min(266px, 78vw)',
      maxWidth: isInbox ? 470 : 420,
      alignSelf:'stretch',
      height:'100%',
      display:'flex', flexDirection:'column', minHeight:0,
      background:'var(--hm-surface)', border:`1px solid ${tm.line}`, borderRadius:'var(--r-lane)', overflow:'hidden',
      boxShadow: isInbox?'var(--sh-sm)':'none' }}>
      <header style={{ flex:'none', padding:'12px 14px 11px', background: tm.headBg, borderBottom:`1px solid ${tm.line}` }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <span className="eyebrow" style={{ color: tm.text, fontSize:9.5 }}>{isInbox?'Decision inbox':tm.label}</span>
          {!isInbox && <button onClick={onCollapse} title="Collapse" style={{ width:22, height:22, borderRadius:6, border:'1px solid var(--hm-line)', background:'var(--hm-paper)', color:'var(--hm-muted)', cursor:'pointer', fontSize:12, lineHeight:1, flex:'none' }}>‹</button>}
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:6 }}>
          <span className="font-display" style={{ fontWeight:700, fontSize:15, whiteSpace:'nowrap' }}>{lane.name}</span>
          <span className="font-display" style={{ minWidth:20, height:20, padding:'0 6px', borderRadius:'var(--r-pill)',
            background: cards.length? tm.countBg : 'var(--hm-paper-sunken)', color: cards.length? tm.countFg : 'var(--hm-faint)',
            display:'grid', placeItems:'center', fontSize:11, fontWeight:700 }}>
            <CountTween value={cards.length} />
          </span>
        </div>
        <div className="eyebrow" style={{ marginTop:4, color:'var(--hm-faint)', fontSize:9.5 }}>{lane.sub}</div>
      </header>
      <div className="scroll-y" style={{ flex:'1 1 auto', minHeight:0, padding:'var(--pad-lane)', display:'flex', flexDirection:'column', gap:'var(--gap-cards)' }}>
        {lane.id==='codex' && <ColComposer onAskHermes={onAskHermes} />}
        {cards.length === 0 && (
          <div style={{ display:'flex', alignItems:'center', gap:10, padding:'12px 12px', borderRadius:'var(--r-sm)',
            border:'1px dashed var(--hm-line)', background:'var(--hm-paper-sunken)' }}>
            <span aria-hidden="true" style={{ width:24, height:24, borderRadius:7, flex:'none', display:'grid', placeItems:'center',
              background: isInbox?'var(--ok-soft)':'var(--hm-paper)', color: isInbox?'var(--ok-text)':'var(--hm-faint)', fontSize:13 }}>{isInbox?'✓':'·'}</span>
            <div style={{ minWidth:0 }}>
              <div className="font-display" style={{ fontSize:12.5, fontWeight:600, color: isInbox?'var(--ok-text)':'var(--hm-muted)' }}>{isInbox?'Nothing waiting on you':'No cards'}</div>
              <div style={{ fontSize:11, color:'var(--hm-faint)', marginTop:1 }}>{isInbox?'agents are working — watch the lanes':'nothing in this stage'}</div>
            </div>
          </div>
        )}
        {cards.map(card => isInbox
          ? <InboxCard key={card.id} card={card} urgent={card.id===urgentId}
              expanded={expandedId===card.id} onToggle={()=>setExpandedId(expandedId===card.id?null:card.id)}
              onAction={onAction} onOpen={()=>onOpen(card.id)} onOpenReplay={onOpenReplay} onAskHermes={onAskHermes}
              justArrived={arrivedId===card.id} />
          : <PipelineCard key={card.id} card={card} onOpen={()=>onOpen(card.id)} onGoInbox={onGoInbox} justArrived={arrivedId===card.id} />
        )}
      </div>
    </section>
  );
}

/* ───────── collapsed rail (gate lanes only; empty non-gate hides fully — K) ───────── */
function Rail({ lane, count, onExpand }) {
  const tm = TIER_META[lane.tier];
  return (
    <button onClick={onExpand} className="krail" style={{ flex:'none', width:50, alignSelf:'stretch',
      background:'var(--hm-surface)', border:`1px ${count?'solid':'dashed'} ${tm.line}`, borderRadius:'var(--r-lane)',
      display:'flex', flexDirection:'column', alignItems:'center', gap:14, padding:'14px 6px', cursor:'pointer' }}>
      <span className="font-display" style={{ minWidth:22, height:22, padding:'0 5px', borderRadius:'var(--r-pill)',
        background: count? tm.countBg : 'transparent', color: count? tm.countFg : 'var(--hm-faint)',
        border: count? 'none':`1px solid ${tm.line}`, display:'grid', placeItems:'center', fontSize:11, fontWeight:700 }}>{count}</span>
      <span className="font-display" style={{ writingMode:'vertical-rl', transform:'rotate(180deg)', fontSize:11.5, fontWeight:700, textTransform:'uppercase', color: tm.text, whiteSpace:'nowrap' }}>{lane.name}</span>
      {lane.gate && <span className="eyebrow" style={{ writingMode:'vertical-rl', transform:'rotate(180deg)', fontSize:8, color:'var(--act-text)', marginTop:'auto' }}>gate</span>}
    </button>
  );
}

/* ───────── the row ───────── */
function KanbanRow({ cards, decide, arrivedId, onOpenCard, onOpenReplay, onAskHermes }) {
  const [collapsed, setCollapsed] = React.useState(() => new Set(['queue']));
  const [expandedId, setExpandedId] = React.useState(null);
  const positions = React.useRef(new Map());
  const goInbox = () => setExpandedId(null);

  // first-mount: auto-expand the most-urgent inbox card
  React.useEffect(() => {
    const inbox = cards.filter(c=>c.waitingOn==='operator');
    const urgent = inbox.find(c=>c.urgent) || inbox[0];
    if (urgent) setExpandedId(urgent.id);
  }, []);

  // generic FLIP — animate any card whose position changed between commits
  React.useLayoutEffect(() => {
    const seen = new Set();
    document.querySelectorAll('[data-flip-id]').forEach(el => {
      const id = el.getAttribute('data-flip-id'); seen.add(id);
      const r = el.getBoundingClientRect();
      const prev = positions.current.get(id);
      positions.current.set(id, r);
      if (!prev || !motionOn()) return;
      const dx = prev.left - r.left, dy = prev.top - r.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      const arriving = id === arrivedId;
      const travelled = Math.hypot(dx, dy);
      el.style.transition = 'none';
      el.style.transform = arriving ? `translate(${dx}px,${dy}px) scale(1.06)` : `translate(${dx}px,${dy}px)`;
      if (arriving) { el.style.zIndex='8'; el.style.boxShadow='var(--sh-lift)'; } else el.style.zIndex='5';
      requestAnimationFrame(() => {
        const dur = arriving ? Math.min(780, 500 + travelled*0.55) : 420;
        const spring = arriving ? 'cubic-bezier(.34,1.62,.4,1)' : 'cubic-bezier(.2,.7,.2,1)';
        el.style.transition = `transform ${dur}ms ${spring}, box-shadow ${dur}ms ease`;
        el.style.transform = '';
        if (arriving) el.style.boxShadow='';
        setTimeout(()=>{ el.style.zIndex=''; el.style.transition=''; el.style.boxShadow=''; }, dur+40);
      });
    });
    for (const id of [...positions.current.keys()]) if (!seen.has(id)) positions.current.delete(id);
  });

  const expand = (id) => setCollapsed(prev => { const n=new Set(prev); n.delete(id); return n; });
  const collapse = (id) => setCollapsed(prev => new Set(prev).add(id));

  const cardsFor = (lane) => lane.inbox
    ? cards.filter(c => c.waitingOn === 'operator')
    : cards.filter(c => c.stage === lane.id);

  return (
    <div className="scroll-x" style={{ height:'100%', display:'flex', gap:12, padding:'2px 22px 16px', alignItems:'flex-start' }}>
      {LANES.map(lane => {
        const laneCards = cardsFor(lane);
        // K: empty non-gate lane hides fully; gate lane stays (as rail if collapsed)
        if (!lane.inbox && laneCards.length === 0 && !lane.gate) return null;
        const isCollapsed = !lane.inbox && collapsed.has(lane.id);
        if (isCollapsed) return <Rail key={lane.id} lane={lane} count={laneCards.length} onExpand={()=>expand(lane.id)} />;
        return (
          <Column key={lane.id} lane={lane} cards={laneCards} isInbox={!!lane.inbox}
            onAction={decide} onOpen={onOpenCard} onOpenReplay={onOpenCard} onAskHermes={onAskHermes}
            onCollapse={()=>collapse(lane.id)} onGoInbox={goInbox} arrivedId={arrivedId}
            expandedId={expandedId} setExpandedId={setExpandedId} />
        );
      })}
    </div>
  );
}

window.Kanban = { KanbanRow, Badges, DecisionBundle, CheckpointStepper, CardMeta, StatePill, RiskPill, EvidenceChips, GatePill, FailureClass, WhySeeing, STAGE_ORDER, SEED_CHECKPOINTS };
