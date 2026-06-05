/* Hermes — card drawer (lifecycle: running live-follow → end-report, in place) */
const { AGENTS: AGD, CARDS: CARDS_D, THREADS: THR_D } = window.HERMES_DATA;
const K = window.Kanban;

function cardKind(card) {
  if (!card) return null;
  if (card.stage === 'checking' && card.live) return 'live';
  if (card.decision && card.waitingOn === 'operator') return 'decision';
  if (card.state && card.state.kind === 'running') return 'running';
  return 'info';
}

function Sec({ label, children, right }) {
  return (
    <div style={{ marginBottom:20 }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
        <Lab>{label}</Lab>{right}
      </div>
      {children}
    </div>
  );
}

function ShotSlot({ label }) {
  return (
    <div style={{ position:'relative', aspectRatio:'16/10', borderRadius:'var(--r-sm)', overflow:'hidden',
      background:'repeating-linear-gradient(135deg, var(--hm-paper-sunken), var(--hm-paper-sunken) 10px, var(--hm-surface) 10px, var(--hm-surface) 20px)',
      border:'1px solid var(--hm-line)', display:'grid', placeItems:'center' }}>
      <span className="chip" style={{ background:'var(--hm-paper)' }}>{label}</span>
    </div>
  );
}

function EvidenceSection({ card }) {
  const traces = (card.evidence||[]).find(e=>e.k==='traces');
  const hasVideo = (card.evidence||[]).some(e=>e.k==='video'||e.k==='replay');
  const shots = (card.evidence||[]).find(e=>e.k==='shots');
  return (
    <Sec label="Evidence">
      <div style={{ marginBottom:12 }}><K.EvidenceChips evidence={card.evidence||[]} /></div>
      {shots && <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:10 }}><ShotSlot label="screenshot 1" /><ShotSlot label="screenshot 2" /></div>}
      {hasVideo && (
        <div style={{ position:'relative', aspectRatio:'16/8', borderRadius:'var(--r-sm)', background:'var(--hm-ink)', display:'grid', placeItems:'center', marginBottom: traces?12:0 }}>
          <span style={{ width:44, height:44, borderRadius:'50%', background:'rgba(255,255,255,0.14)', display:'grid', placeItems:'center', color:'#fff', fontSize:15, paddingLeft:4 }}>▶</span>
          <span className="chip" style={{ position:'absolute', left:10, bottom:10, background:'rgba(0,0,0,0.4)', color:'#fff', borderColor:'transparent' }}>session replay</span>
        </div>
      )}
      {traces && (
        <div style={{ border:'1px solid var(--hm-line-2)', borderRadius:'var(--r-sm)', overflow:'hidden' }}>
          {Array.from({length: traces.n||3}).map((_,i)=>(
            <div key={i} style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 12px', borderTop: i?'1px solid var(--hm-line-2)':'none', background: i%2?'var(--hm-paper-sunken)':'var(--hm-paper)' }}>
              <span className="mono" style={{ fontSize:11.5, color:'var(--hm-faint)' }}>{String(i+1).padStart(2,'0')}</span>
              <span className="mono" style={{ fontSize:12, color:'var(--hm-ink-2)' }}>trace-{card.threadId||card.id.slice(-6)}-{String(i+1).padStart(2,'0')}</span>
              <span className="chip" style={{ marginLeft:'auto', padding:'1px 7px', fontSize:10.5 }}>captured</span>
            </div>
          ))}
        </div>
      )}
    </Sec>
  );
}

/* ── live-follow view (requested → running) — refreshes from streamed card.live ── */
function LiveFrame({ frames, target }) {
  if (!frames || frames < 1) {
    return (
      <div style={{ position:'relative', aspectRatio:'16/9', borderRadius:'var(--r-sm)', border:'1px dashed var(--hm-line-strong)',
        background:'var(--hm-paper-sunken)', display:'grid', placeItems:'center', color:'var(--hm-faint)' }}>
        <div style={{ textAlign:'center' }}>
          <div className="spin" style={{ width:18, height:18, margin:'0 auto 8px', borderRadius:'50%', border:'2px solid var(--hm-line-strong)', borderTopColor:'var(--hm-muted)' }} />
          <div className="font-display" style={{ fontSize:12, fontWeight:600 }}>awaiting first frame</div>
          <div className="mono" style={{ fontSize:10.5, marginTop:3 }}>runner has not streamed a screenshot yet</div>
        </div>
      </div>
    );
  }
  return (
    <div style={{ position:'relative', aspectRatio:'16/9', borderRadius:'var(--r-sm)', overflow:'hidden', border:'1px solid var(--hm-line)',
      background:'repeating-linear-gradient(135deg, var(--hm-paper-sunken), var(--hm-paper-sunken) 11px, var(--hm-surface) 11px, var(--hm-surface) 22px)' }}>
      {/* faux browser chrome — clearly a demo slot, not a fabricated screenshot */}
      <div style={{ position:'absolute', top:0, left:0, right:0, height:24, background:'var(--hm-paper)', borderBottom:'1px solid var(--hm-line-2)', display:'flex', alignItems:'center', gap:5, padding:'0 9px' }}>
        <span style={{ width:7, height:7, borderRadius:'50%', background:'var(--warn)' }} />
        <span style={{ width:7, height:7, borderRadius:'50%', background:'var(--hm-line-strong)' }} />
        <span style={{ width:7, height:7, borderRadius:'50%', background:'var(--hm-line-strong)' }} />
        <span className="mono" style={{ fontSize:9, color:'var(--hm-faint)', marginLeft:6, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{target}</span>
      </div>
      <div style={{ position:'absolute', inset:'24px 0 0', display:'grid', placeItems:'center' }}>
        <span className="chip" style={{ background:'var(--hm-paper)', color:'var(--ag-claude)', borderColor:'rgba(112,72,182,0.3)' }}>live frame {frames} · demo stream</span>
      </div>
      <span style={{ position:'absolute', right:8, bottom:8, display:'inline-flex', alignItems:'center', gap:5, padding:'2px 8px', borderRadius:'var(--r-pill)', background:'rgba(0,0,0,0.42)', color:'#fff' }}>
        <span className="live-dot" style={{ width:6, height:6, borderRadius:'50%', background:'#ff5a4d' }} />
        <span className="mono" style={{ fontSize:9.5 }}>LIVE</span>
      </span>
    </div>
  );
}

function LiveFollow({ card }) {
  const live = card.live || { output:[], frames:0 };
  const steps = card.checkpoints || [];
  const cur = steps.find(s => s.state === 'current');
  const tailRef = React.useRef(null);
  React.useEffect(() => { const el = tailRef.current; if (el) el.scrollTop = el.scrollHeight; }, [live.output.length]);
  return (
    <>
      {/* stage badge */}
      <div style={{ display:'flex', alignItems:'center', gap:10, padding:'11px 13px', borderRadius:'var(--r-sm)',
        background:'var(--ok-soft)', border:'1px solid var(--ok-line)', marginBottom:16 }}>
        <span className="spin" style={{ width:14, height:14, borderRadius:'50%', border:'2px solid var(--ok-line)', borderTopColor:'var(--ok)', flex:'none' }} />
        <div style={{ minWidth:0 }}>
          <div className="eyebrow" style={{ fontSize:8.5, color:'var(--ok-text)' }}>Live · following</div>
          <div className="font-display" style={{ fontSize:14, fontWeight:700, color:'var(--ok-text)' }}>running {cur ? cur.label : '…'}</div>
        </div>
        <span className="mono" style={{ marginLeft:'auto', fontSize:10.5, color:'var(--ok-text)', flex:'none' }}>no verdict yet</span>
      </div>

      <Sec label="Latest frame">
        <LiveFrame frames={live.frames} target={card.repo} />
      </Sec>

      <Sec label="Recent output (rolling tail) · ~2s" right={<span className="chip" style={{ padding:'1px 7px', fontSize:9, color:'var(--ag-claude)', borderColor:'rgba(112,72,182,0.3)' }}>demo stream</span>}>
        <div ref={tailRef} className="scroll-y" style={{ maxHeight:148, borderRadius:'var(--r-sm)', background:'var(--hm-ink)',
          border:'1px solid var(--hm-line)', padding:'9px 11px', display:'flex', flexDirection:'column', gap:3 }}>
          {live.output.length === 0
            ? <span className="mono" style={{ fontSize:11, color:'rgba(255,255,255,0.4)' }}>awaiting runner output…</span>
            : live.output.map((line, i) => (
                <div key={i} className="mono" style={{ fontSize:11, color: i===live.output.length-1 ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.55)', lineHeight:1.5, display:'flex', gap:8 }}>
                  <span style={{ color:'rgba(255,255,255,0.3)', flex:'none' }}>{String(i+1).padStart(2,'0')}</span>
                  <span style={{ minWidth:0, wordBreak:'break-word' }}>{line}</span>
                </div>
              ))}
        </div>
      </Sec>

      <Sec label="Checkpoints"><K.CheckpointStepper steps={steps} /></Sec>
    </>
  );
}

/* ── #11 env / identity badges on missions ── */
function EnvBadges({ env }) {
  if (!env) return null;
  const rows = [
    ['environment', env.environment], ['identity', env.identity], ['data-mode', env.dataMode],
    ['browser', env.browser], ['viewport', env.viewport],
  ].filter(r => r[1]);
  return (
    <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:18 }}>
      {rows.map(([k,v]) => (
        <span key={k} className="chip" style={{ padding:'3px 9px', fontSize:10.5, gap:6 }}>
          <span className="eyebrow" style={{ fontSize:8, color:'var(--hm-faint)' }}>{k}</span>
          <span style={{ color:'var(--hm-ink-2)' }}>{v}</span>
        </span>
      ))}
    </div>
  );
}

/* ── #12 contract preview (target/flow/mode/success/stop/budget/artifacts) ── */
function ContractPreview({ contract }) {
  if (!contract) return null;
  const rows = [
    ['target', contract.target], ['flow', contract.flow], ['mode', contract.mode],
    ['success', contract.success], ['stop', contract.stop], ['budget', contract.budget], ['artifacts', contract.artifacts],
  ];
  return (
    <Sec label="Run contract" right={<span className="chip" style={{ padding:'1px 7px', fontSize:9, color:'var(--hm-faint)' }}>before run</span>}>
      <div style={{ border:'1px solid var(--hm-line-2)', borderRadius:'var(--r-sm)', overflow:'hidden' }}>
        {rows.map(([k,v],i) => (
          <div key={k} style={{ display:'grid', gridTemplateColumns:'78px 1fr', gap:10, padding:'8px 12px', borderTop:i?'1px solid var(--hm-line-2)':'none', background: i%2?'var(--hm-paper-sunken)':'var(--hm-paper)' }}>
            <span className="eyebrow" style={{ fontSize:8.5, color:'var(--hm-faint)', paddingTop:1 }}>{k}</span>
            <span style={{ fontSize:12.5, color: v?'var(--hm-ink-2)':'var(--hm-faint)', lineHeight:1.45 }}>{v || 'awaiting data'}</span>
          </div>
        ))}
      </div>
    </Sec>
  );
}

/* ── #12 forensic evidence order: verdict → timeline → failure frame → replay → diagnostics → raw ── */
function ExpectedObserved({ rows }) {
  return (
    <div style={{ border:'1px solid var(--hm-line-2)', borderRadius:'var(--r-sm)', overflow:'hidden', marginBottom:14 }}>
      <div style={{ display:'grid', gridTemplateColumns:'1.1fr 1fr 1fr auto', gap:8, padding:'7px 12px', background:'var(--hm-paper-sunken)', borderBottom:'1px solid var(--hm-line-2)' }}>
        {['field','expected','observed',''].map((h,i)=><span key={i} className="eyebrow" style={{ fontSize:8, color:'var(--hm-faint)' }}>{h}</span>)}
      </div>
      {rows.map((r,i)=>(
        <div key={i} style={{ display:'grid', gridTemplateColumns:'1.1fr 1fr 1fr auto', gap:8, padding:'8px 12px', borderTop:i?'1px solid var(--hm-line-2)':'none', alignItems:'center' }}>
          <span style={{ fontSize:12, color:'var(--hm-ink-2)' }}>{r.field}</span>
          <span className="mono" style={{ fontSize:11, color:'var(--hm-muted)' }}>{r.expected}</span>
          <span className="mono" style={{ fontSize:11, color: r.needsData?'var(--hm-faint)':(r.ok?'var(--ok-text)':'var(--warn-text)') }}>{r.observed}</span>
          <span aria-hidden="true" style={{ fontSize:11, color: r.needsData?'var(--hm-faint)':(r.ok?'var(--ok-text)':'var(--warn-text)') }}>{r.needsData?'—':(r.ok?'✓':'✕')}</span>
        </div>
      ))}
    </div>
  );
}
function RunTimeline({ events }) {
  return (
    <div style={{ position:'relative', paddingLeft:4 }}>
      {events.map((e,i)=>(
        <div key={i} style={{ display:'flex', gap:11, paddingBottom: i<events.length-1?12:0, position:'relative' }}>
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', flex:'none' }}>
            <span style={{ width:9, height:9, borderRadius:'50%', background: i===events.length-1?'var(--warn)':'var(--hm-line-strong)', flex:'none', marginTop:3 }} />
            {i<events.length-1 && <span style={{ width:1.5, flex:1, background:'var(--hm-line-2)', marginTop:2 }} />}
          </div>
          <div style={{ minWidth:0, paddingBottom:2 }}>
            <span className="mono" style={{ fontSize:10.5, color:'var(--hm-faint)' }}>{e.t}</span>
            <div style={{ fontSize:12.5, color:'var(--hm-ink-2)', lineHeight:1.4 }}>{e.e}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
function ForensicSection({ card }) {
  const f = card.forensic; if (!f) return null;
  return (
    <Sec label="Forensics" right={<span className="chip" style={{ padding:'1px 7px', fontSize:9, color:'var(--hm-faint)' }}>verdict → timeline → frame → replay → raw</span>}>
      {f.expectedObserved && (
        <>
          <div className="eyebrow" style={{ fontSize:9, color:'var(--hm-faint)', marginBottom:7 }}>Expected vs observed</div>
          <ExpectedObserved rows={f.expectedObserved} />
        </>
      )}
      {f.timeline && (
        <>
          <div className="eyebrow" style={{ fontSize:9, color:'var(--hm-faint)', marginBottom:9 }}>Run timeline</div>
          <RunTimeline events={f.timeline} />
        </>
      )}
      {f.failureFrame && (
        <div style={{ marginTop:14 }}>
          <div className="eyebrow" style={{ fontSize:9, color:'var(--hm-faint)', marginBottom:7 }}>Failure frame</div>
          <div style={{ position:'relative', aspectRatio:'16/9', borderRadius:'var(--r-sm)', border:'1px solid var(--warn-line)',
            background:'repeating-linear-gradient(135deg, var(--hm-paper-sunken), var(--hm-paper-sunken) 11px, var(--hm-surface) 11px, var(--hm-surface) 22px)', display:'grid', placeItems:'center' }}>
            <span className="chip" style={{ background:'var(--hm-paper)', color:'var(--warn-text)', borderColor:'var(--warn-line)' }}>{f.failureFrame} · awaiting data</span>
          </div>
        </div>
      )}
      <div style={{ display:'flex', gap:7, marginTop:14, flexWrap:'wrap' }}>
        <button className="btn btn--soft btn--sm">Open replay</button>
        <button className="btn btn--soft btn--sm">Diagnostics</button>
        <button className="btn btn--soft btn--sm">Raw trace ↗</button>
      </div>
    </Sec>
  );
}

/* ── #12 convert-to-bug preview (what bug card it creates) ── */
function ConvertPreview({ preview }) {
  if (!preview) return null;
  return (
    <Sec label="If converted to a bug" right={<span className="chip" style={{ padding:'1px 7px', fontSize:9, color:'var(--hm-faint)' }}>preview · awaiting data</span>}>
      <div style={{ border:'1px dashed var(--hm-line-strong)', borderRadius:'var(--r-sm)', padding:'12px 13px', background:'var(--hm-paper-sunken)' }}>
        <div className="eyebrow" style={{ fontSize:8.5, color:'var(--hm-faint)' }}>{preview.creates}</div>
        <div className="font-display" style={{ fontSize:13.5, fontWeight:700, color:'var(--hm-ink)', margin:'4px 0 8px', textWrap:'pretty' }}>{preview.title}</div>
        <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
          {(preview.labels||[]).map(l => <span key={l} className="chip" style={{ padding:'2px 8px', fontSize:10 }}>{l}</span>)}
          <span className="mono" style={{ fontSize:10.5, color:'var(--hm-faint)', marginLeft:'auto' }}>assignee · {preview.assignee || 'unassigned'}</span>
        </div>
      </div>
    </Sec>
  );
}

function DrawerInner({ card, onClose, decide, onAskHermes }) {
  const kind = cardKind(card);
  const author = AGD[card.author] || AGD.system;
  const thread = THR_D.find(t => t.cardRef === card.id);
  return (
    <>
      <div style={{ flex:'none', padding:'16px 18px', borderBottom:'1px solid var(--hm-line)', display:'flex', gap:12, alignItems:'flex-start' }}>
        <AgentAvatar agent={author} size={34} />
        <div style={{ flex:1, minWidth:0 }}>
          <div className="mono" style={{ fontSize:11.5, color:'var(--hm-muted)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{card.id}</div>
          <h2 className="font-display" style={{ margin:'4px 0 0', fontSize:20, fontWeight:700 }}>{card.title}</h2>
        </div>
        <button onClick={onClose} className="btn btn--ghost btn--sm" style={{ width:32, padding:0, flex:'none' }}>✕</button>
      </div>

      <div className="scroll-y" style={{ flex:1, padding:'18px', minHeight:0 }}>
        <div style={{ display:'flex', gap:5, flexWrap:'wrap', marginBottom:14, alignItems:'center' }}>
          {card.state && <K.StatePill s={card.state} />}
          {card.risk && <K.RiskPill risk={card.risk} />}
          <K.FailureClass card={card} />
          {card.gate && <K.GatePill gate={card.gate} />}
        </div>

        {kind === 'live' ? (
          <LiveFollow card={card} />
        ) : (
          <>
            <EnvBadges env={card.env} />
            <K.WhySeeing card={card} />
            {card.verdict && card.completed && (
              <div style={{ display:'flex', alignItems:'center', gap:10, padding:'12px 14px', borderRadius:'var(--r-sm)',
                background: card.state && card.state.kind==='ready' ? 'var(--ok-soft)' : 'var(--hm-paper-sunken)',
                border:`1px solid ${card.state && card.state.kind==='ready' ? 'var(--ok-line)' : 'var(--hm-line-2)'}`, margin:'14px 0 0' }}>
                <span style={{ width:9, height:9, borderRadius:'50%', flex:'none', background: card.state && card.state.kind==='ready' ? 'var(--ok)' : 'var(--hm-muted)' }} />
                <div style={{ minWidth:0, flex:1 }}>
                  <Lab style={{ display:'block', color: card.state && card.state.kind==='ready' ? 'var(--ok-text)' : 'var(--hm-muted)' }}>Hermes verdict</Lab>
                  <span style={{ fontSize:14, fontWeight:600, color: card.state && card.state.kind==='ready' ? 'var(--ok-text)' : 'var(--hm-ink-2)', textWrap:'pretty' }}>{card.verdict}</span>
                </div>
                <span className="mono" style={{ fontSize:10.5, color:'var(--hm-faint)', flex:'none' }}>just posted</span>
              </div>
            )}
            {card.body && <p style={{ margin:'14px 0 18px', fontSize:14, color:'var(--hm-ink-2)', lineHeight:1.65 }}>{card.body}</p>}

            {kind === 'decision' && (
              <Sec label="Decision">
                <K.DecisionBundle card={card} urgent={card.urgent}
                  onAction={(c)=>{ decide(card.id, c); onClose(); }}
                  onOpenReplay={()=>{}} onAskHermes={()=>{ onAskHermes(card.id); onClose(); }} />
              </Sec>
            )}

            {/* #12 forensic order: verdict (above) → timeline/frame → replay/raw */}
            <ForensicSection card={card} />

            {/* #12 run contract — what this run will / won't do */}
            <ContractPreview contract={card.contract} />

            {kind === 'running' && card.checkpoints && (
              <Sec label="Checkpoints"><K.CheckpointStepper steps={card.checkpoints} /></Sec>
            )}

            {card.grouped && (
              <Sec label={`${card.grouped} grouped runs`}>
                <div style={{ border:'1px solid var(--hm-line-2)', borderRadius:'var(--r-sm)', overflow:'hidden' }}>
                  {Array.from({length:card.grouped}).map((_,i)=>(
                    <div key={i} style={{ display:'flex', alignItems:'center', gap:10, padding:'11px 12px', borderTop:i?'1px solid var(--hm-line-2)':'none' }}>
                      <span className="spin" style={{ width:11, height:11, borderRadius:'50%', border:'2px solid var(--ok-line)', borderTopColor:'var(--ok)' }} />
                      <span className="mono" style={{ fontSize:12, color:'var(--hm-ink-2)' }}>verification-run-{String(i+1).padStart(2,'0')}</span>
                      <Pill tone="ok" style={{ marginLeft:'auto', minHeight:20, height:20, fontSize:10 }}>verifying</Pill>
                    </div>
                  ))}
                </div>
              </Sec>
            )}

            {(card.evidence && card.evidence.length>0) && <EvidenceSection card={card} />}

            {/* #12 convert-to-bug preview */}
            {kind === 'decision' && <ConvertPreview preview={card.convertPreview} />}

            {thread && (
              <Sec label="Agent discussion" right={<span className="mono" style={{ fontSize:11, color:'var(--hm-faint)' }}>{thread.turns.length} turn{thread.turns.length>1?'s':''}</span>}>
                <div style={{ display:'grid', gap:4, border:'1px solid var(--hm-line-2)', borderRadius:'var(--r-sm)', padding:'6px 6px' }}>
                  {thread.turns.map(t => <window.Room.Turn key={t.id} turn={t} fresh={false} />)}
                </div>
                <button onClick={()=>{ onAskHermes(card.id); }} className="btn btn--soft btn--sm" style={{ marginTop:10 }}>Show in room →</button>
              </Sec>
            )}

            {kind === 'info' && card.verdict && !card.completed && (
              <div style={{ display:'flex', alignItems:'center', gap:10, padding:'12px 14px', borderRadius:'var(--r-sm)', background:'var(--ok-soft)', border:'1px solid var(--ok-line)' }}>
                <span style={{ width:9, height:9, borderRadius:'50%', background:'var(--ok)' }} />
                <Lab style={{ color:'var(--ok-text)' }}>Outcome</Lab>
                <span style={{ fontSize:14, fontWeight:600, color:'var(--ok-text)' }}>{card.verdict}</span>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

function CardDrawer({ card, onClose, decide, onAskHermes }) {
  React.useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const open = !!card;
  return (
    <>
      <div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(10,8,14,0.46)', backdropFilter:'blur(2px)', zIndex:60,
        opacity: open?1:0, pointerEvents: open?'auto':'none', transition:'opacity var(--dur) var(--ease)' }} />
      <div style={{ position:'fixed', top:0, right:0, bottom:0, width:'min(560px, 92vw)', zIndex:61, background:'var(--hm-paper)',
        borderLeft:'1px solid var(--hm-line)', boxShadow:'var(--sh-lift)', display:'flex', flexDirection:'column',
        transform: open?'translateX(0)':'translateX(102%)', transition:'transform 320ms var(--ease-out)' }}>
        {card && <DrawerInner card={card} onClose={onClose} decide={decide} onAskHermes={onAskHermes} />}
      </div>
    </>
  );
}

window.Drawer = { CardDrawer };
