/**
 * Motion-graphics Short: every second is drawn to show exactly what the narrator says at that second.
 * Scene types: hook, dialer (code typed key by key), settings (path tapped page by page), card (a result/message
 * screen), alert, compat (works on…), cta, statement (generic). Style (camera, transitions, captions…) comes from
 * the plan, so the team can tune it over time.
 */
import React from 'react';
import { AbsoluteFill, Audio, Easing, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { loadFont } from '@remotion/google-fonts/Cairo';
import type { Hl, IconName, MotionPlan, MotionScene, MotionStyle, Tone, Variants } from './types';

const { fontFamily } = loadFont('normal', { weights: ['600', '800', '900'], subsets: ['arabic', 'latin'] });
export const FPS = 30;

const WHITE = '#FFFFFF', DIM = '#9AA6C8', CARD = '#141C36', LINE = '#26335E';
const StyleCtx = React.createContext<MotionStyle>(null as unknown as MotionStyle);
const useStyle = () => React.useContext(StyleCtx);
const V = (s: MotionStyle): Variants => ({ hook: 'rings', headline: 'pop', phone: 'flat', ...(s.variants ?? {}) });
const toneColor = (s: MotionStyle, t?: Tone | 'good' | 'bad' | 'neutral') => (t === 'green' || t === 'good' ? s.good : t === 'red' || t === 'bad' ? s.bad : t === 'neutral' ? DIM : s.accent);

const f = (s: number) => Math.round(s * FPS);
const ease = (t: number, a: number, b: number) => interpolate(t, [a, b], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
const pop = (frame: number, fps: number, delay = 0) => spring({ frame: frame - delay, fps, config: { damping: 12, stiffness: 160, mass: 0.7 } });
/** Seconds since the start of the whole Short, inside a scene's Sequence. */
const useAbsT = (start: number) => useCurrentFrame() / FPS + start;

// Material Icons paths (Apache 2.0)
const PATHS: Record<IconName, string> = {
  call: 'M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z',
  shield: 'M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z',
  headset: 'M12 1c-4.97 0-9 4.03-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h4v1h-7v2h6c1.66 0 3-1.34 3-3V10c0-4.97-4.03-9-9-9z',
  warn: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
  check: 'M9 16.17L4.83 12l-1.42 1.42L9 19 21 7l-1.41-1.41z',
  lock: 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z',
  antenna: 'M12 5c-3.87 0-7 3.13-7 7h2c0-2.76 2.24-5 5-5s5 2.24 5 5h2c0-3.87-3.13-7-7-7zm1 9.29c.88-.39 1.5-1.26 1.5-2.29 0-1.38-1.12-2.5-2.5-2.5S9.5 10.62 9.5 12c0 1.02.62 1.9 1.5 2.29v3.3L7.59 21 9 22.41l3-3 3 3L16.41 21 13 17.59v-3.3zM12 1C5.93 1 1 5.93 1 12h2c0-4.97 4.03-9 9-9s9 4.03 9 9h2c0-6.07-4.93-11-11-11z',
  chat: 'M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z',
  eye: 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z',
  bolt: 'M7 2v11h3v9l7-12h-4l4-8z',
  image: 'M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z',
  battery: 'M15.67 4H14V2h-4v2H8.33C7.6 4 7 4.6 7 5.33v15.33C7 21.4 7.6 22 8.33 22h7.33c.74 0 1.34-.6 1.34-1.33V5.33C17 4.6 16.4 4 15.67 4z',
  bell: 'M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z',
  mic: 'M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z',
  location: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z',
  trash: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
  star: 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
  search: 'M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
  phone: 'M16 1H8C6.34 1 5 2.34 5 4v16c0 1.66 1.34 3 3 3h8c1.66 0 3-1.34 3-3V4c0-1.66-1.34-3-3-3zm-2 20h-4v-1h4v1zm3.25-3H6.75V4h10.5v14z',
  camera: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM9 2L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9z',
  tune: 'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z',
};
const Icon: React.FC<{ name: IconName; size: number; color: string; style?: React.CSSProperties }> = ({ name, size, color, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" style={style}><path d={PATHS[name] ?? PATHS.star} fill={color} /></svg>
);

const Code: React.FC<{ children: string; style?: React.CSSProperties }> = ({ children, style }) => (
  <span style={{ direction: 'ltr', unicodeBidi: 'bidi-override', display: 'inline-block', fontFamily: 'Menlo, DejaVu Sans Mono, monospace', fontWeight: 800, letterSpacing: 6, ...style }}>{children}</span>
);

/** Text with its accent word coloured; Latin/code runs stay left-to-right. */
const Rich: React.FC<{ hl: Hl }> = ({ hl }) => {
  const s = useStyle();
  const i = hl.accent ? hl.text.indexOf(hl.accent) : -1;
  if (i < 0) return <>{hl.text}</>;
  return <>{hl.text.slice(0, i)}<span style={{ color: toneColor(s, hl.tone) }}>{hl.accent}</span>{hl.text.slice(i + hl.accent!.length)}</>;
};

const Background: React.FC<{ tint: string }> = ({ tint }) => {
  const s = useStyle();
  const t = useCurrentFrame() / FPS;
  const x = 50 + 18 * Math.sin(t * 0.5), y = 35 + 10 * Math.cos(t * 0.4);
  return (
    <AbsoluteFill style={{ background: `radial-gradient(circle at ${x}% ${y}%, ${tint}55 0%, transparent 45%), radial-gradient(circle at ${100 - x}% ${100 - y}%, ${s.bg2} 0%, ${s.bg1} 70%)` }}>
      <AbsoluteFill style={{ backgroundImage: 'radial-gradient(rgba(255,255,255,0.07) 2px, transparent 2px)', backgroundSize: '48px 48px', transform: `translateY(${(t * 12) % 48}px)` }} />
    </AbsoluteFill>
  );
};

const Particles: React.FC<{ color: string }> = ({ color }) => {
  const t = useCurrentFrame() / FPS;
  return (
    <AbsoluteFill>
      {Array.from({ length: 28 }, (_, i) => {
        const r = (n: number) => { const x = Math.sin(i * 127.1 + n * 311.7) * 43758.5453; return x - Math.floor(x); };
        const speed = 30 + 50 * r(1), size = 4 + 8 * r(2);
        const y = 1920 - ((t * speed + r(3) * 1920) % 2100);
        const x = r(4) * 1080 + 30 * Math.sin(t * (0.5 + r(5)) + i);
        return <div key={i} style={{ position: 'absolute', left: x, top: y, width: size, height: size, borderRadius: '50%', background: color, opacity: 0.15 + 0.35 * r(6), boxShadow: `0 0 ${size * 3}px ${color}` }} />;
      })}
    </AbsoluteFill>
  );
};

const Shell: React.FC<{ len: number; children: React.ReactNode; instant?: boolean }> = ({ len, children, instant }) => {
  const s = useStyle();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const inn = instant ? 1 : spring({ frame, fps, config: { damping: 18, stiffness: 140 } });
  const out = interpolate(frame, [len - 7, len + 3], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.in(Easing.cubic) });
  const op = Math.min(1, inn * 1.5) * (1 - out);
  const tr = s.transition === 'whip'
    ? `translateX(${(1 - inn) * -420 + out * 420}px) scale(${0.94 + 0.06 * inn}) skewX(${(1 - inn) * 6 - out * 6}deg)`
    : s.transition === 'zoom' ? `scale(${0.7 + 0.3 * inn + out * 0.4})` : `scale(${0.97 + 0.03 * inn})`;
  const blur = s.transition === 'fade' ? 0 : (1 - inn) * 10 + out * 10;
  return <AbsoluteFill style={{ opacity: op, transform: tr, filter: `blur(${blur}px)` }}>{children}</AbsoluteFill>;
};

const Headline: React.FC<{ hl: Hl; delay?: number; size?: number; top?: number; instant?: boolean }> = ({ hl, delay = 0, size = 88, top = 170, instant }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = instant ? 1 : pop(frame, fps, delay);
  // one line when it can (≥ 58 px): a wrapped headline would cover what is drawn under it
  const fit = Math.max(58, Math.min(size, Math.floor(950 / (Math.max(1, hl.text.length) * 0.5))));
  const st = useStyle();
  if (!instant && V(st).headline === 'stagger') {
    const accent = new Set((hl.accent ?? '').split(/\s+/).filter(Boolean));
    return (
      <div style={{ position: 'absolute', top, left: 50, right: 50, textAlign: 'center', direction: 'rtl', fontFamily, fontWeight: 900, fontSize: fit, lineHeight: 1.25, color: WHITE, textShadow: '0 8px 30px rgba(0,0,0,0.5)' }}>
        {hl.text.split(/\s+/).map((w, i) => {
          const q = pop(frame, fps, delay + i * 3);
          return <span key={i} style={{ display: 'inline-block', margin: '0 10px', opacity: q, transform: `translateY(${(1 - q) * 60}px) rotate(${(1 - q) * -8}deg)`, color: accent.has(w) ? toneColor(st, hl.tone) : WHITE }}>{w}</span>;
        })}
      </div>
    );
  }
  return (
    <div style={{ position: 'absolute', top, left: 60, right: 60, textAlign: 'center', direction: 'rtl', fontFamily, fontWeight: 900, fontSize: fit, lineHeight: 1.25, color: WHITE, opacity: p, transform: `translateY(${(1 - p) * 40}px) scale(${0.85 + 0.15 * p})`, textShadow: '0 8px 30px rgba(0,0,0,0.5)' }}><Rich hl={hl} /></div>
  );
};

const Phone: React.FC<{ children: React.ReactNode; top?: number; glow?: string }> = ({ children, top = 470, glow }) => {
  const s = useStyle();
  const t = useCurrentFrame() / FPS;
  const tilt = V(s).phone === 'tilt';
  const sweep = ((t * 0.45) % 1.4) - 0.2;
  return (
    <div style={{ position: 'absolute', inset: 0, perspective: 1800 }}>
    <div style={{ position: 'absolute', top, left: '50%', width: 520, height: 960, marginLeft: -260, borderRadius: 74, transform: tilt ? `rotateY(${-10 + 4 * Math.sin(t * 0.8)}deg) rotateX(${5 + 2 * Math.cos(t * 0.6)}deg)` : undefined, transformStyle: 'preserve-3d', background: '#0A0F22', border: '12px solid #2B3760', boxShadow: `0 40px 120px rgba(0,0,0,0.6), 0 0 80px ${glow ?? s.accent}33`, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: 18, left: '50%', width: 150, height: 34, marginLeft: -75, borderRadius: 20, background: '#000', zIndex: 5 }} />
      {children}
      {tilt && <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 20, background: `linear-gradient(115deg, transparent ${sweep * 100 - 12}%, rgba(255,255,255,0.13) ${sweep * 100}%, transparent ${sweep * 100 + 12}%)` }} />}
    </div>
    </div>
  );
};

const Finger: React.FC<{ x: number; y: number }> = ({ x, y }) => <div style={{ position: 'absolute', left: x - 16, top: y + 20, width: 64, height: 64, borderRadius: '50%', background: 'rgba(255,255,255,0.35)', border: '3px solid rgba(255,255,255,0.8)', zIndex: 10 }} />;

/** Camera push-in between a and b (absolute seconds), scaled by style.camera. */
const Camera: React.FC<{ t: number; a: number; b: number; origin: string; children: React.ReactNode }> = ({ t, a, b, origin, children }) => {
  const s = useStyle();
  const k = (ease(t, a, a + 0.5) - ease(t, b - 0.5, b)) * s.camera;
  return <AbsoluteFill style={{ transformOrigin: origin, transform: `scale(${1 + 0.35 * k}) translateY(${-40 * k}px) rotate(${-2.5 * k}deg)` }}>{children}</AbsoluteFill>;
};

// ── scenes ───────────────────────────────────────────────────────────────────────────────────────────────
type Of<T extends MotionScene['type']> = Extract<MotionScene, { type: T }>;

const HookScene: React.FC<{ sc: Of<'hook'> }> = ({ sc }) => {
  const s = useStyle();
  const v = V(s).hook;
  if (v === 'slam') return <HookSlam sc={sc} />;
  if (v === 'phone3d') return <HookPhone3d sc={sc} />;
  return <HookRings sc={sc} />;
};

/** The headline's words slam onto the screen one by one, big, with a shake — pure kinetic typography. */
const HookSlam: React.FC<{ sc: Of<'hook'> }> = ({ sc }) => {
  const s = useStyle();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = useAbsT(sc.start);
  const words = sc.headline.text.split(/\s+/);
  const accent = new Set((sc.headline.accent ?? '').split(/\s+/).filter(Boolean));
  const per = Math.min(8, Math.max(4, Math.floor((f(sc.end - sc.start) * 0.5) / Math.max(1, words.length))));
  const lastHit = Math.floor(frame / per);
  const shake = frame % per < 3 && lastHit < words.length ? (3 - (frame % per)) * 4 : 0;
  const size = Math.max(90, Math.min(150, Math.floor(1700 / Math.max(6, sc.headline.text.length))));
  const reveal = sc.revealAt ?? 1e9;
  return (
    <>
      <div style={{ position: 'absolute', top: 210, left: 0, right: 0, display: 'flex', justifyContent: 'center', opacity: pop(frame, fps, 0) }}>
        <div style={{ width: 150, height: 150, borderRadius: 44, background: s.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 0 70px ${s.accent}`, transform: `rotate(${Math.sin(t * 3) * 6}deg)` }}><Icon name={sc.icon} size={96} color="#111" /></div>
      </div>
      <div style={{ position: 'absolute', top: 470, left: 50, right: 50, textAlign: 'center', direction: 'rtl', fontFamily, fontWeight: 900, fontSize: size, lineHeight: 1.15, transform: `translate(${shake * Math.sin(frame)}px, ${shake * Math.cos(frame)}px)` }}>
        {words.map((w, i) => {
          const q = frame >= i * per ? spring({ frame: frame - i * per, fps, config: { damping: 9, stiffness: 260, mass: 0.6 } }) : 0;
          return <span key={i} style={{ display: 'inline-block', margin: '0 14px', opacity: Math.min(1, q * 2), transform: `scale(${2.2 - 1.2 * q})`, color: accent.has(w) ? toneColor(s, sc.headline.tone) : WHITE, textShadow: `0 10px 40px rgba(0,0,0,0.6)` }}>{w}</span>;
        })}
      </div>
      {sc.teaserCode && (
        <div style={{ position: 'absolute', top: 1080, left: 0, right: 0, textAlign: 'center', opacity: ease(t, sc.start + 0.6, sc.start + 1) }}>
          <span style={{ display: 'inline-block', padding: '12px 46px', borderRadius: 30, background: '#1E2A55', border: `3px ${t < reveal ? 'dashed' : 'solid'} ${s.accent}` }}>
            <Code style={{ fontSize: 80, color: s.accent, filter: `blur(${(1 - ease(t, reveal, reveal + 0.3)) * (10 - 3 * Math.abs(Math.sin(t * 3)))}px)` }}>{sc.teaserCode}</Code>
          </span>
        </div>
      )}
      {sc.question && <Headline hl={sc.question} delay={f((sc.questionAt ?? sc.start + 1.5) - sc.start)} top={1250} size={72} />}
    </>
  );
};

/** A phone flies in from deep space and lands facing the viewer, its screen glowing with the topic. */
const HookPhone3d: React.FC<{ sc: Of<'hook'> }> = ({ sc }) => {
  const s = useStyle();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = useAbsT(sc.start);
  const p = spring({ frame, fps, config: { damping: 14, stiffness: 90 } });
  const reveal = sc.revealAt ?? 1e9;
  return (
    <>
      <Headline hl={sc.headline} instant />
      <div style={{ position: 'absolute', inset: 0, perspective: 1400 }}>
        <div style={{ position: 'absolute', top: 470, left: '50%', width: 460, height: 860, marginLeft: -230, borderRadius: 66, background: `linear-gradient(160deg, #18224A, #0A0F22)`, border: '12px solid #2B3760', boxShadow: `0 0 ${60 + 60 * Math.sin(t * 4) ** 2}px ${s.accent}88`, transform: `translateZ(${(1 - p) * -1600}px) rotateY(${(1 - p) * 70 + 6 * Math.sin(t * 1.2)}deg) rotateX(${(1 - p) * 25}deg)`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 50 }}>
          <div style={{ width: 230, height: 230, borderRadius: '50%', background: s.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 0 90px ${s.accent}` }}><Icon name={sc.icon} size={140} color="#111" /></div>
          {sc.teaserCode && <Code style={{ fontSize: 70, color: s.accent, filter: `blur(${(1 - ease(t, reveal, reveal + 0.3)) * 9}px)` }}>{sc.teaserCode}</Code>}
        </div>
      </div>
      {sc.question && <Headline hl={sc.question} delay={f((sc.questionAt ?? sc.start + 1.5) - sc.start)} top={330} size={76} />}
    </>
  );
};

const HookRings: React.FC<{ sc: Of<'hook'> }> = ({ sc }) => {
  const s = useStyle();
  const t = useAbsT(sc.start);
  const ring = (k: number) => (t * 1.2 + k / 3) % 1;
  const reveal = sc.revealAt ?? 1e9;
  return (
    <>
      <Headline hl={sc.headline} instant />
      {sc.teaserCode && (
        <div style={{ position: 'absolute', top: 430, left: 0, right: 0, textAlign: 'center' }}>
          <span style={{ display: 'inline-block', padding: '10px 40px', borderRadius: 30, background: '#1E2A55', border: `3px ${t < reveal ? 'dashed' : 'solid'} ${s.accent}` }}>
            <Code style={{ fontSize: 72, color: s.accent, filter: `blur(${(1 - ease(t, reveal, reveal + 0.3)) * (10 - 3 * Math.abs(Math.sin(t * 3)))}px)` }}>{sc.teaserCode}</Code>
          </span>
        </div>
      )}
      <div style={{ position: 'absolute', top: 800, left: 0, right: 0, height: 520, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {[0, 1, 2].map((k) => <div key={k} style={{ position: 'absolute', width: 220 + 380 * ring(k), height: 220 + 380 * ring(k), borderRadius: '50%', border: `5px solid ${s.accent}`, opacity: 0.8 * (1 - ring(k)) }} />)}
        <div style={{ width: 260, height: 260, borderRadius: '50%', background: `radial-gradient(circle, ${s.accent}, ${s.accent}AA)`, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: `scale(${1 + 0.06 * Math.sin(t * 6)})`, boxShadow: `0 0 90px ${s.accent}` }}>
          <Icon name={sc.icon} size={150} color="#111" />
        </div>
      </div>
      {sc.question && <Headline hl={sc.question} delay={f((sc.questionAt ?? sc.start + 1.5) - sc.start)} top={sc.teaserCode ? 560 : 330} size={80} />}
    </>
  );
};

const LETTERS: Record<string, string> = { '2': 'ABC', '3': 'DEF', '4': 'GHI', '5': 'JKL', '6': 'MNO', '7': 'PQRS', '8': 'TUV', '9': 'WXYZ', '0': '+' };
const DialerScene: React.FC<{ sc: Of<'dialer'> }> = ({ sc }) => {
  const s = useStyle();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = useAbsT(sc.start);
  const typed = sc.keys.filter((k) => t >= k.at).map((k) => k.k).join('');
  const pad = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
  const last = (k: string) => Math.max(-99, ...sc.keys.filter((x) => x.k === k && x.at <= t).map((x) => x.at));
  const callAt = sc.callAt ?? 1e9;
  const callP = t >= callAt ? pop(frame, fps, f(callAt - sc.start)) : 0;
  const k0 = sc.keys[0]?.at ?? sc.start, k1 = Math.min(callAt, (sc.keys.at(-1)?.at ?? sc.start) + 0.8);
  const target = t >= callAt - 0.4 ? 'call' : sc.keys.find((k) => k.at > t - 0.25)?.k;
  const ti = target && target !== 'call' ? pad.indexOf(target) : -1;
  return (
    <>
      <Camera t={t} a={k0 - 0.4} b={k1} origin="540px 900px">
        <Phone>
          <div style={{ position: 'absolute', top: 120, left: 0, right: 0, height: 120, textAlign: 'center' }}>
            <Code style={{ fontSize: typed.length > 8 ? 60 : 84, color: WHITE }}>{typed || ' '}</Code>
            {Math.floor(frame / 15) % 2 === 0 && <span style={{ display: 'inline-block', width: 5, height: 70, background: s.accent, marginLeft: 6, verticalAlign: 'middle' }} />}
          </div>
          <div style={{ position: 'absolute', top: 250, left: 40, right: 40, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', rowGap: 16, justifyItems: 'center' }}>
            {pad.map((k) => {
              const since = t - last(k);
              const hot = since >= 0 && since < 0.35;
              return (
                <div key={k} style={{ width: 96, height: 96, borderRadius: '50%', background: hot ? s.accent : '#151C38', border: `3px solid ${sc.code.includes(k) ? '#3A4A85' : '#1F2A50'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: `scale(${hot ? 1 + 0.18 * Math.sin(Math.PI * (since / 0.35)) : 1})`, boxShadow: hot ? `0 0 40px ${s.accent}` : 'none' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1 }}>
                    <Code style={{ fontSize: 44, letterSpacing: 0, color: hot ? '#111' : WHITE }}>{k}</Code>
                    {LETTERS[k] && <span style={{ fontFamily: 'Helvetica, Arial', fontWeight: 700, fontSize: 13, letterSpacing: 2, marginTop: 4, color: hot ? '#333' : DIM }}>{LETTERS[k]}</span>}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ position: 'absolute', bottom: 44, left: '50%', marginLeft: -60, width: 120, height: 120, borderRadius: '50%', background: s.good, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: `scale(${1 + 0.15 * callP * (1 - ease(t, callAt + 0.2, callAt + 0.6))})`, boxShadow: `0 0 ${20 + 60 * callP}px ${s.good}` }}>
            <Icon name="call" size={66} color="#fff" />
            {callP > 0 && <div style={{ position: 'absolute', width: 120 + 200 * ease(t, callAt, callAt + 0.7), height: 120 + 200 * ease(t, callAt, callAt + 0.7), borderRadius: '50%', border: `5px solid ${s.good}`, opacity: 1 - ease(t, callAt, callAt + 0.7) }} />}
          </div>
          {target === 'call' && <Finger x={248} y={790} />}
          {ti >= 0 && <Finger x={40 + ((ti % 3) + 0.5) * (416 / 3)} y={250 + Math.floor(ti / 3) * 112 + 48} />}
        </Phone>
      </Camera>
      <Headline hl={sc.headline} size={80} top={150} />
    </>
  );
};

/** Settings path: each item lights up and gets tapped when it is said; the next page slides in. */
const SettingsScene: React.FC<{ sc: Of<'settings'> }> = ({ sc }) => {
  const s = useStyle();
  const t = useAbsT(sc.start);
  const ios = sc.os === 'ios';
  // page k shows path[k] as its title; the row for path[k+1] is tapped at at[k+1]
  let page = 0;
  for (let k = 1; k < sc.path.length; k++) if (t >= sc.at[k]! + 0.35) page = k;
  const nextAt = sc.at[page + 1];
  const isLast = page === sc.path.length - 1;
  const slide = page > 0 ? ease(t, sc.at[page]! + 0.35, sc.at[page]! + 0.75) : 1;
  const tapping = nextAt !== undefined && t >= nextAt - 0.3 && t < nextAt + 0.35;
  const toggleAt = isLast ? (sc.at[page] ?? sc.start) + 0.9 : 1e9;
  const on = ease(t, toggleAt, toggleAt + 0.3);
  const rowY = (i: number) => 230 + i * 104;
  const TARGET = 2;
  return (
    <>
      <Camera t={t} a={sc.start + 0.6} b={sc.end - 0.2} origin="540px 1000px">
        <Phone>
          <div style={{ position: 'absolute', inset: 0, background: ios ? '#0E1328' : '#0B1020', transform: `translateX(${(1 - slide) * -500}px)`, opacity: slide }}>
            <div style={{ position: 'absolute', top: 90, left: 30, right: 30, direction: 'rtl', fontFamily, fontWeight: 900, fontSize: ios ? 46 : 40, color: WHITE, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sc.path[page]}</div>
            {[0, 1, 2, 3, 4, 5].map((i) => {
              const label = i === TARGET ? (isLast ? sc.path[page] : sc.path[page + 1]) : undefined;
              const hot = i === TARGET && (tapping || (isLast && t >= toggleAt - 0.4));
              return (
                <div key={i} style={{ position: 'absolute', top: rowY(i), left: 26, right: 26, height: 88, borderRadius: ios ? 22 : 8, background: hot ? `${s.accent}33` : CARD, border: `2px solid ${hot ? s.accent : LINE}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px', direction: 'rtl', transform: `scale(${hot ? 1.04 : 1})` }}>
                  {label
                    ? <span style={{ fontFamily, fontWeight: 900, fontSize: 32, color: WHITE, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 330 }}>{label}</span>
                    : <span style={{ width: 150 + (i * 37) % 120, height: 18, borderRadius: 9, background: '#26335E' }} />}
                  {label && isLast
                    ? <span style={{ width: 84, height: 48, borderRadius: 24, background: on > 0.5 ? s.good : '#3A4570', position: 'relative' }}><span style={{ position: 'absolute', top: 4, left: 4 + 36 * on, width: 40, height: 40, borderRadius: '50%', background: '#fff' }} /></span>
                    : <span style={{ color: DIM, fontSize: 34, fontFamily }}>‹</span>}
                </div>
              );
            })}
            {(tapping || (isLast && t >= toggleAt - 0.4 && t < toggleAt + 0.3)) && <Finger x={isLast ? 90 : 300} y={rowY(TARGET) + 12} />}
          </div>
        </Phone>
      </Camera>
      <Headline hl={sc.headline} size={80} top={150} />
    </>
  );
};

const CardScene: React.FC<{ sc: Of<'card'> }> = ({ sc }) => {
  const s = useStyle();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = useAbsT(sc.start);
  const card = pop(frame, fps, 4);
  const flipped = sc.rows.some((r) => r.then && t >= r.then.at);
  return (
    <>
      <Headline hl={sc.headline} size={80} top={150} />
      {sc.icon && <div style={{ position: 'absolute', top: 290, left: 0, right: 0, display: 'flex', justifyContent: 'center', opacity: ease(t, sc.start + 0.4, sc.start + 0.9) }}><Icon name={sc.icon} size={84} color={s.accent} /></div>}
      <Phone glow={flipped ? s.bad : s.good}>
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(#0F1736, #0A0F22)' }} />
        {sc.alert && <div style={{ position: 'absolute', top: 90, left: 30, right: 30, textAlign: 'center', direction: 'rtl', fontFamily, fontWeight: 900, fontSize: 30, color: '#fff', background: s.bad, borderRadius: 24, padding: '10px 0', opacity: ease(t, sc.alert.at, sc.alert.at + 0.3) }}>{sc.alert.text}</div>}
        <div style={{ position: 'absolute', top: 190, left: 26, right: 26, borderRadius: 34, background: CARD, border: `2px solid ${LINE}`, padding: '30px 26px', direction: 'rtl', fontFamily, transform: `translateY(${(1 - card) * 120}px) scale(${0.9 + 0.1 * card})`, opacity: card }}>
          <div style={{ fontWeight: 900, fontSize: 42, color: WHITE, marginBottom: 22 }}>{sc.title}</div>
          {sc.rows.map((r, i) => {
            const show = ease(t, r.at, r.at + 0.4);
            const cur = r.then && t >= r.then.at ? r.then : r;
            return (
              <div key={i} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', padding: '18px 0', borderTop: i ? `2px solid ${LINE}` : 'none', opacity: show, transform: `translateX(${(1 - show) * -40}px)` }}>
                <div style={{ fontWeight: 800, fontSize: 30, color: DIM, whiteSpace: 'nowrap' }}>{r.label}</div>
                <div style={{ fontWeight: 900, fontSize: 30, color: toneColor(s, cur.tone), whiteSpace: 'nowrap' }}>{cur.value}</div>
                {'detail' in cur && cur.detail && <div style={{ width: '100%', marginTop: 12, textAlign: 'center', padding: '8px 0', borderRadius: 16, background: `${toneColor(s, cur.tone)}22`, border: `2px solid ${toneColor(s, cur.tone)}` }}><Code style={{ fontSize: 28, letterSpacing: 2, color: toneColor(s, cur.tone) }}>{cur.detail}</Code></div>}
              </div>
            );
          })}
        </div>
      </Phone>
    </>
  );
};

const AlertScene: React.FC<{ sc: Of<'alert'> }> = ({ sc }) => {
  const s = useStyle();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = useAbsT(sc.start);
  const col = sc.tone === 'bad' ? s.bad : s.good;
  const a = pop(frame, fps, 2);
  const shake = sc.tone === 'bad' ? Math.sin(t * 60) * 8 * (1 - ease(t, sc.start, sc.start + 0.8)) : 0;
  const b = sc.action ? pop(frame, fps, f(sc.action.at - sc.start)) : 0;
  return (
    <>
      <AbsoluteFill style={{ background: `radial-gradient(circle at 50% 40%, ${col}${Math.round(40 + 25 * Math.sin(t * 6)).toString(16)} 0%, transparent 55%)` }} />
      <Headline hl={sc.headline} size={84} top={170} />
      <div style={{ position: 'absolute', top: 470, left: 0, right: 0, display: 'flex', justifyContent: 'center', transform: `translateX(${shake}px) scale(${a})` }}>
        <Icon name={sc.icon} size={330} color={col} style={{ filter: `drop-shadow(0 0 40px ${col})` }} />
      </div>
      {sc.action && (
        <div style={{ position: 'absolute', top: 1010, left: 90, right: 90, borderRadius: 40, background: CARD, border: `3px solid ${s.good}`, padding: 32, display: 'flex', alignItems: 'center', gap: 28, direction: 'rtl', transform: `translateY(${(1 - b) * 200}px)`, opacity: b }}>
          <div style={{ width: 140, height: 140, borderRadius: '50%', background: s.good, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icon name={sc.action.icon} size={90} color="#fff" /></div>
          <div style={{ fontFamily, fontWeight: 900, fontSize: 48, lineHeight: 1.3, color: WHITE }}><Rich hl={{ text: sc.action.text, accent: sc.action.accent, tone: 'green' }} /></div>
        </div>
      )}
    </>
  );
};

const CompatScene: React.FC<{ sc: Of<'compat'> }> = ({ sc }) => {
  const s = useStyle();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const g = sc.badge ? pop(frame, fps, f((sc.badgeAt ?? sc.start + 1) - sc.start)) : 0;
  const items = sc.items.slice(0, 3);
  const w = items.length > 2 ? 250 : 300;
  return (
    <>
      <Headline hl={sc.headline} size={84} top={190} />
      <div style={{ position: 'absolute', top: 500, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 50, direction: 'rtl' }}>
        {items.map((label, i) => {
          const p = pop(frame, fps, 4 + i * 8);
          return (
            <div key={i} style={{ width: w, height: 560, borderRadius: i % 2 ? 36 : 60, background: '#0A0F22', border: '10px solid #2B3760', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 30, transform: `translateY(${(1 - p) * 300}px)`, opacity: p }}>
              {sc.code && <Code style={{ fontSize: 44, color: s.accent, letterSpacing: 2 }}>{sc.code}</Code>}
              <div style={{ width: 120, height: 120, borderRadius: '50%', background: s.good, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: `scale(${pop(frame, fps, 14 + i * 8)})` }}><Icon name="check" size={84} color="#fff" /></div>
              <div style={{ fontFamily, fontWeight: 900, fontSize: 44, color: WHITE, textAlign: 'center', padding: '0 10px' }}>{label}</div>
            </div>
          );
        })}
      </div>
      {sc.badge && (
        <div style={{ position: 'absolute', top: 1140, left: 0, right: 0, textAlign: 'center', transform: `scale(${g})` }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 16, padding: '14px 40px', borderRadius: 60, background: '#1E2A55', border: `3px solid ${s.accent}`, fontFamily, fontWeight: 900, fontSize: 44, color: WHITE, direction: 'rtl' }}>
            <Icon name="antenna" size={50} color={s.accent} /> {sc.badge}
          </span>
        </div>
      )}
    </>
  );
};

const CtaScene: React.FC<{ sc: Of<'cta'>; endCard: string }> = ({ sc, endCard }) => {
  const s = useStyle();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = useAbsT(sc.start);
  const sh = pop(frame, fps, 2);
  const glow = 0.6 + 0.4 * Math.sin(t * 5);
  const follow = pop(frame, fps, f(sc.followAt - sc.start));
  return (
    <>
      <Headline hl={sc.headline} size={90} top={190} />
      <div style={{ position: 'absolute', top: 430, left: 0, right: 0, display: 'flex', justifyContent: 'center', transform: `scale(${sh})` }}>
        <div style={{ position: 'relative', width: 460, height: 460, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="shield" size={460} color={s.good} style={{ position: 'absolute', filter: `drop-shadow(0 0 ${40 * glow}px ${s.good})`, opacity: sc.code ? 0.25 : 0.9 }} />
          {sc.code && <Code style={{ fontSize: sc.code.length > 7 ? 84 : 120, color: s.accent, textShadow: `0 0 ${50 * glow}px ${s.accent}` }}>{sc.code}</Code>}
          {!sc.code && sc.icon && <Icon name={sc.icon} size={160} color="#111" style={{ position: 'relative' }} />}
        </div>
      </div>
      {sc.sub && <Headline hl={sc.sub} size={70} top={960} delay={f((sc.subAt ?? sc.start + 1) - sc.start)} />}
      <div style={{ position: 'absolute', top: 1120, left: 0, right: 0, textAlign: 'center', transform: `scale(${follow})`, opacity: follow }}>
        <span style={{ display: 'inline-block', padding: '18px 46px', borderRadius: 60, background: s.accent, fontFamily, fontWeight: 900, fontSize: 46, color: '#111', direction: 'rtl' }}>{endCard}</span>
      </div>
    </>
  );
};

const StatementScene: React.FC<{ sc: Of<'statement'> }> = ({ sc }) => {
  const s = useStyle();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = useAbsT(sc.start);
  const a = pop(frame, fps, 2);
  return (
    <>
      <Headline hl={sc.headline} size={84} top={180} />
      <div style={{ position: 'absolute', top: 430, left: 0, right: 0, display: 'flex', justifyContent: 'center', transform: `scale(${a}) rotate(${Math.sin(t * 2) * 3}deg)` }}>
        <div style={{ width: 300, height: 300, borderRadius: 80, background: `linear-gradient(135deg, ${s.accent}, ${s.accent}99)`, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 0 90px ${s.accent}88` }}><Icon name={sc.icon} size={180} color="#111" /></div>
      </div>
      <div style={{ position: 'absolute', top: 820, left: 90, right: 90, display: 'flex', flexDirection: 'column', gap: 26, direction: 'rtl' }}>
        {sc.lines.slice(0, 3).map((l, i) => {
          const p = pop(frame, fps, f(l.at - sc.start));
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 22, padding: '22px 30px', borderRadius: 30, background: CARD, border: `2px solid ${LINE}`, opacity: p, transform: `translateX(${(1 - p) * 120}px)` }}>
              <Icon name="check" size={52} color={s.good} />
              <span style={{ fontFamily, fontWeight: 800, fontSize: 42, color: WHITE }}>{l.text}</span>
            </div>
          );
        })}
      </div>
    </>
  );
};

const SceneView: React.FC<{ sc: MotionScene; endCard: string }> = ({ sc, endCard }) => {
  switch (sc.type) {
    case 'hook': return <HookScene sc={sc} />;
    case 'dialer': return <DialerScene sc={sc} />;
    case 'settings': return <SettingsScene sc={sc} />;
    case 'card': return <CardScene sc={sc} />;
    case 'alert': return <AlertScene sc={sc} />;
    case 'compat': return <CompatScene sc={sc} />;
    case 'cta': return <CtaScene sc={sc} endCard={endCard} />;
    default: return <StatementScene sc={sc as Of<'statement'>} />;
  }
};

const Captions: React.FC<{ caps: MotionPlan['captions'] }> = ({ caps }) => {
  const s = useStyle();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const cur = caps.find((c) => t >= c.a && t < c.b);
  if (!cur) return null;
  const words = cur.text.split(' ');
  const idx = Math.min(words.length - 1, Math.floor(((t - cur.a) / Math.max(0.1, cur.b - cur.a)) * words.length));
  const p = pop(frame, fps, f(cur.a));
  return (
    <div style={{ position: 'absolute', top: 1480, left: 70, right: 70, textAlign: 'center', direction: 'rtl', fontFamily, fontWeight: 900, fontSize: s.captionSize, lineHeight: 1.35, transform: `scale(${0.8 + 0.2 * p})`, opacity: p }}>
      {words.map((w, i) => (
        <span key={i} style={{ display: 'inline-block', margin: '0 9px', padding: '0 10px', borderRadius: 14, color: i === idx ? '#111' : WHITE, background: i === idx ? s.accent : 'transparent', transform: `scale(${i === idx ? 1.08 : 1})`, WebkitTextStroke: i === idx ? '0' : '2px rgba(0,0,0,0.5)', textShadow: i === idx ? 'none' : '0 4px 18px rgba(0,0,0,0.8)' }}>{w}</span>
      ))}
    </div>
  );
};

export const MotionShort: React.FC<MotionPlan> = (plan) => {
  const s = plan.style;
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const t = frame / FPS;
  const cur = plan.scenes.find((x) => t >= x.start && t < x.end) ?? plan.scenes.at(-1);
  const tint = cur?.type === 'alert' ? (cur.tone === 'bad' ? s.bad : s.good) : cur?.type === 'cta' || cur?.type === 'compat' ? s.good
    : cur?.type === 'card' && cur.rows.some((r) => r.then && t >= r.then.at) ? s.bad : s.accent;
  const kick = Math.max(0, ...plan.beats.map((b) => (t >= b && t < b + 0.3 ? Math.sin((Math.PI * (t - b)) / 0.3) : 0)));
  const flash = Math.max(0, ...plan.beats.map((b) => (t >= b && t < b + 0.25 ? 1 - (t - b) / 0.25 : 0)));
  const sfx: [string, number, number][] = [
    ...plan.scenes.slice(1).map((x) => ['whoosh', x.start, 0.4] as [string, number, number]),
    ...plan.beats.map((b) => ['pop', b, 0.5] as [string, number, number]),
    ...plan.scenes.flatMap((x) => (x.type === 'dialer' ? x.keys.map((k) => ['tap', k.at, 0.5] as [string, number, number]) : x.type === 'settings' ? x.at.slice(1).map((a) => ['tap', a, 0.5] as [string, number, number]) : x.type === 'alert' && x.tone === 'bad' ? [['alert', x.start + 0.1, 0.35] as [string, number, number]] : [])),
  ];
  return (
    <StyleCtx.Provider value={s}>
      <AbsoluteFill style={{ background: s.bg1 }}>
        <Background tint={tint} />
        {s.particles && <Particles color={tint} />}
        <AbsoluteFill style={{ transform: `scale(${1 + 0.03 * kick})` }}>
          {plan.scenes.map((sc, i) => (
            <Sequence key={i} from={f(sc.start)} durationInFrames={Math.max(1, f(sc.end - sc.start) + 10)}>
              <Shell len={f(sc.end - sc.start)} instant={i === 0}><SceneView sc={sc} endCard={plan.endCard} /></Shell>
            </Sequence>
          ))}
        </AbsoluteFill>
        <AbsoluteFill style={{ background: '#fff', opacity: s.flash * flash }} />
        <Captions caps={plan.captions} />
        <div style={{ position: 'absolute', top: 0, left: 0, height: 10, width: `${(frame / durationInFrames) * 100}%`, background: s.accent, boxShadow: `0 0 20px ${s.accent}` }} />
        <div style={{ position: 'absolute', top: 60, right: 60, fontFamily, fontWeight: 800, fontSize: 34, color: DIM, direction: 'rtl' }}>{plan.brand}</div>
        {plan.audio && <Audio src={staticFile(plan.audio)} />}
        {sfx.map(([n, at, vol], i) => <Sequence key={`s${i}`} from={Math.max(0, f(at))}><Audio src={staticFile(`sfx/${n}.wav`)} volume={vol} /></Sequence>)}
      </AbsoluteFill>
    </StyleCtx.Provider>
  );
};
