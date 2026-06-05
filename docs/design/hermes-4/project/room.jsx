/* Hermes — collaboration room (right column) */
const { AGENTS: AGR, KIND_META } = window.HERMES_DATA;

const targetLabel = (t) => t==='operator' ? 'you' : t==='everyone' ? 'everyone' : (AGR[t]?.name || t);

/* ───────── co-pilot header ───────── */
function CoPilotHeader() {
  return (
    <div style={{ padding:'16px 18px 12px', borderBottom:'1px solid var(--hm-line)', flex:'none' }}>
      <div style={{ display:'flex', alignItems:'center', gap:11 }}>
        <BrandMark size={34} label="H" />
        <div style={{ minWidth:0 }}>
          <div className="font-display" style={{ fontWeight:700, fontSize:16 }}>Hermes co-pilot</div>
          <div style={{ display:'flex', alignItems:'center', gap:7, marginTop:2 }}>
            <span className="dot live-dot" style={{ width:6, height:6, borderRadius:'50%', background:'var(--ok)' }} />
            <span style={{ fontSize:12, color:'var(--hm-muted)' }}>Live activity · context: whole board</span>
          </div>
        </div>
      </div>
      <div className="cardref click" style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:10, marginTop:12,
        padding:'9px 12px', borderRadius:'var(--r-sm)', background:'var(--hm-paper-sunken)', border:'1px solid var(--hm-line-2)' }}>
        <div style={{ minWidth:0 }}>
          <div style={{ display:'flex', alignItems:'center', gap:7 }}>
            <span style={{ color:'var(--hm-faint)' }}>▸</span>
            <span className="font-display" style={{ fontWeight:600, fontSize:12.5 }}>Suggested follow-ups (3)</span>
          </div>
          <div className="eyebrow" style={{ marginTop:3, color:'var(--hm-faint)' }}>planner-only · read-only</div>
        </div>
        <span className="mono" style={{ fontSize:11.5, color:'var(--hm-faint)', flex:'none' }}>no tasks created</span>
      </div>
    </div>
  );
}

/* ───────── presence bar ───────── */
function PresenceBar({ presence, onOpenRoster }) {
  const order = ['hermes','claude','codex','test'];
  const active = order.filter(id => (presence[id]||AGR[id].presence)==='active').length;
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:10, padding:'12px 18px',
      borderBottom:'1px solid var(--hm-line)', flex:'none', background:'var(--hm-paper-veil)' }}>
      <div>
        <span className="font-display" style={{ fontWeight:700, fontSize:14 }}>Room</span>
        <button onClick={onOpenRoster} className="click" style={{ marginLeft:8, fontSize:12, color:'var(--hm-muted)', background:'none', border:0, cursor:'pointer', textDecoration:'underline', textDecorationColor:'var(--hm-line-strong)', textUnderlineOffset:2 }}>who’s who ↗</button>
      </div>
      <button onClick={onOpenRoster} className="click" title="Open the cast roster" style={{ display:'flex', alignItems:'center', gap:6, background:'none', border:0, cursor:'pointer' }}>
        {order.map(id => {
          const pres = presence[id] || AGR[id].presence;
          return <span key={id} title={`${AGR[id].name} · ${pres}`} style={{ position:'relative' }}><AgentAvatar agent={AGR[id]} size={24} presence={pres} /></span>;
        })}
        <span className="mono" style={{ fontSize:11, color: active? 'var(--ok-text)':'var(--hm-faint)', marginLeft:4 }}>{active} active</span>
      </button>
    </div>
  );
}

/* ───────── a single turn ───────── */
function Turn({ turn, fresh }) {
  const a = AGR[turn.author] || AGR.system;
  const meta = KIND_META[turn.kind] || KIND_META.status;
  const muted = turn.kind === 'status';
  const prominent = meta.rank >= 2;
  return (
    <div className={cx(fresh && 'anim-slide')} style={{
      display:'flex', gap:11, padding:'11px 12px', borderRadius:'var(--r-sm)',
      background: prominent ? (meta.tone==='act'?'var(--act-soft)':'var(--ok-soft)') : 'transparent',
      borderLeft: prominent ? `3px solid ${meta.tone==='act'?'var(--act)':'var(--ok)'}` : '3px solid transparent',
      opacity: muted ? 0.82 : 1 }}>
      <AgentAvatar agent={a} size={muted?22:28} presence={turn.author==='operator'?'online':a.presence} />
      <div style={{ minWidth:0, flex:1 }}>
        <div style={{ display:'flex', alignItems:'center', gap:7, flexWrap:'wrap' }}>
          <span style={{ display:'inline-flex', alignItems:'center', gap:6, whiteSpace:'nowrap' }}>
            <span className="font-display" style={{ fontWeight:600, fontSize:13, color:a.color }}>{a.name}</span>
            {turn.target && <span style={{ color:'var(--hm-faint)', fontSize:12 }}>→ {targetLabel(turn.target)}</span>}
          </span>
          <span className={cx('pill', `pill--${meta.tone}`)} style={{ minHeight:18, height:18, fontSize:9.5, padding:'0 8px' }}>{meta.label}</span>
          {turn.demo && <span className="chip" style={{ padding:'1px 6px', fontSize:9.5, color:'var(--ag-claude)', borderColor:'rgba(112,72,182,0.3)' }}>demo</span>}
          {turn.preview && <span className="chip" style={{ padding:'1px 6px', fontSize:9.5, color:'var(--act-text)', borderColor:'var(--act-line)' }}>preview</span>}
          <span className="mono" style={{ marginLeft:'auto', fontSize:11, color:'var(--hm-faint)' }}>{turn.time}</span>
        </div>
        <p style={{ margin:'5px 0 0', fontSize: muted?13:13.5, color:'var(--hm-ink-2)', lineHeight:1.62 }}>
          {turn.pending && <span className="spin" style={{ display:'inline-block', width:9, height:9, marginRight:6, borderRadius:'50%', border:'2px solid var(--hm-line)', borderTopColor:'var(--hm-muted)', verticalAlign:'middle' }} />}
          {turn.text}
        </p>
      </div>
    </div>
  );
}

function TypingBubble({ agentId }) {
  const a = AGR[agentId]; if (!a) return null;
  return (
    <div className="anim-rise" style={{ display:'flex', gap:11, padding:'8px 12px', alignItems:'center' }}>
      <AgentAvatar agent={a} size={24} presence="active" />
      <span style={{ display:'inline-flex', alignItems:'center', gap:8, padding:'7px 12px', borderRadius:'var(--r-pill)',
        background:'var(--hm-paper-sunken)', border:'1px solid var(--hm-line-2)', color:a.color }}>
        <span className="typing"><i/><i/><i/></span>
        <span style={{ fontSize:12, color:'var(--hm-muted)' }}>{a.name} is {a.role==='tester'?'replaying':'working'}…</span>
      </span>
    </div>
  );
}

/* ───────── a thread (card-grouped) ───────── */
function Thread({ thread, freshSet, typingAgent, onOpenCard }) {
  const turns = thread.turns;
  return (
    <div style={{ borderTop:'1px solid var(--hm-line-2)', padding:'14px 14px 6px' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
        <span className="font-display" style={{ fontSize:10.5, fontWeight:700, textTransform:'uppercase', color:'var(--hm-faint)' }}>
          Thread · {thread.label || ('testbed-mission-'+thread.id)}
        </span>
        <span className="mono" style={{ fontSize:10.5, color:'var(--hm-faint)' }}>{turns.length} {turns.length===1?'turn':'turns'}</span>
      </div>
      {thread.cardRef && (
        <div className="cardref click" onClick={()=>onOpenCard(thread.cardRef)} style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
          gap:8, padding:'9px 11px', borderRadius:'var(--r-sm)', background:'var(--hm-paper-sunken)', border:'1px solid var(--hm-line-2)', marginBottom:8 }}>
          <div style={{ minWidth:0 }}>
            <div className="mono" style={{ fontSize:11.5, color:'var(--hm-ink-2)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{thread.cardRef}</div>
            <div className="eyebrow" style={{ marginTop:2, color:'var(--hm-faint)' }}>referenced card</div>
          </div>
          <span className="font-display" style={{ fontSize:11.5, fontWeight:600, color:'var(--act-text)', flex:'none' }}>open ›</span>
        </div>
      )}
      <div style={{ display:'grid', gap:4 }}>
        {turns.map(t => <Turn key={t.id} turn={t} fresh={freshSet.has(t.id)} />)}
        {typingAgent && <TypingBubble agentId={typingAgent} />}
      </div>
    </div>
  );
}

function EmptyRoom() {
  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:10, padding:30, textAlign:'center' }}>
      <div style={{ width:46, height:46, borderRadius:14, background:'var(--hm-paper-sunken)', border:'1px solid var(--hm-line)',
        display:'grid', placeItems:'center', color:'var(--hm-faint)', fontSize:20 }}>···</div>
      <div className="font-display" style={{ fontWeight:600, fontSize:14, color:'var(--hm-muted)' }}>No agent chatter yet</div>
      <div style={{ fontSize:12.5, color:'var(--hm-faint)', maxWidth:'26ch' }}>Turns appear here as agents coordinate. Nothing is fabricated — empty is honestly empty.</div>
    </div>
  );
}

/* command interpretation (F) — never mutates without this preview */
function interpret(text) {
  const s = text.trim();
  if (s.startsWith('/mission')) return { action:'Create a fresh-agent browser mission', scope:'browser runner only', mutation:'none (read-only)', budget:'≤ 1 run', timeout:'90s', gates:'merge / deploy gates unchanged' };
  if (s.startsWith('/task')) return { action:'Propose a task for an agent', scope:'open a PR on CI', mutation:'branch + PR · no merge', budget:'≤ 1 task', timeout:'—', gates:'merge / deploy gates unchanged' };
  if (s.startsWith('/mute')) return { action:'Mute telemetry', scope:'board notifications', mutation:'none', budget:'—', timeout:'1h', gates:'board state unchanged' };
  return { action:'Send a message to the room', scope:'chat only', mutation:'none', budget:'—', timeout:'—', gates:'no board changes' };
}
const isCommand = (text) => text.trim().startsWith('/');

function CommandPreview({ text, onConfirm, onEdit, onCancel }) {
  const p = interpret(text);
  const rows = [['scope',p.scope],['mutation',p.mutation],['budget',p.budget],['timeout',p.timeout],['gates',p.gates]];
  return (
    <div className="anim-rise" style={{ marginBottom:10, borderRadius:'var(--r-sm)', background:'var(--hm-paper)', border:'1px solid var(--act-line)', padding:'11px 13px' }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
        <span className="dot live-dot" style={{ width:6, height:6, borderRadius:'50%', background:'var(--act)' }} />
        <span className="eyebrow" style={{ color:'var(--act-text)' }}>Confirm before it runs</span>
      </div>
      <div className="font-display" style={{ fontSize:13.5, fontWeight:700, color:'var(--hm-ink)' }}>I will: {p.action}</div>
      <div style={{ display:'grid', gridTemplateColumns:'auto 1fr', gap:'3px 10px', margin:'8px 0 0' }}>
        {rows.filter(r=>r[1] && r[1]!=='—').map(([k,v]) => (
          <React.Fragment key={k}>
            <span className="eyebrow" style={{ fontSize:8.5, color:'var(--hm-faint)', paddingTop:2 }}>{k}</span>
            <span className="mono" style={{ fontSize:11.5, color:'var(--hm-ink-2)' }}>{v}</span>
          </React.Fragment>
        ))}
      </div>
      <div style={{ display:'flex', gap:7, marginTop:11 }}>
        <button onClick={onConfirm} className="btn btn--act btn--sm" style={{ flex:1 }}>Confirm</button>
        <button onClick={onEdit} className="btn btn--ghost btn--sm">Edit</button>
        <button onClick={onCancel} className="btn btn--soft btn--sm">Cancel</button>
      </div>
    </div>
  );
}

/* ───────── composer ───────── */
const TO_OPTS = ['@everyone','@hermes','@claude','@codex','@test-writer'];
function Composer({ to, setTo, draft, setDraft, onSend, sending }) {
  const [scope, setScope] = React.useState('board');
  const [supervised, setSupervised] = React.useState(true);
  const [pending, setPending] = React.useState(null); // text awaiting confirm (F)
  const taRef = React.useRef(null);
  const submit = () => {
    if (!draft.trim() || sending) return;
    if (isCommand(draft)) { setPending(draft); return; } // mutating command → preview first
    onSend();
  };
  const confirm = () => { setPending(null); onSend(); };
  return (
    <div style={{ flex:'none', borderTop:'1px solid var(--hm-line)', padding:'12px 14px 14px', background:'var(--hm-paper-veil)', backdropFilter:'blur(8px)' }}>
      {pending && <CommandPreview text={pending} onConfirm={confirm} onEdit={()=>{ setPending(null); taRef.current&&taRef.current.focus(); }} onCancel={()=>setPending(null)} />}
      <div style={{ display:'flex', alignItems:'center', gap:7, marginBottom:9, flexWrap:'wrap' }}>
        <div style={{ display:'inline-flex', alignItems:'center', gap:6, height:28, padding:'0 4px 0 10px', borderRadius:'var(--r-pill)',
          background:'var(--hm-ink)', color:'var(--hm-paper)' }}>
          <span className="eyebrow" style={{ color:'rgba(255,255,255,0.6)', fontSize:9.5 }}>To</span>
          <select value={to} onChange={e=>setTo(e.target.value)} className="font-display" style={{ height:24, border:0, background:'transparent',
            color:'#fff', fontSize:12, fontWeight:600, outline:'none', cursor:'pointer' }}>
            {TO_OPTS.map(o => <option key={o} value={o} style={{ color:'#000' }}>{o}</option>)}
          </select>
        </div>
        <button onClick={()=>setScope(s=>s==='board'?'card':'board')} className="chip click" style={{ height:28 }}>
          <span className="eyebrow" style={{ fontSize:9.5 }}>Scope</span> {scope}
        </button>
        <button onClick={()=>setSupervised(s=>!s)} className="chip click" style={{ height:28, color: supervised?'var(--ok-text)':'var(--hm-faint)', borderColor: supervised?'var(--ok-line)':'var(--hm-line-2)' }}>
          <span style={{ width:7, height:7, borderRadius:'50%', border:`1.5px solid currentColor`, background: supervised?'currentColor':'transparent' }} />
          {supervised?'supervised':'auto'}
        </button>
        <span className="mono" style={{ marginLeft:'auto', fontSize:10.5, color:'var(--hm-faint)' }}>↵ send · ⇧↵ newline</span>
      </div>
      <div style={{ display:'flex', gap:9, alignItems:'flex-end' }}>
        <textarea ref={taRef} value={draft} onChange={e=>setDraft(e.target.value)} rows={2}
          onKeyDown={e=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); submit(); } }}
          placeholder="Ask Hermes · /task <agent> <repo> <prompt> · /mission <url> · /mute 1h"
          style={{ flex:1, padding:'10px 12px', borderRadius:'var(--r-btn)', border:'1px solid var(--hm-line)', background:'var(--hm-paper)',
            fontSize:13, fontFamily:'var(--font-body)', color:'var(--hm-ink)', resize:'none', outline:'none', minHeight:46 }} />
        <button className={cx('btn', isCommand(draft)?'btn--soft':'btn--act')} onClick={submit} disabled={sending}
          style={ isCommand(draft) ? { height:46, background:'var(--hm-ink)', color:'var(--hm-paper)', border:'1px solid transparent', opacity:sending?0.7:1 } : { height:46, opacity: sending?0.7:1 } }>
          {sending ? <span className="typing" style={{ color:'#fff' }}><i/><i/><i/></span> : (isCommand(draft) ? 'Preview ↵' : <>Send ↵</>)}
        </button>
      </div>
    </div>
  );
}

/* ───────── room column ───────── */
function RoomColumn({ threads, presence, typingMap, onOpenCard, onOpenRoster, demoActive, composer, hideHeader, noComposer }) {
  const scrollRef = React.useRef(null);
  const hasTurns = threads.some(t => t.turns.length);
  React.useEffect(() => {
    const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight;
  }, [threads, typingMap, composer && composer.sending]);
  return (
    <aside style={{ display:'flex', flexDirection:'column', height:'100%', background:'var(--hm-paper)', minWidth:0 }}>
      {!hideHeader && <CoPilotHeader />}
      <PresenceBar presence={presence} onOpenRoster={onOpenRoster} />
      <div ref={scrollRef} className="scroll-y" style={{ flex:1, minHeight:0 }}>
        {demoActive && (
          <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 14px', background:'rgba(112,72,182,0.06)',
            borderBottom:'1px solid var(--hm-line-2)' }}>
            <span style={{ width:6, height:6, borderRadius:'50%', background:'var(--ag-claude)' }} className="live-dot" />
            <span style={{ fontSize:11.5, color:'var(--ag-claude)' }}>Demo timeline playing — synthetic turns, stripped in production.</span>
          </div>
        )}
        {hasTurns
          ? threads.filter(t=>t.turns.length || typingMap[t.id]).map(t => (
              <Thread key={t.id} thread={t} freshSet={composer.freshSet} typingAgent={typingMap[t.id]} onOpenCard={onOpenCard} />
            ))
          : <EmptyRoom />}
      </div>
      {!noComposer && <Composer {...composer} onOpenCard={onOpenCard} />}
    </aside>
  );
}

window.Room = { RoomColumn, Composer, PresenceBar, Turn, targetLabel };
