/* Hermes — app shell: color profiles, motion/tweaks, kanban + room composition */
const { CARDS, THREADS, DEMO_TIMELINE, AGENTS: AGA, CLOCK_START } = window.HERMES_DATA;
const { TopBar, NeedsYouBanner, Toolbar, ControlsSheet } = window.Board;
const { UtilitiesPanel } = window.Utilities;
const { KanbanRow, SEED_CHECKPOINTS } = window.Kanban;
const { RightRail } = window.Rail;
const { CardDrawer } = window.Drawer;

/* ───────── color math ───────── */
const _hx = (h) => { h = h.replace('#',''); if (h.length===3) h = h.split('').map(c=>c+c).join(''); return { r:parseInt(h.slice(0,2),16), g:parseInt(h.slice(2,4),16), b:parseInt(h.slice(4,6),16) }; };
const _hex = ({r,g,b}) => { const t=n=>Math.max(0,Math.min(255,Math.round(n))).toString(16).padStart(2,'0'); return '#'+t(r)+t(g)+t(b); };
const mix = (a,b,t) => { const A=_hx(a), B=_hx(b); return _hex({ r:A.r+(B.r-A.r)*t, g:A.g+(B.g-A.g)*t, b:A.b+(B.b-A.b)*t }); };
const rgba = (h,a) => { const {r,g,b}=_hx(h); return `rgba(${r},${g},${b},${a})`; };
const lighten = (h,t) => mix(h,'#ffffff',t);
const darken  = (h,t) => mix(h,'#000000',t);
const _lum = (h) => { const {r,g,b}=_hx(h); const f=c=>{c/=255;return c<=0.03928?c/12.92:Math.pow((c+0.055)/1.055,2.4);}; return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b); };
const inkOn = (bg) => _lum(bg) > 0.42 ? '#14110c' : '#ffffff';

/* ───────── profiles ───────── */
const PROFILES = {
  claude:    { label:'Claude Warm',       dark:false, base:'#FAF7F2', surface:'#FFFDFA', ink:'#2A2622', muted:'#A89B8C', accent:'#D97757', healthy:'#6B8F71', degraded:'#C8843C' },
  midnight:  { label:'Midnight',          dark:true,  glow:false, base:'#1A1714', surface:'#241F1B', ink:'#EDE6DD', muted:'#6B635A', accent:'#E8865E', healthy:'#7FB089', degraded:'#E0A050' },
  slate:     { label:'Slate Console',     dark:false, base:'#F4F5F7', surface:'#FFFFFF', ink:'#1F2430', muted:'#8A93A3', accent:'#5B6CFF', healthy:'#3FA66A', degraded:'#D9911F' },
  editorial: { label:'Editorial',         dark:false, base:'#FBFAF7', surface:'#FFFFFF', ink:'#17120E', muted:'#9C948A', accent:'#B23A28', healthy:'#2F7D52', degraded:'#B5791E' },
  averray:   { label:'Averray (Polkadot)',dark:false, base:'#F6F5F8', surface:'#FFFFFF', ink:'#1B1722', muted:'#8C8A99', accent:'#E6007A', healthy:'#0FA67E', degraded:'#E0A030', accentFill:'#D6006E', accentInk:'#ffffff' },
  midpolka:  { label:'Midnight × Polkadot',dark:true, glow:true, base:'#14111C', surface:'#201B2E', ink:'#ECE8F2', muted:'#6B6580', accent:'#FF2D92', healthy:'#2DD4BF', degraded:'#F0B44C', accentInk:'#14111C' },
};
const PROFILE_OPTS = Object.entries(PROFILES).map(([value,p]) => ({ value, label:p.label }));

function buildTheme(p) {
  const dark = !!p.dark, glow = !!p.glow;
  const { base, surface:surf, ink, muted, accent, healthy:ok, degraded:warn } = p;
  const accFill = p.accentFill || (dark ? accent : darken(accent,0.08));
  const accInk  = p.accentInk  || inkOn(accFill);
  return {
    '--hm-canvas':base, '--hm-surface':mix(base,surf,0.5), '--hm-paper':surf,
    '--hm-paper-sunken':mix(surf,base,0.4), '--hm-paper-veil':rgba(surf,0.72),
    '--hm-ink':ink, '--hm-ink-2': dark ? mix(ink,muted,0.16) : mix(ink,muted,0.30),
    '--hm-muted': dark ? lighten(muted,0.22) : muted,
    '--hm-faint': dark ? lighten(mix(muted,base,0.28),0.08) : mix(muted,base,0.45),
    '--hm-line':rgba(ink,dark?0.14:0.12), '--hm-line-2':rgba(ink,dark?0.08:0.06), '--hm-line-strong':rgba(ink,dark?0.22:0.16),
    '--act':accent, '--act-deep':accFill, '--act-ink':accInk,
    '--act-text':dark?lighten(accent,0.10):darken(accent,0.12),
    '--act-soft':rgba(accent,dark?0.18:0.12), '--act-soft-2':rgba(accent,dark?0.30:0.20), '--act-line':rgba(accent,dark?0.5:0.34),
    /* DECIDE tier tint — desaturated toward neutral so it never blurs with the true-coral CTA (#4) */
    '--tier-decide-bg':   rgba(mix(accent, base, dark?0.55:0.45), dark?0.16:0.34),
    '--tier-decide-line': rgba(mix(accent, base, dark?0.40:0.32), dark?0.34:0.30),
    '--tier-decide-text': dark ? lighten(mix(accent,muted,0.34),0.06) : darken(mix(accent,muted,0.30),0.04),
    '--ok':ok, '--ok-text':dark?lighten(ok,0.12):darken(ok,0.10), '--ok-soft':rgba(ok,dark?0.20:0.16), '--ok-line':rgba(ok,dark?0.42:0.24),
    '--warn':warn, '--warn-text':dark?lighten(warn,0.10):darken(warn,0.14), '--warn-soft':rgba(warn,dark?0.20:0.16), '--warn-line':rgba(warn,dark?0.42:0.28),
    '--tel':dark?lighten(muted,0.18):darken(muted,0.04), '--tel-soft':rgba(muted,dark?0.18:0.5), '--tel-chip':dark?mix(surf,muted,0.20):mix(base,muted,0.16),
    '--glow-1':rgba(accent, dark?(glow?0.14:0.10):0.05), '--glow-2':rgba(ok, dark?0.07:0.04),
    '--act-glow': dark ? `0 0 ${glow?20:14}px ${rgba(accent,glow?0.6:0.45)}` : 'none',
    '--sh-sm':  dark ? '0 1px 0 rgba(255,255,255,0.04) inset, 0 2px 8px rgba(0,0,0,0.40)' : '0 1px 2px rgba(40,33,18,0.05), 0 2px 6px rgba(40,33,18,0.04)',
    '--sh':     dark ? 'inset 0 1px 0 rgba(255,255,255,0.05), 0 10px 30px rgba(0,0,0,0.45)' : '0 2px 6px rgba(40,33,18,0.05), 0 14px 34px rgba(40,33,18,0.07)',
    '--sh-lift':dark ? 'inset 0 1px 0 rgba(255,255,255,0.06), 0 16px 44px rgba(0,0,0,0.55)' : '0 8px 18px rgba(40,33,18,0.09), 0 26px 56px rgba(40,33,18,0.12)',
    '--sh-coral':dark ? `0 6px 22px ${rgba(accent,glow?0.55:0.40)}, 0 0 ${glow?22:14}px ${rgba(accent,glow?0.50:0.32)}` : `0 8px 24px ${rgba(accent,0.24)}`,
    '--sh-inset':dark ? 'inset 0 1px 0 rgba(255,255,255,0.10)' : 'inset 0 1px 0 rgba(255,255,255,0.6)',
  };
}

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "profile": "midnight",
  "motion": 60,
  "density": "regular",
  "avatar": "tile",
  "utilities": "collapsed",
  "demo": false
}/*EDITMODE-END*/;

const bucket = (v) => v<=0 ? 'off' : v<=33 ? 'low' : v<=66 ? 'med' : 'high';

/* board footer — gives the page a clear bottom edge so it visibly ends */
function BoardFooter({ cards, clock }) {
  const total = cards.length;
  const waiting = cards.filter(c => c.waitingOn === 'operator').length;
  const running = cards.filter(c => c.state && c.state.kind === 'running').length;
  return (
    <footer style={{ flex:'none', display:'flex', alignItems:'center', gap:14, flexWrap:'wrap',
      padding:'12px 22px', borderTop:'1px solid var(--hm-line)', background:'var(--hm-paper-veil)' }}>
      <span style={{ display:'inline-flex', alignItems:'center', gap:8 }}>
        <span style={{ width:5, height:5, borderRadius:'50%', background:'var(--hm-line-strong)' }} />
        <span className="eyebrow" style={{ fontSize:9.5, color:'var(--hm-faint)' }}>End of board</span>
      </span>
      <span className="mono" style={{ fontSize:11.5, color:'var(--hm-muted)' }}>
        {total} cards · {waiting} waiting on you · {running} running
      </span>
      <span style={{ marginLeft:'auto', display:'inline-flex', alignItems:'center', gap:8 }}>
        <span className="mono" style={{ fontSize:11, color:'var(--hm-faint)' }} title="Last board sync — needs a real backend signal">last sync · {clock}</span>
        <span style={{ fontSize:11, color:'var(--hm-faint)' }}>Hermes · Averray</span>
      </span>
    </footer>
  );
}

/* synthetic runner stream (demo — the real worker streams these) */
const STREAM_LINES = [
  'runner: claimed testbed slot · fresh agent, no memory',
  'browser: launching chromium (headless, read-only)',
  'nav: GET https://en.wikipedia.org/ · budget 45s',
  'nav: first paint at 1.8s',
  'dom: settled · 0 console errors',
  'replay: step 1/4 — open article',
  'frame: captured screenshot',
  'replay: step 2/4 — locate citation block',
  'replay: step 3/4 — verify reference target',
  'frame: captured screenshot',
  'replay: step 4/4 — assert no mutation crossed',
  'hermes: collecting 8 traces',
  'hermes: scoring run against policy',
  'hermes: verdict posted',
];

/* complete a live mission into its end-report (in place — same card, kind flips) */
function completeMission(c, output, frames) {
  const steps = (c.checkpoints || []).map(s => ({ ...s, state:'done' }));
  return {
    ...c,
    checkpoints: steps,
    live: null,
    completed: true,
    stage: 'opreview',
    waitingOn: 'operator',
    state: { label:'Passed', kind:'ready' },
    gate: 'operator',
    failureClass: null,
    verdict: 'mission passed · 45s budget held',
    evidence: [ {k:'traces', n:8}, {k:'shots', n:2}, {k:'video'}, {k:'replay'} ],
    whySeeing: 'The re-run finished and Hermes posted a passing verdict — accept to close, or re-run / convert.',
    unblock: null,
    body: 'Read-only mission completed. The fresh agent reached the citation block, verified the reference target, and crossed no mutation boundary.',
    decision: {
      recommended: 'Accept & close',
      why: 'Run passed within the 45s budget with no boundary crossed; nothing to merge or deploy.',
      grants: 'closes this card · records the passing run',
      denies: 'no merge · no deploy · no spend · no prod data',
      blast: { repo:'en.wikipedia.org (target)', branch:'—', env:'testbed', area:'browser-runner', users:'none' },
      rollback: 'Re-open from Done if the verdict is later disputed.',
      choices: ['Accept & close','Re-run','Convert to bug','Ask Hermes','Open replay','Dismiss'],
    },
  };
}

function HermesApp() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const clock = useClock(CLOCK_START);
  const wide = useWide(860);
  const [filter, setFilter] = React.useState('all');
  const [openId, setOpenId] = React.useState(null);

  const [presence, setPresence] = React.useState({});
  const [typingMap, setTypingMap] = React.useState({});
  const [extras, setExtras] = React.useState([]);
  const [freshSet, setFreshSet] = React.useState(() => new Set());
  const [to, setTo] = React.useState('@everyone');
  const [draft, setDraft] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const boardRef = React.useRef(null);
  const firstTheme = React.useRef(true);
  const [utilOpen, setUtilOpen] = React.useState(t.utilities === 'expanded');
  React.useEffect(() => { setUtilOpen(t.utilities === 'expanded'); }, [t.utilities]);

  /* ---- A: unified card store + decision actions ---- */
  const [cards, setCards] = React.useState(() => CARDS.map(c => ({ ...c })));
  const [arrivedId, setArrivedId] = React.useState(null);
  const [advanced, setAdvanced] = React.useState(0);
  const [railTab, setRailTab] = React.useState('digest');
  const [controlsOpen, setControlsOpen] = React.useState(false);

  const decide = (cardId, action) => {
    const a = (action || '').toLowerCase();
    let patch = null, stageChanged = false, startLive = false;
    if (/approve|dispatch/.test(a))      { patch = { stage:'checking', state:{ label:'Running', kind:'running' }, waitingOn:null, checkpoints:SEED_CHECKPOINTS(), gate:'agent', urgent:false, live:{ output:[], frames:0, startedAt:Date.now() }, completed:false }; stageChanged = true; startLive = true; }
    else if (/rerun/.test(a))            { patch = { stage:'checking', state:{ label:'Running', kind:'running' }, waitingOn:null, checkpoints:SEED_CHECKPOINTS(), gate:'agent', urgent:false, live:{ output:[], frames:0, startedAt:Date.now() }, completed:false, failureClass:null }; stageChanged = true; startLive = true; }
    else if (/reject|dismiss/.test(a))   { patch = { stage:'done', state:{ label:'Rejected', kind:'done' }, waitingOn:null, gate:'system', verdict:'rejected', urgent:false, live:null }; stageChanged = true; }
    else if (/convert/.test(a))          { patch = { stage:'done', state:{ label:'Converted', kind:'done' }, waitingOn:null, gate:'system', verdict:'converted to bug', urgent:false, live:null }; stageChanged = true; }
    else if (/hold/.test(a))             { patch = { waitingOn:null, state:{ label:'Held', kind:'blocked' }, gate:'agent', urgent:false }; }
    else if (/accept/.test(a))           { patch = { stage:'done', state:{ label:'Accepted', kind:'done' }, waitingOn:null, gate:'system', verdict:'accepted · passed', urgent:false, live:null, completed:false }; stageChanged = true; }
    else if (/edit/.test(a))             { return openCard(cardId); }
    else return;
    setCards(prev => {
      const next = prev.map(c => c.id === cardId ? { ...c, ...patch } : c);
      // promote a new most-urgent among remaining decisions
      const stillUrgent = next.some(c => c.waitingOn === 'operator' && c.urgent);
      if (!stillUrgent) { const firstWaiting = next.find(c => c.waitingOn === 'operator'); if (firstWaiting) firstWaiting.urgent = true; }
      return next;
    });
    if (stageChanged) { setArrivedId(cardId); setAdvanced(n => n + 1); setTimeout(() => setArrivedId(a2 => a2 === cardId ? null : a2), 1500); }
    // open the live-follow drawer so the operator can watch it run
    if (startLive) setTimeout(() => setOpenId(cardId), 360);
  };

  const askHermes = (cardId) => { setRailTab('room'); };

  /* ---- live-follow stream driver (clearly-marked demo; real worker streams stage/output/frames) ---- */
  React.useEffect(() => {
    const iv = setInterval(() => {
      setCards(prev => {
        let changed = false;
        const next = prev.map(c => {
          if (c.stage !== 'checking' || !c.live) return c;
          changed = true;
          const steps = c.checkpoints || [];
          const curIdx = steps.findIndex(s => s.state === 'current');
          const replayIdx = steps.findIndex(s => /replay/.test(s.label));
          const line = STREAM_LINES[Math.min(c.live.output.length, STREAM_LINES.length - 1)];
          const output = [...c.live.output, line].slice(-60);
          // frames begin once the run reaches browser replay
          const frames = (curIdx >= replayIdx && replayIdx >= 0) ? c.live.frames + 1 : c.live.frames;
          // advance one checkpoint per tick
          if (curIdx >= 0 && curIdx < steps.length - 1) {
            const checkpoints = steps.map((s,i) => i <= curIdx ? { ...s, state:'done' } : (i === curIdx+1 ? { ...s, state:'current' } : s));
            return { ...c, checkpoints, live:{ ...c.live, output, frames } };
          }
          // last checkpoint reached → complete into the end-report (in place)
          return completeMission(c, output, frames);
        });
        return changed ? next : prev;
      });
    }, 2000);
    return () => clearInterval(iv);
  }, []);

  /* ---- color profile ---- */
  React.useLayoutEffect(() => {
    const root = document.documentElement;
    const p = PROFILES[t.profile] || PROFILES.claude;
    if (!firstTheme.current) { root.classList.add('theming'); setTimeout(()=>root.classList.remove('theming'), 540); }
    firstTheme.current = false;
    const vars = buildTheme(p);
    for (const k in vars) root.style.setProperty(k, vars[k]);
    root.setAttribute('data-dark', p.dark ? '1' : '0');
    root.setAttribute('data-glow', p.glow ? '1' : '0');
  }, [t.profile]);

  React.useEffect(() => {
    document.documentElement.setAttribute('data-motion', bucket(t.motion));
    document.documentElement.style.setProperty('--mi', String(Math.max(t.motion/100, 0)));
  }, [t.motion]);
  React.useEffect(() => { document.documentElement.setAttribute('data-density', t.density); }, [t.density]);

  const markFresh = (id) => {
    setFreshSet(s => new Set(s).add(id));
    setTimeout(() => setFreshSet(s => { const n = new Set(s); n.delete(id); return n; }), 1300);
  };

  /* ---- demo timeline ---- */
  React.useEffect(() => {
    if (!t.demo) { setExtras(e => e.filter(x => !x.turn.demo)); setPresence({}); setTypingMap({}); return; }
    const timers = [];
    DEMO_TIMELINE.forEach(ev => {
      timers.push(setTimeout(() => {
        if (ev.type === 'presence') setPresence(p => ({ ...p, [ev.agent]: ev.presence }));
        else if (ev.type === 'typing') setTypingMap(m => ({ ...m, [ev.threadId]: ev.agent }));
        else if (ev.type === 'turn') {
          setTypingMap(m => { const n = { ...m }; delete n[ev.threadId]; return n; });
          setExtras(e => [...e, { threadId: ev.threadId, turn: ev.turn }]);
          markFresh(ev.turn.text);
        }
      }, ev.at));
    });
    timers.push(setTimeout(() => setTypingMap({}), DEMO_TIMELINE[DEMO_TIMELINE.length-1].at + 400));
    return () => timers.forEach(clearTimeout);
  }, [t.demo]);

  /* ---- composer optimistic send ---- */
  const onSend = () => {
    const text = draft.trim(); if (!text) return;
    const tgt = to.replace('@','');
    const opId = 'op-' + Date.now();
    setExtras(e => [...e, { threadId:'direct', turn:{ id:opId, author:'operator', target:tgt, kind:'chat', time:clock.slice(0,5), text, pending:true } }]);
    markFresh(text);
    setDraft(''); setSending(true);
    setPresence(p => ({ ...p, hermes:'active' }));
    setTimeout(() => setExtras(e => e.map(x => x.turn.id===opId ? { ...x, turn:{ ...x.turn, pending:false } } : x)), 480);
    setTimeout(() => setTypingMap(m => ({ ...m, direct:'hermes' })), 620);
    setTimeout(() => {
      setTypingMap(m => { const n = { ...m }; delete n.direct; return n; });
      const reply = ackFor(text, tgt);
      setExtras(e => [...e, { threadId:'direct', turn:{ id:'hm-'+Date.now(), author:'hermes', target:'operator', kind:'chat', time:clock.slice(0,5), text:reply, preview:true } }]);
      markFresh(reply);
      setSending(false);
    }, 2000);
  };

  const threads = React.useMemo(() => {
    const merged = THREADS.map(th => ({ ...th, turns:[...th.turns, ...extras.filter(e=>e.threadId===th.id).map(e=>e.turn)] }));
    const direct = extras.filter(e=>e.threadId==='direct').map(e=>e.turn);
    if (direct.length) merged.push({ id:'direct', label:'you ↔ hermes', cardRef:null, turns:direct });
    return merged;
  }, [extras]);

  const openCard = (id) => setOpenId(id);
  const jump = () => {
    const urgent = cards.find(c => c.waitingOn === 'operator' && c.urgent) || cards.find(c => c.waitingOn === 'operator');
    if (urgent) openCard(urgent.id);
  };

  const header = (
    <div style={{ padding:'18px 22px 12px', display:'flex', flexDirection:'column', gap:14, flex:'none' }}>
      <NeedsYouBanner clock={clock} onJump={jump} wide={wide} cards={cards} />
      <Toolbar active={filter} onFilter={setFilter} />
      <UtilitiesPanel open={utilOpen} onToggle={()=>setUtilOpen(o=>!o)} />
    </div>
  );

  const roomProps = { threads, presence, typingMap, onOpenCard:openCard, demoActive:t.demo,
    composer:{ to, setTo, draft, setDraft, onSend, sending, freshSet } };

  return (
    <AvatarStyleContext.Provider value={t.avatar}>
    <div style={{ height:'100%', display:'flex', flexDirection:'column' }}>
      <TopBar clock={clock} cards={cards} onToggleControls={()=>setControlsOpen(o=>!o)} />
      <ControlsSheet open={controlsOpen} onClose={()=>setControlsOpen(false)} />
      <div id="mainscroll" style={{ flex:1, minHeight:0, display: wide?'grid':'block',
        gridTemplateColumns: wide ? 'minmax(0,1fr) clamp(360px, 30vw, 460px)' : undefined,
        gridTemplateRows: wide ? 'minmax(0, 1fr)' : undefined,
        overflowY: wide ? 'hidden' : 'auto' }} className={wide?'':'scroll-y'}>
        <div ref={boardRef} id="boardscroll" style={{ minWidth:0, minHeight:0, height: wide?'100%':'auto',
          display:'flex', flexDirection:'column', overflow: wide?'hidden':'visible' }}>
          {header}
          <div style={{ position:'relative', flex: wide?1:'none', minHeight:0, height: wide?'auto':'62vh' }}>
            <KanbanRow cards={cards} decide={decide} arrivedId={arrivedId}
              onOpenCard={openCard} onOpenReplay={openCard} onAskHermes={askHermes} />
            {/* subtle bottom boundary so the board region visibly ends */}
            <div aria-hidden="true" style={{ position:'absolute', left:0, right:0, bottom:0, height:22, pointerEvents:'none',
              background:'linear-gradient(to top, var(--hm-canvas), transparent)' }} />
          </div>
          <BoardFooter cards={cards} clock={clock} />
        </div>
        <div style={{ height: wide?'100%':'82vh', minHeight: wide?0:560, overflow:'hidden', borderTop: wide?'none':'1px solid var(--hm-line)' }}>
          <RightRail tab={railTab} setTab={setRailTab} cards={cards} advanced={advanced}
            onOpenCard={openCard} roomProps={roomProps} />
        </div>
      </div>

      <CardDrawer card={openId ? cards.find(c => c.id === openId) || null : null} onClose={()=>setOpenId(null)} decide={decide} onAskHermes={askHermes} />

      <TweaksPanel title="Tweaks">
        <TweakSection label="Theme" />
        <TweakSelect label="Color profile" value={t.profile} options={PROFILE_OPTS} onChange={v=>setTweak('profile', v)} />
        <TweakSection label="Feel" />
        <TweakSlider label="Motion" value={t.motion} min={0} max={100} step={10} unit="%" onChange={v=>setTweak('motion', v)} />
        <TweakSection label="Layout" />
        <TweakRadio label="Density" value={t.density} options={['compact','regular','comfy']} onChange={v=>setTweak('density', v)} />
        <TweakRadio label="Agent avatars" value={t.avatar} options={[{value:'tile',label:'Tiles'},{value:'dot',label:'Dots'}]} onChange={v=>setTweak('avatar', v)} />
        <TweakRadio label="Utilities row" value={t.utilities} options={[{value:'collapsed',label:'Collapsed'},{value:'expanded',label:'Expanded'}]} onChange={v=>setTweak('utilities', v)} />
        <TweakSection label="Room" />
        <TweakToggle label="Demo timeline (synthetic)" value={t.demo} onChange={v=>setTweak('demo', v)} />
        <div style={{ fontSize:10.5, color:'rgba(41,38,27,.5)', lineHeight:1.5, marginTop:-2 }}>
          Injects synthetic request_help / proposal / typing so you can judge the motion. Stripped in production — only real turns animate.
        </div>
      </TweaksPanel>
    </div>
    </AvatarStyleContext.Provider>
  );
}

function ackFor(text, tgt) {
  const s = text.toLowerCase();
  if (s.startsWith('/mission')) return 'Heard. In production I\u2019d queue that mission and post a status turn here when the runner reports back. Design preview — nothing dispatched.';
  if (s.startsWith('/task')) return 'Heard. I\u2019d propose that task for your approval before any runner claims it. Design preview — no task created.';
  if (s.startsWith('/mute')) return 'Muting telemetry for 1h. Design preview — board state unchanged.';
  const tt = tgt==='everyone' ? 'the room' : tgt;
  return `Routing to ${tt}. In production I\u2019d relay this and surface their reply as a new turn. Design preview — no message sent.`;
}

ReactDOM.createRoot(document.getElementById('root')).render(<HermesApp />);
