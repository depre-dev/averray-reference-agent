/* Hermes — shared atoms + hooks (exported to window) */

const cx = (...a) => a.filter(Boolean).join(' ');

/* viewport width >= threshold (side-by-side vs stacked) */
function useWide(threshold = 1180) {
  const get = () => (typeof window !== 'undefined' ? window.innerWidth >= threshold : true);
  const [wide, setWide] = React.useState(get);
  React.useEffect(() => {
    const on = () => setWide(get());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return wide;
}

/* live clock that ticks from a HH:MM:SS start */function useClock(start) {
  const toSec = (s) => { const [h,m,sec]=s.split(':').map(Number); return h*3600+m*60+sec; };
  const [t, setT] = React.useState(toSec(start));
  React.useEffect(() => {
    const id = setInterval(() => setT(x => x + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const h = Math.floor(t/3600)%24, m = Math.floor(t/60)%60, s = t%60;
  const p = (n) => String(n).padStart(2,'0');
  return `${p(h)}:${p(m)}:${p(s)}`;
}

/* number that pops when it changes */
function CountTween({ value, className }) {
  const [disp, setDisp] = React.useState(value);
  const [pop, setPop] = React.useState(false);
  const ref = React.useRef(value);
  React.useEffect(() => {
    if (ref.current === value) return;
    ref.current = value;
    setDisp(value); setPop(true);
    const id = setTimeout(() => setPop(false), 440);
    return () => clearTimeout(id);
  }, [value]);
  return <span className={cx(className, pop && 'pop')} style={{ display:'inline-block' }}>{disp}</span>;
}

/* presence dot — online | active | idle */
function PresenceDot({ presence, color = 'var(--ok)', size = 9, ring = true }) {
  const base = { width:size, height:size, borderRadius:'50%', position:'relative', flex:'none' };
  if (presence === 'idle') {
    return <span style={{ ...base, border:`1.5px solid ${color}`, opacity:0.5, background:'transparent' }} />;
  }
  return (
    <span style={{ ...base, background: color, boxShadow: presence==='active' ? `0 0 0 0 ${color}` : 'none' }}>
      {presence === 'active' && ring && (
        <span className="breathe-ring" style={{ position:'absolute', inset:-1, borderRadius:'50%', boxShadow:`0 0 0 3px ${color}` }} />
      )}
    </span>
  );
}

/* agent identity — monogram tile (default) or dot, + presence */
const AvatarStyleContext = React.createContext('tile');
function AgentAvatar({ agent, size = 30, style, presence, showPresence = true }) {
  const ctxStyle = React.useContext(AvatarStyleContext);
  style = style || ctxStyle;
  const a = agent;
  const pres = presence || a.presence;
  if (style === 'dot') {
    return (
      <span style={{ display:'inline-flex', alignItems:'center', gap:7 }}>
        <PresenceDot presence={pres} color={a.color} size={Math.round(size*0.34)} />
        <span className="font-display" style={{ fontWeight:600, color:a.color, fontSize:size*0.46 }}>{a.name}</span>
      </span>
    );
  }
  const r = Math.max(8, size*0.32);
  return (
    <span style={{ position:'relative', flex:'none', width:size, height:size }}>
      <span className="font-display" style={{
        width:size, height:size, borderRadius:r, background:a.color, color:'#fff',
        display:'grid', placeItems:'center', fontWeight:700, fontSize:size*0.46,
        boxShadow:'inset 0 1px 0 rgba(255,255,255,0.25), 0 1px 3px rgba(40,33,18,0.18)',
        letterSpacing:'0',
      }}>{a.mark}</span>
      {showPresence && (
        <span style={{ position:'absolute', right:-2, bottom:-2, padding:2, background:'var(--hm-paper)', borderRadius:'50%', display:'grid', placeItems:'center' }}>
          <PresenceDot presence={pres} color={pres==='idle' ? 'var(--hm-faint)' : 'var(--ok)'} size={8} />
        </span>
      )}
    </span>
  );
}

/* brand mark tile */
function BrandMark({ size = 38, label = 'A' }) {
  return (
    <span className="font-display" style={{
      width:size, height:size, borderRadius:11, background:'var(--hm-ink)', color:'var(--hm-paper)',
      display:'grid', placeItems:'center', fontWeight:700, fontSize:size*0.5,
      boxShadow:'inset 0 1px 0 rgba(255,255,255,0.18), var(--sh-sm)', flex:'none',
    }}>{label}</span>
  );
}

const TONE_BG = { act:'var(--act-soft)', ok:'var(--ok-soft)', warn:'var(--warn-soft)', tel:'var(--tel-chip)', ink:'var(--hm-paper-sunken)' };
const TONE_FG = { act:'var(--act-text)', ok:'var(--ok-text)', warn:'var(--warn-text)', tel:'var(--tel)', ink:'var(--hm-ink-2)' };

function Pill({ tone='tel', dot=false, children, className, style }) {
  return (
    <span className={cx('pill', className)} style={{ background:TONE_BG[tone], color:TONE_FG[tone], ...style }}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

/* small label eyebrow */
function Lab({ children, act, style }) {
  return <span className={cx('eyebrow', act && 'eyebrow--act')} style={style}>{children}</span>;
}

Object.assign(window, { cx, useWide, useClock, CountTween, PresenceDot, AgentAvatar, BrandMark, Pill, Lab, TONE_BG, TONE_FG, AvatarStyleContext });
