/* Hermes — right rail: Digest (default) + Agent Room tabs, and the cast roster.
   The room explains the board; it isn't the board. */
const { ROLES, AGENTS: AGRail } = window.HERMES_DATA;

/* ── cast roster (I) — modal overlay listing per-role capabilities ── */
function Roster({ open, onClose }) {
  React.useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const capColor = (c) => /mutate|merge|deploy/.test(c) ? 'var(--warn-text)' : (c==='approve'?'var(--act-text)':'var(--ok-text)');
  return (
    <>
      <div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(10,8,14,0.46)', backdropFilter:'blur(2px)', zIndex:70,
        opacity:open?1:0, pointerEvents:open?'auto':'none', transition:'opacity var(--dur) var(--ease)' }} />
      <div style={{ position:'fixed', top:'50%', left:'50%', width:'min(560px,92vw)', maxHeight:'84vh', zIndex:71,
        transform:`translate(-50%,-50%) scale(${open?1:0.97})`, opacity:open?1:0, pointerEvents:open?'auto':'none',
        transition:'opacity var(--dur) var(--ease), transform var(--dur) var(--ease)',
        background:'var(--hm-paper)', border:'1px solid var(--hm-line)', borderRadius:'var(--r-card)', boxShadow:'var(--sh-lift)', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <div style={{ flex:'none', padding:'16px 18px', borderBottom:'1px solid var(--hm-line)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div>
            <div className="font-display" style={{ fontWeight:700, fontSize:17 }}>The cast</div>
            <div className="eyebrow" style={{ marginTop:3, color:'var(--hm-faint)' }}>who can observe · mutate · approve</div>
          </div>
          <button onClick={onClose} className="btn btn--ghost btn--sm" style={{ width:32, padding:0 }}>✕</button>
        </div>
        <div className="scroll-y" style={{ padding:'12px 16px 16px', display:'grid', gap:10 }}>
          {ROLES.map(r => {
            const ag = AGRail[r.id] || { color:'var(--hm-faint)', mark:r.name[0], presence:'idle' };
            return (
              <div key={r.id} style={{ display:'flex', gap:12, padding:'12px 13px', borderRadius:'var(--r-sm)',
                background:'var(--hm-paper-sunken)', border:'1px solid var(--hm-line-2)', opacity: r.active?1:0.6 }}>
                <AgentAvatar agent={ag} size={32} presence={r.active?ag.presence:'idle'} />
                <div style={{ minWidth:0, flex:1 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                    <span className="font-display" style={{ fontWeight:700, fontSize:14, color:ag.color }}>{r.name}</span>
                    <span className="eyebrow" style={{ fontSize:9, color:'var(--hm-faint)' }}>{r.title}</span>
                    {!r.active && <span className="chip" style={{ padding:'1px 7px', fontSize:9 }}>not engaged</span>}
                  </div>
                  <p style={{ margin:'5px 0 8px', fontSize:12.5, color:'var(--hm-muted)', lineHeight:1.5 }}>{r.blurb}</p>
                  <div style={{ display:'flex', gap:5, flexWrap:'wrap' }}>
                    {r.can.map(c => <span key={c} className="chip" style={{ padding:'2px 8px', fontSize:10, color:capColor(c) }}>✓ {c}</span>)}
                    {r.cannot.map(c => <span key={c} className="chip" style={{ padding:'2px 8px', fontSize:10, color:'var(--hm-faint)', textDecoration:'line-through' }}>{c}</span>)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

/* ── digest (H) — what changed + what needs me ── */
function DigestStat({ label, value, tone, needsData }) {
  return (
    <div style={{ flex:1, minWidth:0, background:'var(--hm-paper-sunken)', border:'1px solid var(--hm-line-2)', borderRadius:'var(--r-sm)', padding:'10px 12px' }}>
      <div className="font-display" style={{ fontSize:22, fontWeight:700, color: needsData?'var(--hm-faint)':(tone||'var(--hm-ink)') }}>{needsData?'—':value}</div>
      <div className="eyebrow" style={{ fontSize:8.5, color:'var(--hm-faint)', marginTop:2 }}>{label}</div>
    </div>
  );
}

function DigestView({ cards, advanced, onOpenCard, onOpenRoster, onGoRoom }) {
  const { LAST_LOOKED } = window.HERMES_DATA;
  const inbox = cards.filter(c => c.waitingOn === 'operator');
  const running = cards.filter(c => c.state && c.state.kind === 'running');
  const riskTone = (lvl) => lvl==='high'||lvl==='med' ? 'var(--warn-text)' : 'var(--hm-muted)';
  return (
    <div className="scroll-y" style={{ flex:1, minHeight:0, padding:'16px 16px 20px' }}>
      <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
        <BrandMark size={30} label="H" />
        <div>
          <div className="font-display" style={{ fontWeight:700, fontSize:15 }}>Hermes digest</div>
          <div className="mono" style={{ fontSize:11, color:'var(--hm-faint)' }} title="The last-look marker needs a real session backend — timestamp shown, deltas awaiting data">since you last looked · {LAST_LOOKED ? LAST_LOOKED.time : '—'}</div>
        </div>
      </div>

      <div style={{ display:'flex', gap:8, margin:'12px 0 6px' }}>
        <DigestStat label="needs you" value={inbox.length} tone="var(--act-text)" />
        <DigestStat label="running now" value={running.length} tone="var(--ok-text)" />
        <DigestStat label="advanced (session)" value={advanced} />
        <DigestStat label="prod changes" value={0} />
      </div>
      <p style={{ fontSize:11.5, color:'var(--hm-faint)', margin:'4px 2px 16px', lineHeight:1.5 }}>
        Since 13:18: “advanced” counts moves you made this session; per-event deltas need a real session backend — honest until wired.
      </p>

      <div className="eyebrow" style={{ marginBottom:9 }}>{inbox.length} waiting on you</div>
      {inbox.length === 0 ? (
        <div style={{ textAlign:'center', padding:'28px 10px', color:'var(--hm-faint)' }}>
          <div style={{ fontSize:24, color:'var(--ok-text)' }}>✓</div>
          <div className="font-display" style={{ fontSize:13, fontWeight:600, color:'var(--ok-text)', marginTop:6 }}>Inbox clear</div>
          <div style={{ fontSize:12, marginTop:3 }}>Nothing needs your judgment right now.</div>
        </div>
      ) : (
        <div style={{ display:'grid', gap:8 }}>
          {inbox.map(c => {
            const ag = AGRail[c.author] || AGRail.system;
            const d = c.decision;
            return (
              <button key={c.id} onClick={()=>onOpenCard(c.id)} className="cardref click" style={{ textAlign:'left',
                display:'block', padding:'10px 12px', borderRadius:'var(--r-sm)', width:'100%',
                background:'var(--hm-paper-sunken)', border:`1px solid ${c.urgent?'var(--act-line)':'var(--hm-line-2)'}`, cursor:'pointer' }}>
                <div style={{ display:'flex', gap:10, alignItems:'flex-start' }}>
                  <span style={{ width:7, height:7, borderRadius:'50%', marginTop:5, flex:'none', background: c.urgent?'var(--act)':'var(--hm-line-strong)' }} />
                  <span style={{ minWidth:0, flex:1 }}>
                    <span className="font-display" style={{ display:'block', fontSize:13, fontWeight:600, color:'var(--hm-ink)', textWrap:'pretty' }}>{c.title}</span>
                    <span style={{ fontSize:11, color:'var(--hm-faint)' }}>{ag.name}</span>
                  </span>
                  <span className="font-display" style={{ fontSize:11.5, fontWeight:600, color:'var(--act-text)', flex:'none' }}>Open ›</span>
                </div>
                {/* enriched: recommended · risk · grants (#6) */}
                <div style={{ margin:'7px 0 0 17px', display:'grid', gap:3 }}>
                  {d && <div style={{ fontSize:11.5, color:'var(--hm-ink-2)' }}><span style={{ color:'var(--hm-faint)' }}>rec ·</span> {d.recommended}</div>}
                  <div style={{ display:'flex', gap:10, flexWrap:'wrap', fontSize:11 }}>
                    {c.risk && <span style={{ color:riskTone(c.risk.level) }}>risk · {c.risk.level} · {c.risk.type}</span>}
                    {d && d.grants && <span className="mono" style={{ color:'var(--hm-faint)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', maxWidth:'22ch' }} title={d.grants}>grants · {d.grants}</span>}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      <div style={{ display:'flex', gap:8, marginTop:18 }}>
        <button onClick={onGoRoom} className="btn btn--soft btn--sm" style={{ flex:1 }}>Open agent room →</button>
        <button onClick={onOpenRoster} className="btn btn--soft btn--sm">Who’s who</button>
      </div>
    </div>
  );
}

/* ── right rail shell: tabs + persistent composer ── */
function RightRail({ tab, setTab, cards, advanced, onOpenCard, roomProps }) {
  const [roster, setRoster] = React.useState(false);
  const inbox = cards.filter(c => c.waitingOn === 'operator').length;
  const Tab = ({ id, label, badge }) => (
    <button onClick={()=>setTab(id)} className="font-display" style={{ flex:1, height:38, border:0, cursor:'pointer', position:'relative',
      background: tab===id?'var(--hm-paper)':'transparent', color: tab===id?'var(--hm-ink)':'var(--hm-muted)',
      fontSize:13, fontWeight:tab===id?700:600, display:'inline-flex', alignItems:'center', justifyContent:'center', gap:7,
      borderBottom:`2px solid ${tab===id?'var(--act)':'transparent'}` }}>
      {label}
      {badge>0 && <span className="mono" style={{ fontSize:10, minWidth:16, height:16, padding:'0 4px', borderRadius:8, display:'grid', placeItems:'center',
        background: tab===id?'var(--act-soft)':'var(--hm-paper-sunken)', color: tab===id?'var(--act-text)':'var(--hm-faint)' }}>{badge}</span>}
    </button>
  );
  const Composer = window.Room.Composer;
  return (
    <aside style={{ display:'flex', flexDirection:'column', height:'100%', background:'var(--hm-paper)', borderLeft:'1px solid var(--hm-line)', minWidth:0 }}>
      <div style={{ flex:'none', display:'flex', borderBottom:'1px solid var(--hm-line)', background:'var(--hm-paper-veil)', backdropFilter:'blur(8px)' }}>
        <Tab id="digest" label="Digest" badge={inbox} />
        <Tab id="room" label="Agent room" badge={0} />
      </div>
      {/* tab content fills the middle; composer is always pinned below */}
      <div style={{ flex:1, minHeight:0, display:'flex', flexDirection:'column' }}>
        {tab === 'digest'
          ? <DigestView cards={cards} advanced={advanced} onOpenCard={onOpenCard} onOpenRoster={()=>setRoster(true)} onGoRoom={()=>setTab('room')} />
          : <RoomColumn {...roomProps} onOpenRoster={()=>setRoster(true)} hideHeader noComposer />}
      </div>
      {/* persistent Ask-Hermes composer — present in BOTH modes (acting/asking always available) */}
      <Composer {...roomProps.composer} onOpenCard={onOpenCard} />
      <Roster open={roster} onClose={()=>setRoster(false)} />
    </aside>
  );
}

window.Rail = { RightRail, Roster };
