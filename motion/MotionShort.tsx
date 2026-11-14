/**
 * Motion-graphics Short: every second is drawn to show exactly what the narrator says at that second.
 * Scene types: hook, dialer (code typed key by key), settings (path tapped page by page), card (a result/message
 * screen), alert, compat (works on…), cta, statement (generic). Style (camera, transitions, captions…) comes from
 * the plan, so the team can tune it over time.
 */
import React from 'react';
import { AbsoluteFill, Audio, Easing, Img, Sequence, cancelRender, continueRender, delayRender, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { Lottie, type LottieAnimationData } from '@remotion/lottie';
import { fitText } from '@remotion/layout-utils';
import { loadFont } from '@remotion/google-fonts/Cairo';
import type { Hl, IconName, MotionPlan, MotionScene, MotionStyle, Prop, Tone, Variants } from './types';
import { soundPlan, type Trans } from './edit';

const { fontFamily } = loadFont('normal', { weights: ['600', '800', '900'], subsets: ['arabic', 'latin'] });
export const FPS = 30;

// Colours of text/cards come from the theme (CSS variables), so the same scenes work on dark and light looks.
const WHITE = 'var(--text)', DIM = 'var(--dim)', CARD = 'var(--card)', LINE = 'var(--line)', CHIP = 'var(--chip)';
interface Theme { bg1: string; bg2: string; text: string; dim: string; card: string; line: string; chip: string; dot: string; accent: string; good: string; bad: string }
/** Colour themes (a design gene): every Short can look different. */
const THEMES: Record<string, Theme> = {
  // The channel's identity (owner's reference): calm charcoal, white text, ONE orange accent.
  studio: { bg1: '#111216', bg2: '#1B1D24', text: '#FFFFFF', dim: '#9EA2AD', card: '#1C1E25', line: '#2F323C', chip: '#25272F', dot: 'rgba(255,255,255,0.055)', accent: '#FF9F1C', good: '#2BD576', bad: '#FF5A4E' },
  night: { bg1: '#070B1A', bg2: '#12204A', text: '#FFFFFF', dim: '#9AA6C8', card: '#141C36', line: '#26335E', chip: '#1E2A55', dot: 'rgba(255,255,255,0.07)', accent: '#FFD23F', good: '#22C55E', bad: '#FF4D4D' },
  light: { bg1: '#F4F6FB', bg2: '#D9E2F7', text: '#0E1430', dim: '#56607F', card: '#FFFFFF', line: '#D3DAEA', chip: '#E3E9F7', dot: 'rgba(14,20,48,0.08)', accent: '#EA580C', good: '#16A34A', bad: '#E11D48' },
  pop: { bg1: '#1E0745', bg2: '#6D28D9', text: '#FFFFFF', dim: '#D8CCFF', card: '#33126B', line: '#5B2BA8', chip: '#45198F', dot: 'rgba(255,255,255,0.09)', accent: '#22E3FF', good: '#2EE59D', bad: '#FF4D6D' },
  teal: { bg1: '#021716', bg2: '#0F766E', text: '#FFFFFF', dim: '#A7D7D2', card: '#0B2E2C', line: '#155E58', chip: '#134E4A', dot: 'rgba(255,255,255,0.08)', accent: '#FDE047', good: '#4ADE80', bad: '#FB7185' },
  sunset: { bg1: '#180808', bg2: '#9A3412', text: '#FFFFFF', dim: '#F6CDB9', card: '#2A110E', line: '#5C2A1E', chip: '#3D1912', dot: 'rgba(255,255,255,0.08)', accent: '#FFD166', good: '#34D399', bad: '#FF5C5C' },
};
const vars = (t: Theme) => ({ '--text': t.text, '--dim': t.dim, '--card': t.card, '--line': t.line, '--chip': t.chip, '--dot': t.dot }) as React.CSSProperties;
/** Inside a drawn phone the screen is always dark, whatever the theme. */
const DARK = vars(THEMES.night!);
const StyleCtx = React.createContext<MotionStyle>(null as unknown as MotionStyle);
/** The video's main object (3D image path) — drawn wherever a generic icon used to be. */
const HeroCtx = React.createContext<string | undefined>(undefined);
/** The main object (3D, floating) when there is one, else the scene's icon. */
const Hero: React.FC<{ icon?: IconName; size: number; color: string; style?: React.CSSProperties }> = ({ icon, size, color, style }) => {
  const hero = React.useContext(HeroCtx);
  const t = useCurrentFrame() / FPS;
  if (hero) return <Img data-avoid="hero" src={staticFile(hero)} style={{ width: size * 1.35, height: size * 1.35, objectFit: 'contain', transform: `translateY(${8 * Math.sin(t * 2.2)}px) rotate(${3 * Math.sin(t * 1.4)}deg)`, filter: 'drop-shadow(0 18px 26px rgba(0,0,0,.45))', ...style }} />;
  return icon ? <Icon name={icon} size={size} color={color} style={style} /> : null;
};
const useStyle = () => React.useContext(StyleCtx);
const V = (s: MotionStyle): Variants => ({ theme: 'studio', bg: 'dots', caption: 'highlight', transition: s.transition, hook: 'rings', headline: 'pop', phone: 'flat', ...(s.variants ?? {}) });
const toneColor = (s: MotionStyle, t?: Tone | 'good' | 'bad' | 'neutral') => (t === 'green' || t === 'good' ? s.good : t === 'red' || t === 'bad' ? s.bad : t === 'neutral' ? DIM : s.accent);

const f = (s: number) => Math.round(s * FPS);
const ease = (t: number, a: number, b: number) => interpolate(t, [a, b], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
// Snappy (≈ 0.25 s, small overshoot): professional motion grabs the eye, it never floats in.
const pop = (frame: number, fps: number, delay = 0) => spring({ frame: frame - delay, fps, config: { damping: 13, stiffness: 300, mass: 0.55 } });
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
  const bg = V(s).bg;
  return (
    <AbsoluteFill style={{ background: `radial-gradient(circle at ${x}% ${y}%, ${tint}55 0%, transparent 45%), radial-gradient(circle at ${100 - x}% ${100 - y}%, ${s.bg2} 0%, ${s.bg1} 70%)` }}>
      {bg === 'dots' && <AbsoluteFill style={{ backgroundImage: 'radial-gradient(var(--dot) 2px, transparent 2px)', backgroundSize: '48px 48px', transform: `translateY(${(t * 12) % 48}px)` }} />}
      {bg === 'grid' && <AbsoluteFill style={{ backgroundImage: 'linear-gradient(var(--dot) 2px, transparent 2px), linear-gradient(90deg, var(--dot) 2px, transparent 2px)', backgroundSize: '90px 90px', transform: `perspective(900px) rotateX(35deg) translateY(${(t * 40) % 90}px) scale(1.6)`, transformOrigin: '50% 100%' }} />}
      {bg === 'waves' && (
        <svg width={1080} height={1920} style={{ position: 'absolute', inset: 0 }}>
          {[0, 1, 2, 3].map((k) => {
            const y0 = 1250 + k * 160, amp = 40 + k * 12, ph = t * (0.8 + k * 0.25) + k;
            const d = Array.from({ length: 28 }, (_, i) => `${i === 0 ? 'M' : 'L'}${i * 40} ${y0 + amp * Math.sin(i * 0.35 + ph)}`).join(' ') + ' L1080 1920 L0 1920 Z';
            return <path key={k} d={d} fill={tint} opacity={0.07 + k * 0.025} />;
          })}
        </svg>
      )}
      {bg === 'blobs' && [0, 1, 2].map((k) => (
        <div key={k} style={{ position: 'absolute', width: 700, height: 700, borderRadius: '50%', left: 190 + 360 * Math.sin(t * (0.3 + k * 0.15) + k * 2), top: 300 + k * 450 + 140 * Math.cos(t * (0.25 + k * 0.1) + k), background: k === 1 ? s.good : tint, opacity: 0.16, filter: 'blur(120px)' }} />
      ))}
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

const Shell: React.FC<{ len: number; children: React.ReactNode; instant?: boolean; kind?: Trans }> = ({ len, children, instant, kind: cut }) => {
  const s = useStyle();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // fast in (≈ 7 frames) with a punch, fast out (4 frames) with motion blur in the direction of travel
  const inn = instant ? 1 : spring({ frame, fps, config: { damping: 20, stiffness: 420, mass: 0.6 } });
  const out = interpolate(frame, [len - 2, len + 3], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.in(Easing.quad) });
  const op = Math.min(1, inn * 2.2) * (1 - out);
  const kind = cut ?? V(s).transition;
  const tr = kind === 'punch' ? `scale(${1.28 - 0.28 * inn + out * 0.12}) rotate(${(1 - inn) * -3}deg)`
    : kind === 'whip'
    ? `translateX(${(1 - inn) * -900 + out * 900}px) scale(${1.08 - 0.08 * inn}) skewX(${(1 - inn) * 10 - out * 10}deg)`
    : kind === 'zoom' ? `scale(${1.35 - 0.35 * inn + out * 0.5})`
    : kind === 'rise' ? `translateY(${(1 - inn) * 520 - out * 520}px) scale(${1.06 - 0.06 * inn})` : `scale(${1.12 - 0.12 * inn + out * 0.1})`;
  const blur = (1 - inn) * 12 + out * 12;
  return <AbsoluteFill style={{ opacity: op, transform: tr, filter: `blur(${blur}px)` }}>{children}</AbsoluteFill>;
};

const Headline: React.FC<{ hl: Hl; delay?: number; size?: number; top?: number; instant?: boolean }> = ({ hl, delay = 0, size = 88, top = 170, instant }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = instant ? 1 : pop(frame, fps, delay);
  const st = useStyle();
  // Measured with the real font: always ONE line (a wrapped headline would cover what is drawn under it).
  const fit = oneLine(hl.text, size, V(st).headline === 'stagger' && !instant ? hl.text.split(/\s+/).length * 20 : 0);
  if (!instant && V(st).headline === 'stagger') {
    const accent = new Set((hl.accent ?? '').split(/\s+/).filter(Boolean));
    return (
      <div style={{ position: 'absolute', top, left: 50, right: 50, textAlign: 'center', direction: 'rtl', fontFamily, fontWeight: 900, fontSize: fit, lineHeight: 1.25, color: WHITE, textShadow: '0 8px 30px rgba(0,0,0,0.5)' }}>
        <span data-qa="headline" style={{ display: 'inline-block' }}>{hl.text.split(/\s+/).map((w, i) => {
          const q = pop(frame, fps, delay + i * 2);
          return <span key={i} style={{ display: 'inline-block', margin: '0 10px', opacity: q, transform: `translateY(${(1 - q) * 60}px) rotate(${(1 - q) * -8}deg)`, color: accent.has(w) ? toneColor(st, hl.tone) : WHITE }}>{w}</span>;
        })}</span>
      </div>
    );
  }
  return (
    <div style={{ position: 'absolute', top, left: 60, right: 60, textAlign: 'center', direction: 'rtl', fontFamily, fontWeight: 900, fontSize: fit, lineHeight: 1.25, color: WHITE, opacity: p, transform: `translateY(${(1 - p) * 40}px) scale(${0.85 + 0.15 * p})`, textShadow: '0 8px 30px rgba(0,0,0,0.5)', whiteSpace: 'nowrap' }}><span data-qa="headline" style={{ display: 'inline-block' }}><Rich hl={hl} /></span></div>
  );
};

/** Largest font size (≤ max) that keeps `text` on one line inside the 960 px text column. */
function oneLine(text: string, max: number, extra = 0): number {
  try {
    const { fontSize } = fitText({ text, withinWidth: 940 - extra, fontFamily, fontWeight: 900, validateFontIsLoaded: false });
    return Math.max(40, Math.min(max, Math.floor(fontSize * 0.94)));
  } catch { return Math.max(40, Math.min(max, Math.floor(1900 / Math.max(1, text.length)))); }
}

/**
 * Layout guard: on every frame, any two visible texts (headline, captions, codes, cards…) that overlap stop the
 * render with LAYOUT_OVERLAP — the Short is then re-planned or not published. Text on top of text never ships.
 */
const LayoutGuard: React.FC = () => {
  const frame = useCurrentFrame();
  React.useLayoutEffect(() => {
    const vis = [...document.querySelectorAll<HTMLElement>('[data-qa]')].map((el) => {
      let o = 1;
      for (let n: HTMLElement | null = el; n; n = n.parentElement) { const cs = getComputedStyle(n); o *= Number(cs.opacity); if (cs.display === 'none' || cs.visibility === 'hidden') o = 0; }
      return { el, o, r: el.getBoundingClientRect() };
    }).filter((x) => x.o > 0.6 && x.r.width > 2 && x.r.height > 2);
    for (let i = 0; i < vis.length; i++) for (let j = i + 1; j < vis.length; j++) {
      const a = vis[i]!.r, b = vis[j]!.r;
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 6 && h > 6 && w * h > 0.06 * Math.min(a.width * a.height, b.width * b.height)) {
        cancelRender(new Error(`LAYOUT_OVERLAP frame ${frame}: "${(vis[i]!.el.textContent ?? '').slice(0, 40)}" × "${(vis[j]!.el.textContent ?? '').slice(0, 40)}"`));
        return;
      }
    }
  }, [frame]);
  return null;
};

const Phone: React.FC<{ children: React.ReactNode; top?: number; glow?: string }> = ({ children, top = 470, glow }) => {
  const s = useStyle();
  const t = useCurrentFrame() / FPS;
  const tilt = V(s).phone === 'tilt';
  const sweep = ((t * 0.45) % 1.4) - 0.2;
  return (
    <div style={{ position: 'absolute', inset: 0, perspective: 1800 }}>
    <div style={{ ...DARK, position: 'absolute', top, left: '50%', width: 520, height: 900, marginLeft: -260, borderRadius: 74, transform: tilt ? `rotateY(${-10 + 4 * Math.sin(t * 0.8)}deg) rotateX(${5 + 2 * Math.cos(t * 0.6)}deg)` : undefined, transformStyle: 'preserve-3d', background: '#0A0F22', border: '12px solid #2B3760', boxShadow: `0 40px 120px rgba(0,0,0,0.6), 0 0 80px ${glow ?? s.accent}33`, overflow: 'hidden' }}>
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
  return <AbsoluteFill style={{ transformOrigin: origin, transform: `scale(${1 + 0.2 * k}) rotate(${-2 * k}deg)` }}>{children}</AbsoluteFill>;
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
        <div style={{ width: 150, height: 150, borderRadius: 44, background: s.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 0 70px ${s.accent}`, transform: `rotate(${Math.sin(t * 3) * 6}deg)` }}><Hero icon={sc.icon} size={96} color="#111" /></div>
      </div>
      <div style={{ position: 'absolute', top: 470, left: 50, right: 50, textAlign: 'center', direction: 'rtl', fontFamily, fontWeight: 900, fontSize: size, lineHeight: 1.15, transform: `translate(${shake * Math.sin(frame)}px, ${shake * Math.cos(frame)}px)` }}>
        <span data-qa="slam">{words.map((w, i) => {
          const q = frame >= i * per ? spring({ frame: frame - i * per, fps, config: { damping: 9, stiffness: 260, mass: 0.6 } }) : 0;
          return <span key={i} style={{ display: 'inline-block', margin: '0 14px', opacity: Math.min(1, q * 2), transform: `scale(${2.2 - 1.2 * q})`, color: accent.has(w) ? toneColor(s, sc.headline.tone) : WHITE, textShadow: `0 10px 40px rgba(0,0,0,0.6)` }}>{w}</span>;
        })}</span>
      </div>
      {sc.teaserCode && (
        <div style={{ position: 'absolute', top: 1080, left: 0, right: 0, textAlign: 'center', opacity: ease(t, sc.start + 0.6, sc.start + 1) }}>
          <span data-qa="teaser" style={{ display: 'inline-block', padding: '12px 46px', borderRadius: 30, background: CHIP, border: `3px ${t < reveal ? 'dashed' : 'solid'} ${s.accent}` }}>
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
          <div style={{ width: 230, height: 230, borderRadius: '50%', background: s.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 0 90px ${s.accent}` }}><Hero icon={sc.icon} size={140} color="#111" /></div>
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
          <span data-qa="teaser" style={{ display: 'inline-block', padding: '10px 40px', borderRadius: 30, background: CHIP, border: `3px ${t < reveal ? 'dashed' : 'solid'} ${s.accent}` }}>
            <Code style={{ fontSize: 72, color: s.accent, filter: `blur(${(1 - ease(t, reveal, reveal + 0.3)) * (10 - 3 * Math.abs(Math.sin(t * 3)))}px)` }}>{sc.teaserCode}</Code>
          </span>
        </div>
      )}
      <div style={{ position: 'absolute', top: 800, left: 0, right: 0, height: 520, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {[0, 1, 2].map((k) => <div key={k} style={{ position: 'absolute', width: 220 + 380 * ring(k), height: 220 + 380 * ring(k), borderRadius: '50%', border: `5px solid ${s.accent}`, opacity: 0.8 * (1 - ring(k)) }} />)}
        <div style={{ width: 260, height: 260, borderRadius: '50%', background: `radial-gradient(circle, ${s.accent}, ${s.accent}AA)`, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: `scale(${1 + 0.06 * Math.sin(t * 6)})`, boxShadow: `0 0 90px ${s.accent}` }}>
          <Hero icon={sc.icon} size={150} color="#111" />
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
      <Camera t={t} a={k0 - 0.4} b={k1} origin="540px 940px">
        <Phone>
          <div style={{ position: 'absolute', top: 120, left: 0, right: 0, height: 120, textAlign: 'center' }}>
            <span data-qa="typed"><Code style={{ fontSize: typed.length > 8 ? 60 : 84, color: WHITE }}>{typed || ' '}</Code></span>
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
          {target === 'call' && <Finger x={248} y={730} />}
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
      <Camera t={t} a={sc.start + 0.6} b={sc.end - 0.2} origin="540px 940px">
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

/**
 * Inside the app: its coloured header and name, one screen per step; the step's row lights up and is tapped
 * exactly when it is said, the next screen slides in; after the last step a green "done" toast.
 */
const AppScene: React.FC<{ sc: Of<'app'> }> = ({ sc }) => {
  const s = useStyle();
  const t = useAbsT(sc.start);
  const n = sc.steps.length;
  let k = 0;
  for (let i = 1; i < n; i++) if (t >= sc.at[i]! - 0.15) k = i;
  const at = sc.at[k] ?? sc.start;
  const slide = k > 0 ? ease(t, at - 0.15, at + 0.25) : ease(t, sc.start, sc.start + 0.4);
  const tap = t >= at + 0.15 && t < at + 0.65;
  const lastDone = t >= (sc.at[n - 1] ?? sc.start) + 0.8;
  const toast = ease(t, (sc.at[n - 1] ?? sc.start) + 0.8, (sc.at[n - 1] ?? sc.start) + 1.1);
  const rowY = (i: number) => 300 + i * 100;
  const TARGET = 1 + (k % 3);
  const initial = sc.app.trim().charAt(0);
  return (
    <>
      <Camera t={t} a={sc.start + 0.5} b={sc.end - 0.2} origin="540px 940px">
        <Phone glow={sc.color}>
          <div style={{ position: 'absolute', inset: 0, background: '#0B1020' }} />
          {/* app header */}
          <div style={{ position: 'absolute', top: 64, left: 0, right: 0, height: 120, background: `linear-gradient(120deg, ${sc.color}, ${sc.color2})`, display: 'flex', alignItems: 'center', gap: 18, padding: '0 28px', direction: 'rtl' }}>
            <div style={{ width: 70, height: 70, borderRadius: 20, background: 'rgba(255,255,255,0.22)', border: '3px solid rgba(255,255,255,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily, fontWeight: 900, fontSize: 40, color: '#fff' }}>{initial}</div>
            <div style={{ fontFamily, fontWeight: 900, fontSize: 40, color: '#fff', whiteSpace: 'nowrap' }}>{sc.app}</div>
            <div style={{ marginRight: 'auto', fontFamily, fontWeight: 800, fontSize: 28, color: '#fff', background: 'rgba(0,0,0,0.25)', borderRadius: 20, padding: '4px 16px' }}>{k + 1}/{n}</div>
          </div>
          {/* the screen of step k */}
          <div style={{ position: 'absolute', top: 200, left: 0, right: 0, bottom: 0, transform: `translateX(${(1 - slide) * -480}px)`, opacity: slide }}>
            {[0, 1, 2, 3, 4].map((i) => {
              const label = i === TARGET ? sc.steps[k] : undefined;
              const hot = i === TARGET && (tap || (k === n - 1 && lastDone));
              const doneRow = hot && k === n - 1 && lastDone;
              return (
                <div key={i} style={{ position: 'absolute', top: rowY(i) - 200, left: 24, right: 24, height: label ? 96 : 76, borderRadius: 22, background: doneRow ? `${s.good}33` : hot ? `${sc.color}44` : label ? '#18213F' : CARD, border: `3px solid ${doneRow ? s.good : label ? sc.color : LINE}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 22px', direction: 'rtl', transform: `scale(${hot ? 1.05 : 1})`, boxShadow: label ? `0 0 ${hot ? 40 : 18}px ${sc.color}66` : 'none' }}>
                  {label
                    ? <span style={{ fontFamily, fontWeight: 900, fontSize: Math.max(24, Math.min(34, Math.floor(720 / Math.max(10, label.length)))), color: WHITE, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 380 }}>{label}</span>
                    : <span style={{ width: 130 + (i * 53) % 140, height: 16, borderRadius: 8, background: '#26335E' }} />}
                  {label && <span style={{ color: doneRow ? s.good : sc.color, fontSize: 36, fontWeight: 900, fontFamily }}>{doneRow ? '✓' : '‹'}</span>}
                </div>
              );
            })}
            {tap && <Finger x={300} y={rowY(TARGET) - 200 + 16} />}
          </div>
          {sc.done && toast > 0 && (
            <div style={{ position: 'absolute', bottom: 46, left: 24, right: 24, borderRadius: 24, background: s.good, padding: '16px 18px', direction: 'rtl', fontFamily, fontWeight: 900, fontSize: 28, color: '#08240f', textAlign: 'center', opacity: toast, transform: `translateY(${(1 - toast) * 60}px)` }}>✓ {sc.done}</div>
          )}
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
      {sc.icon && <div style={{ position: 'absolute', top: 290, left: 0, right: 0, display: 'flex', justifyContent: 'center', opacity: ease(t, sc.start + 0.4, sc.start + 0.9) }}><Hero icon={sc.icon} size={84} color={s.accent} /></div>}
      <Camera t={t} a={sc.start + 0.3} b={sc.end + 0.6} origin="540px 900px">
      <Phone glow={flipped ? s.bad : s.good}>
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(#0F1736, #0A0F22)' }} />
        {sc.alert && <div style={{ position: 'absolute', top: 90, left: 30, right: 30, textAlign: 'center', direction: 'rtl', fontFamily, fontWeight: 900, fontSize: 30, color: '#fff', background: s.bad, borderRadius: 24, padding: '10px 0', opacity: ease(t, sc.alert.at, sc.alert.at + 0.3) }}>{sc.alert.text}</div>}
        <div data-qa="card" style={{ position: 'absolute', top: 190, left: 26, right: 26, borderRadius: 34, background: CARD, border: `2px solid ${LINE}`, padding: '30px 26px', direction: 'rtl', fontFamily, transform: `translateY(${(1 - card) * 120}px) scale(${0.9 + 0.1 * card})`, opacity: card }}>
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
      </Camera>
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
        <div data-qa="action" style={{ position: 'absolute', top: 1010, left: 90, right: 90, borderRadius: 40, background: CARD, border: `3px solid ${s.good}`, padding: 32, display: 'flex', alignItems: 'center', gap: 28, direction: 'rtl', transform: `translateY(${(1 - b) * 200}px)`, opacity: b }}>
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
            <div key={i} style={{ ...DARK, width: w, height: 560, borderRadius: i % 2 ? 36 : 60, background: '#0A0F22', border: '10px solid #2B3760', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 30, transform: `translateY(${(1 - p) * 300}px)`, opacity: p }}>
              {sc.code && <Code style={{ fontSize: 44, color: s.accent, letterSpacing: 2 }}>{sc.code}</Code>}
              <div style={{ width: 120, height: 120, borderRadius: '50%', background: s.good, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: `scale(${pop(frame, fps, 14 + i * 8)})` }}><Icon name="check" size={84} color="#fff" /></div>
              <div style={{ fontFamily, fontWeight: 900, fontSize: 44, color: WHITE, textAlign: 'center', padding: '0 10px' }}>{label}</div>
            </div>
          );
        })}
      </div>
      {sc.badge && (
        <div style={{ position: 'absolute', top: 1140, left: 0, right: 0, textAlign: 'center', transform: `scale(${g})` }}>
          <span data-qa="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 16, padding: '14px 40px', borderRadius: 60, background: CHIP, border: `3px solid ${s.accent}`, fontFamily, fontWeight: 900, fontSize: 44, color: WHITE, direction: 'rtl' }}>
            <Icon name="antenna" size={50} color={s.accent} /> {sc.badge}
          </span>
        </div>
      )}
    </>
  );
};

/** "Why pay?": the paid tool's card is crossed out the moment the free tool is named, then the free card pops in. */
const VersusScene: React.FC<{ sc: Of<'versus'> }> = ({ sc }) => {
  const s = useStyle();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = useAbsT(sc.start);
  const inP = pop(frame, fps, 3);
  const cut = ease(t, sc.freeAt - 0.15, sc.freeAt + 0.35);
  const fr = pop(frame, fps, f(sc.freeAt - sc.start));
  const card = (border: string): React.CSSProperties => ({ ...DARK, position: 'absolute', left: 110, right: 110, borderRadius: 48, background: '#0A0F22', border: `8px solid ${border}`, display: 'flex', alignItems: 'center', gap: 36, padding: '0 54px', direction: 'rtl' });
  return (
    <>
      <Headline hl={sc.headline} size={88} top={190} />
      <div data-qa="paid" style={{ ...card(s.bad), top: 470, height: 290, opacity: 1 - 0.45 * cut, transform: `translateX(${(1 - inP) * -700}px) scale(${1 - 0.06 * cut})` }}>
        <div style={{ width: 130, height: 130, flex: 'none', borderRadius: '50%', background: s.bad, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 74 }}>💸</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          <div style={{ fontFamily, fontWeight: 900, fontSize: 64, color: WHITE, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sc.paid.name}</div>
          <div style={{ fontFamily, fontWeight: 800, fontSize: 42, color: s.bad }}>{sc.paid.note}</div>
        </div>
        <div style={{ position: 'absolute', left: 30, right: 30, top: '50%', height: 14, borderRadius: 7, background: s.bad, transformOrigin: 'right center', transform: `scaleX(${cut}) rotate(-4deg)` }} />
      </div>
      <div data-qa="free" style={{ ...card(s.good), top: 830, height: 330, opacity: Math.min(1, fr), transform: `translateY(${(1 - fr) * 320}px) scale(${0.9 + 0.1 * fr})`, boxShadow: `0 0 ${70 * fr}px ${s.good}` }}>
        <div style={{ width: 150, height: 150, flex: 'none', borderRadius: '50%', background: s.good, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: `scale(${pop(frame, fps, f(sc.freeAt - sc.start) + 6)})` }}><Icon name="check" size={100} color="#fff" /></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          <div style={{ fontFamily, fontWeight: 900, fontSize: 72, color: WHITE, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sc.free.name}</div>
          <div style={{ fontFamily, fontWeight: 900, fontSize: 48, color: s.good }}>{sc.free.note}</div>
        </div>
      </div>
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
  const hero = React.useContext(HeroCtx);
  return (
    <>
      <Headline hl={sc.headline} size={90} top={190} />
      <div style={{ position: 'absolute', top: 430, left: 0, right: 0, display: 'flex', justifyContent: 'center', transform: `scale(${sh})` }}>
        <div style={{ position: 'relative', width: 460, height: 460, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {/* the video's main object, big and glowing (a generic shield only when there is none) */}
          {hero && !sc.code ? (
            <><div style={{ position: 'absolute', width: 420, height: 420, borderRadius: '50%', background: `radial-gradient(circle, ${s.accent}55 0%, transparent 70%)`, opacity: glow }} /><Hero size={300} color="#111" style={{ position: 'relative' }} /></>
          ) : (
            <>
              <Icon name="shield" size={460} color={s.good} style={{ position: 'absolute', filter: `drop-shadow(0 0 ${40 * glow}px ${s.good})`, opacity: sc.code ? 0.25 : 0.9 }} />
              {sc.code && <Code style={{ fontSize: sc.code.length > 7 ? 84 : 120, color: s.accent, textShadow: `0 0 ${50 * glow}px ${s.accent}` }}>{sc.code}</Code>}
              {!sc.code && sc.icon && <Icon name={sc.icon} size={160} color="#111" style={{ position: 'relative' }} />}
            </>
          )}
        </div>
      </div>
      {sc.sub && <Headline hl={sc.sub} size={70} top={960} delay={f((sc.subAt ?? sc.start + 1) - sc.start)} />}
      <div style={{ position: 'absolute', top: 1120, left: 0, right: 0, textAlign: 'center', transform: `scale(${follow})`, opacity: follow }}>
        <span data-qa="follow" style={{ display: 'inline-block', padding: '18px 46px', borderRadius: 60, background: s.accent, fontFamily, fontWeight: 900, fontSize: 46, color: '#111', direction: 'rtl' }}>{endCard}</span>
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
        <div style={{ width: 300, height: 300, borderRadius: 80, background: `linear-gradient(135deg, ${s.accent}, ${s.accent}99)`, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 0 90px ${s.accent}88` }}><Hero icon={sc.icon} size={180} color="#111" /></div>
      </div>
      <div style={{ position: 'absolute', top: 820, left: 90, right: 90, display: 'flex', flexDirection: 'column', gap: 26, direction: 'rtl' }}>
        {sc.lines.slice(0, 3).map((l, i) => {
          const p = pop(frame, fps, f(l.at - sc.start));
          return (
            <div data-qa="line" key={i} style={{ display: 'flex', alignItems: 'center', gap: 22, padding: '22px 30px', borderRadius: 30, background: CARD, border: `2px solid ${LINE}`, opacity: p, transform: `translateX(${(1 - p) * 120}px)` }}>
              <Icon name="check" size={52} color={s.good} />
              <span style={{ fontFamily, fontWeight: 800, fontSize: 42, color: WHITE }}>{l.text}</span>
            </div>
          );
        })}
      </div>
    </>
  );
};

// ── acted-out screens (owner's reference style): each idea shown as a realistic mini UI ──────────────────────
const MOCK_TOP = 430, MOCK_MAX = 800;
const mmss = (s: number) => `${String(Math.floor(Math.max(0, s) / 60)).padStart(2, '0')}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;
const Mark: React.FC<{ kind: 'check' | 'cross'; p: number; size?: number }> = ({ kind, p, size = 56 }) => {
  const s = useStyle();
  return <div style={{ width: size, height: size, flex: 'none', borderRadius: '50%', background: kind === 'check' ? s.good : s.bad, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: `scale(${p})`, fontFamily, fontWeight: 900, fontSize: size * 0.62, color: '#fff' }}>{kind === 'check' ? <Icon name="check" size={size * 0.7} color="#fff" /> : '✕'}</div>;
};
const Row: React.FC<{ p: number; children: React.ReactNode; style?: React.CSSProperties }> = ({ p, children, style }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 24, direction: 'rtl', opacity: Math.min(1, p * 1.4), transform: `translateY(${(1 - p) * 40}px)`, ...style }}>{children}</div>
);
const txt = (size: number, color: string = WHITE, weight = 800): React.CSSProperties => ({ fontFamily, fontWeight: weight, fontSize: size, color, lineHeight: 1.3 });

const MockBody: React.FC<{ sc: Of<'mock'> }> = ({ sc }) => {
  const s = useStyle();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / FPS + sc.start;
  const P = (at: number, d = 0) => pop(frame, fps, f(at - sc.start) + d);
  const seen = (at: number) => t >= at - 0.05;
  const items = sc.items.slice(0, sc.kind === 'bars' ? 6 : 5);
  switch (sc.kind) {
    case 'chat':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
          {items.map((m, i) => {
            const mine = m.value === 1;
            const p = P(m.at);
            if (!seen(m.at)) return null;
            return (
              <div key={i} style={{ display: 'flex', justifyContent: mine ? 'flex-start' : 'flex-end', alignItems: 'center', gap: 18, direction: 'rtl', opacity: Math.min(1, p * 1.4), transform: `translateY(${(1 - p) * 30}px) scale(${0.9 + 0.1 * p})` }}>
                <div style={{ maxWidth: 640, padding: '22px 30px', borderRadius: 30, background: mine ? `${s.accent}26` : CHIP, border: `2px solid ${mine ? s.accent : LINE}`, ...txt(42), direction: 'rtl' }}>{m.text}</div>
                {m.mark && m.mark !== 'win' && <Mark kind={m.mark} p={P(m.at + 0.45)} />}
              </div>
            );
          })}
        </div>
      );
    case 'bars': {
      const max = Math.max(1, ...items.map((b) => b.value ?? 1));
      return (
        <div style={{ height: 520, display: 'flex', alignItems: 'flex-end', justifyContent: 'space-around', direction: 'rtl', borderBottom: `3px solid ${LINE}`, paddingBottom: 6 }}>
          {items.map((b, i) => {
            const g = ease(t, b.at, b.at + 0.6);
            const win = b.mark === 'win';
            const h = 40 + 380 * ((b.value ?? 1) / max) * g;
            return (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, width: 120 }}>
                {b.label && <div style={{ ...txt(win ? 44 : 34, win ? s.accent : WHITE, 900), opacity: g, transform: `scale(${win ? 0.8 + 0.25 * P(b.at + 0.5) : 1})` }}>{b.label}</div>}
                <div style={{ width: 92, height: h, borderRadius: '18px 18px 6px 6px', background: win ? s.accent : '#3A3D48', boxShadow: win ? `0 0 ${40 * g}px ${s.accent}` : undefined }} />
                <div style={{ ...txt(28, DIM, 700), textAlign: 'center', height: 40, whiteSpace: 'nowrap' }}>{b.text}</div>
              </div>
            );
          })}
        </div>
      );
    }
    case 'checklist':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 30 }}>
          {items.map((it, i) => {
            const done = P(it.at);
            const cross = it.mark === 'cross';
            return (
              <Row key={i} p={Math.max(P(sc.start + 0.2 + i * 0.12), 0)}>
                <div style={{ width: 60, height: 60, flex: 'none', borderRadius: 16, border: `4px solid ${done > 0.05 ? (cross ? s.bad : s.good) : LINE}`, background: done > 0.05 ? (cross ? s.bad : s.good) : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {done > 0.05 && (cross ? <span style={{ ...txt(40, '#fff', 900), transform: `scale(${done})` }}>✕</span> : <Icon name="check" size={46} color="#fff" style={{ transform: `scale(${done})` }} />)}
                </div>
                <div style={{ ...txt(44, done > 0.5 ? WHITE : DIM), textDecoration: cross && done > 0.5 ? 'line-through' : undefined }}>{it.text}</div>
              </Row>
            );
          })}
        </div>
      );
    case 'ranked':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {items.map((it, i) => (
            <Row key={i} p={P(it.at)} style={{ padding: '18px 24px', borderRadius: 24, background: it.mark === 'win' ? `${s.accent}22` : CHIP, border: `2px solid ${it.mark === 'win' ? s.accent : 'transparent'}` }}>
              <div style={{ width: 60, height: 60, flex: 'none', borderRadius: '50%', background: it.mark === 'win' ? s.accent : '#3A3D48', ...txt(36, it.mark === 'win' ? '#111' : WHITE, 900), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</div>
              <div style={{ ...txt(40), flex: 1 }}>{it.text}</div>
              {it.value !== undefined && <div style={{ ...txt(40, s.accent, 900) }}>{it.value}</div>}
            </Row>
          ))}
        </div>
      );
    case 'search': {
      const q = sc.title ?? '';
      const end = Math.max(sc.start + 0.8, (items[0]?.at ?? sc.start + 1.6) - 0.15);
      const n = Math.round(q.length * ease(t, sc.start + 0.25, end));
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 30 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 20, padding: '22px 30px', borderRadius: 60, background: CHIP, border: `3px solid ${s.accent}`, direction: 'rtl' }}>
            <Icon name="search" size={50} color={s.accent} />
            <div style={{ ...txt(44) }}>{q.slice(0, n)}<span style={{ opacity: Math.sin(t * 10) > 0 ? 1 : 0, color: s.accent }}>|</span></div>
          </div>
          {items.map((it, i) => (
            <Row key={i} p={P(it.at)} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 8, paddingRight: 10 }}>
              <div style={{ ...txt(42, s.accent, 900) }}>{it.text}</div>
              {it.label && <div style={{ ...txt(30, DIM, 600) }}>{it.label}</div>}
            </Row>
          ))}
        </div>
      );
    }
    case 'link': {
      const [url, title] = items;
      const p = url ? P(url.at) : 0;
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
          {url && seen(url.at) && (
            <div style={{ alignSelf: 'flex-end', width: 720, borderRadius: 30, background: CHIP, border: `2px solid ${LINE}`, overflow: 'hidden', opacity: Math.min(1, p * 1.4), transform: `translateY(${(1 - p) * 40}px)` }}>
              <div style={{ height: 150, background: `linear-gradient(135deg, ${s.accent}55, ${s.accent}11)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="search" size={80} color={s.accent} /></div>
              <div style={{ padding: '22px 28px', display: 'flex', flexDirection: 'column', gap: 8, direction: 'rtl' }}>
                <div style={{ ...txt(30, DIM, 600), direction: 'ltr', textAlign: 'right' }}>{url.text}</div>
                {title && <div style={{ ...txt(42, WHITE, 900), opacity: ease(t, title.at, title.at + 0.4) }}>{title.text}</div>}
              </div>
            </div>
          )}
        </div>
      );
    }
    case 'video': {
      const blink = Math.sin(t * 6) > 0 ? 1 : 0.25;
      const corner = (pos: React.CSSProperties) => <div style={{ position: 'absolute', width: 80, height: 80, borderColor: WHITE, borderStyle: 'solid', borderWidth: 0, ...pos }} />;
      return (
        <div style={{ position: 'relative', height: 560, borderRadius: 24, background: 'radial-gradient(circle at 50% 45%, #2A2D36 0%, #15161B 75%)', overflow: 'hidden' }}>
          {corner({ top: 30, left: 30, borderTopWidth: 8, borderLeftWidth: 8 })}{corner({ top: 30, right: 30, borderTopWidth: 8, borderRightWidth: 8 })}
          {corner({ bottom: 30, left: 30, borderBottomWidth: 8, borderLeftWidth: 8 })}{corner({ bottom: 30, right: 30, borderBottomWidth: 8, borderRightWidth: 8 })}
          <div style={{ position: 'absolute', top: 56, left: 70, display: 'flex', alignItems: 'center', gap: 14 }}><div style={{ width: 26, height: 26, borderRadius: '50%', background: s.bad, opacity: blink }} /><span style={txt(34, WHITE, 900)}>{sc.title ?? 'REC'}</span></div>
          <div style={{ position: 'absolute', top: 56, right: 70, ...txt(34, WHITE, 800), fontVariantNumeric: 'tabular-nums' }}>{mmss((t - sc.start) * 7 + 12)}</div>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="camera" size={170} color={`${WHITE}`} style={{ opacity: 0.18 }} /></div>
          <div style={{ position: 'absolute', bottom: 60, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 18, flexWrap: 'wrap', direction: 'rtl' }}>
            {items.map((it, i) => seen(it.at) && <div key={i} style={{ padding: '12px 26px', borderRadius: 40, background: `${s.accent}`, ...txt(34, '#111', 900), transform: `scale(${P(it.at)})` }}>{it.text}</div>)}
          </div>
        </div>
      );
    }
    case 'doc':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
          {items.map((it, i) => {
            const mark = ease(t, it.at + 0.15, it.at + 0.55);
            const hl = new Set((it.highlight ?? []).flatMap((w) => w.split(/\s+/)));
            return (
              <Row key={i} p={P(sc.start + 0.2 + i * 0.15)} style={{ flexWrap: 'wrap', gap: 12 }}>
                {it.text.split(/\s+/).map((w, k) => (
                  <span key={k} style={{ ...txt(42, hl.has(w) ? (it.mark === 'cross' ? s.bad : s.accent) : WHITE), padding: '2px 8px', borderRadius: 10, background: hl.has(w) ? `rgba(255,159,28,${0.22 * mark})` : 'transparent', textDecoration: hl.has(w) && it.mark === 'cross' && mark > 0.6 ? 'line-through' : undefined }}>{w}</span>
                ))}
              </Row>
            );
          })}
        </div>
      );
    case 'timer': {
      const total = Math.max(1, items[0]?.value ?? 30);
      const k = ease(t, items[0]?.at ?? sc.start, sc.end - 0.3);
      const R = 210, C = 2 * Math.PI * R;
      return (
        <div style={{ height: 560, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24 }}>
          <div style={{ position: 'relative', width: 2 * R + 40, height: 2 * R + 40 }}>
            <svg width={2 * R + 40} height={2 * R + 40} style={{ position: 'absolute', inset: 0, transform: 'rotate(-90deg)' }}>
              <circle cx={R + 20} cy={R + 20} r={R} fill="none" stroke={LINE} strokeWidth={24} />
              <circle cx={R + 20} cy={R + 20} r={R} fill="none" stroke={s.accent} strokeWidth={24} strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - k)} />
            </svg>
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', ...txt(110, WHITE, 900), fontVariantNumeric: 'tabular-nums' }}>{mmss(total * k)}</div>
          </div>
          {items[0] && <div style={txt(40, DIM, 800)}>{items[0].text}</div>}
        </div>
      );
    }
    case 'notify':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          {items.map((it, i) => seen(it.at) && (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 22, padding: '22px 26px', borderRadius: 30, background: CHIP, border: `2px solid ${LINE}`, direction: 'rtl', transform: `translateY(${(1 - P(it.at)) * -120}px)`, opacity: Math.min(1, P(it.at) * 1.5) }}>
              <div style={{ width: 76, height: 76, flex: 'none', borderRadius: 20, background: s.accent, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="bell" size={46} color="#111" /></div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={txt(30, DIM, 700)}>{it.label ?? sc.title ?? ''}</div>
                <div style={txt(40)}>{it.text}</div>
              </div>
            </div>
          ))}
        </div>
      );
    case 'price':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
          {items.map((it, i) => {
            const m = P(it.at + 0.35);
            const win = it.mark === 'win', cross = it.mark === 'cross';
            return (
              <Row key={i} p={P(it.at)} style={{ justifyContent: 'space-between', padding: '26px 30px', borderRadius: 28, background: win ? `${s.good}22` : CHIP, border: `3px solid ${win ? s.good : cross ? s.bad : LINE}`, opacity: cross && m > 0.5 ? 0.55 : undefined }}>
                <div style={{ ...txt(44), textDecoration: cross && m > 0.5 ? 'line-through' : undefined }}>{it.text}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  {it.label && <div style={txt(40, win ? s.good : cross ? s.bad : s.accent, 900)}>{it.label}</div>}
                  {(win || cross) && <Mark kind={win ? 'check' : 'cross'} p={m} size={52} />}
                </div>
              </Row>
            );
          })}
        </div>
      );
  }
};

/**
 * A mouse pointer that glides to each item of a screen right before it is said and clicks it (ripple) — the
 * reference's "someone is using it" feel. Row geometry per screen kind (CSS px before zoom).
 */
const ROWS: Partial<Record<Of<'mock'>['kind'], { first: number; pitch: number; x: (zoom: number) => number }>> = {
  checklist: { first: 30, pitch: 90, x: (z) => 1080 - 80 - 70 * z },
  ranked: { first: 48, pitch: 120, x: (z) => 1080 - 80 - 84 * z },
  notify: { first: 60, pitch: 142, x: (z) => 1080 - 80 - 90 * z },
  price: { first: 55, pitch: 136, x: (z) => 80 + 90 * z },
  search: { first: 184, pitch: 134, x: () => 540 },
  doc: { first: 28, pitch: 86, x: (z) => 1080 - 80 - 120 * z },
};
const Cursor: React.FC<{ sc: Of<'mock'>; top: number; zoom: number; header: boolean }> = ({ sc, top, zoom, header }) => {
  const s = useStyle();
  const t = useCurrentFrame() / FPS + sc.start;
  const g = ROWS[sc.kind];
  if (!g) return null;
  const base = 34 + (header ? 112 : 0);
  const pts = sc.items.slice(0, 5).map((it, i) => ({ at: it.at, x: g.x(zoom), y: top + (base + g.first + i * g.pitch) * zoom }));
  if (sc.kind === 'search') pts.unshift({ at: sc.start + 0.3, x: 760, y: top + (34 + 50) * zoom });
  if (!pts.length) return null;
  // where it is: travelling (0.35 s) to the next point before its moment, resting after
  let x = 1150, y = 1500;
  for (const [i, p] of pts.entries()) {
    const from = i === 0 ? { x: 1150, y: 1500 } : pts[i - 1]!;
    const k = ease(t, p.at - 0.4, p.at - 0.05);
    if (t >= p.at - 0.4) { x = from.x + (p.x - from.x) * k; y = from.y + (p.y - from.y) * k; }
  }
  const last = [...pts].reverse().find((p) => t >= p.at - 0.05);
  const since = last ? t - last.at : 9;
  const press = since >= 0 && since < 0.18 ? 0.85 : 1;
  return (
    <>
      {since >= 0 && since < 0.5 && <div style={{ position: 'absolute', left: last!.x - 70, top: last!.y - 70, width: 140, height: 140, borderRadius: '50%', border: `6px solid ${s.accent}`, opacity: 1 - since / 0.5, transform: `scale(${0.4 + since * 2})` }} />}
      <svg width={74} height={74} viewBox="0 0 24 24" style={{ position: 'absolute', left: x - 10, top: y - 6, transform: `scale(${press})`, transformOrigin: '10px 6px', filter: 'drop-shadow(0 6px 10px rgba(0,0,0,.55))' }}>
        <path d="M4 2 L4 19 L8.5 14.8 L11.4 21.4 L14.3 20.1 L11.5 13.6 L17.6 13.4 Z" fill="#fff" stroke="#111" strokeWidth={1.2} strokeLinejoin="round" />
      </svg>
    </>
  );
};

const MockScene: React.FC<{ sc: Of<'mock'> }> = ({ sc }) => {
  const s = useStyle();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / FPS + sc.start;
  const inP = pop(frame, fps, 2);
  const fin = sc.final ? pop(frame, fps, f(sc.final.at - sc.start)) : 0;
  const header = sc.title && !['search', 'video'].includes(sc.kind);
  // Like the reference, the screen fills the middle: few items → bigger content, a little lower.
  const n = sc.items.length;
  const fixedSize = ['bars', 'video', 'timer'].includes(sc.kind);
  const zoom = fixedSize ? 1 : n <= 1 ? 1.4 : n === 2 ? 1.25 : n === 3 ? 1.1 : 1;
  const top = fixedSize || n >= 4 ? MOCK_TOP : n <= 2 ? 540 : 480;
  return (
    <>
      <Headline hl={sc.headline} size={84} top={190} />
      {/* CSS zoom also scales the box's own offsets, so they are divided back to screen pixels */}
      <div data-qa="mock" style={{ position: 'absolute', top: top / zoom, zoom, left: 80 / zoom, right: 80 / zoom, maxHeight: MOCK_MAX / zoom, overflow: 'hidden', borderRadius: 44, background: CARD, border: `3px solid ${LINE}`, padding: sc.kind === 'video' ? 18 : '34px 40px', boxShadow: '0 30px 80px rgba(0,0,0,0.45)', opacity: Math.min(1, inP * 1.3), transform: `translateY(${(1 - inP) * 80}px) scale(${0.94 + 0.06 * inP})` }}>
        {header && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, direction: 'rtl', marginBottom: 30, paddingBottom: 22, borderBottom: `2px solid ${LINE}` }}>
            <div style={{ width: 58, height: 58, borderRadius: sc.kind === 'chat' || sc.kind === 'link' ? '50%' : 16, background: s.accent, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name={sc.kind === 'chat' || sc.kind === 'link' ? 'chat' : sc.kind === 'notify' ? 'bell' : sc.kind === 'bars' ? 'bolt' : 'check'} size={36} color="#111" /></div>
            <div style={txt(40, WHITE, 900)}>{sc.title}</div>
          </div>
        )}
        <MockBody sc={sc} />
      </div>
      <Cursor sc={sc} top={top} zoom={zoom} header={Boolean(header)} />
      {sc.final && t >= sc.final.at - 0.05 && (
        <div style={{ position: 'absolute', top: 1290, left: 0, right: 0, textAlign: 'center', transform: `scale(${fin})` }}>
          <span data-qa="final" style={{ display: 'inline-block', padding: '16px 44px', borderRadius: 60, background: sc.final.tone === 'good' ? s.good : s.bad, ...txt(44, '#fff', 900), direction: 'rtl' }}>{sc.final.text}</span>
        </div>
      )}
    </>
  );
};

// ── props: 3D objects of what is said, alive (enter, float, act, leave) ──────────────────────────────────────
/** Where props sit: beside the main content in normal scenes (0–2), big and central in story scenes (10–12). */
const SLOTS: Record<number, { x: number; y: number; size: number; side: 1 | -1 }> = {
  0: { x: 820, y: 470, size: 240, side: 1 }, 1: { x: 20, y: 880, size: 230, side: -1 }, 2: { x: 830, y: 1150, size: 220, side: 1 }, 3: { x: 30, y: 1160, size: 200, side: -1 }, 4: { x: 150, y: 1215, size: 190, side: -1 }, 5: { x: 740, y: 1215, size: 190, side: 1 },
  10: { x: 290, y: 470, size: 500, side: 1 }, 11: { x: 80, y: 1000, size: 320, side: -1 }, 12: { x: 680, y: 1000, size: 320, side: 1 },
};
/** An animated emoji (Google Noto, Lottie) — loaded before the frame is rendered. */
const LottieThing: React.FC<{ src: string; size: number }> = ({ src, size }) => {
  const [data, setData] = React.useState<LottieAnimationData | null>(null);
  const [handle] = React.useState(() => delayRender(`lottie ${src}`));
  React.useEffect(() => {
    fetch(staticFile(src)).then((r) => r.json()).then((d: LottieAnimationData) => { setData(d); continueRender(handle); }).catch(() => continueRender(handle));
  }, [src, handle]);
  if (!data) return null;
  return <Lottie animationData={data} loop style={{ width: size, height: size }} />;
};

/** Visible text on screen right now (headlines, captions, cards, screens, buttons…) as rectangles. */
function visibleTextRects(): DOMRect[] {
  return [...document.querySelectorAll<HTMLElement>('[data-qa],[data-avoid]')].filter((el) => {
    let o = 1;
    for (let n: HTMLElement | null = el; n; n = n.parentElement) { const cs = getComputedStyle(n); o *= Number(cs.opacity); if (cs.display === 'none' || cs.visibility === 'hidden') return false; }
    return o > 0.25;
  }).map((el) => el.getBoundingClientRect()).filter((r) => r.width > 2 && r.height > 2);
}
const overlaps = (a: { left: number; right: number; top: number; bottom: number }, b: DOMRect) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 8 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 8;

const PropView: React.FC<{ p: Prop }> = ({ p }) => {
  const s = useStyle();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / FPS;
  const ref = React.useRef<HTMLDivElement>(null);
  // An object must NEVER cover text: if it sits on any visible text, it moves to the nearest free spot inside the
  // frame; with no free spot it hides for that frame.
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.translate = '0px 0px'; el.style.visibility = 'visible';
    const r = el.getBoundingClientRect();
    if (r.width < 2) return;
    const texts = visibleTextRects();
    for (const [dx, dy] of [[0, 0], [0, -230], [0, 230], [-220, 0], [220, 0], [0, -460], [0, 460]] as const) {
      const m = { left: r.left + dx, right: r.right + dx, top: r.top + dy, bottom: r.bottom + dy };
      if (m.left < 0 || m.right > 1080 || m.top < 90 || m.bottom > 1900) continue;
      if (!texts.some((x) => overlaps(m, x))) { el.style.translate = `${dx}px ${dy}px`; return; }
    }
    el.style.visibility = 'hidden';
  }, [frame]);
  if (t < p.at - 0.05 || t > p.until + 0.4) return null;
  const sl = SLOTS[p.slot] ?? SLOTS[0]!;
  const inP = pop(frame, fps, f(p.at));
  const out = ease(t, p.until - 0.05, p.until + 0.35);
  const live = t - p.at;
  let x = 0, y = 0, rot = 0, scale = inP, ry = 0, op = Math.min(1, inP * 1.5) * (1 - out);
  if (p.action === 'fly-in') x = (1 - inP) * 700 * sl.side;
  if (p.action === 'drop') y = (1 - inP) * -900;
  if (p.action === 'fly-away') { const k = ease(t, p.at + 1.1, p.at + 2.1); y -= 1100 * k; x += 120 * sl.side * k; rot += 25 * k; op *= 1 - k; }
  if (p.action === 'shake' && live < 1.2) rot += 14 * Math.sin(live * 28) * (1 - live / 1.2);
  if (p.action === 'spin') ry = 360 * ease(t, p.at, p.at + 0.9);
  if (p.action === 'pulse') scale *= 1 + 0.07 * Math.sin(live * 6);
  // always alive: a slow float and sway
  y += 14 * Math.sin(t * 2.1 + p.slot); rot += 4 * Math.sin(t * 1.3 + p.slot * 2);
  const no = p.action === 'no' ? pop(frame, fps, f(p.at + 0.45)) : 0;
  return (
    <div ref={ref} data-prop="1" style={{ position: 'absolute', left: sl.x, top: sl.y, width: sl.size, height: sl.size, opacity: op, transform: `translate(${x}px, ${y}px) rotate(${rot}deg) perspective(900px) rotateY(${ry}deg) scale(${scale})` }}>
      {p.lottie
        ? <div style={{ width: '100%', height: '100%', filter: `drop-shadow(0 ${sl.size * 0.08}px ${sl.size * 0.1}px rgba(0,0,0,.45))` }}><LottieThing src={p.lottie} size={sl.size} /></div>
        : <Img src={staticFile(p.src)} style={{ width: '100%', height: '100%', objectFit: 'contain', filter: `drop-shadow(0 ${sl.size * 0.08}px ${sl.size * 0.1}px rgba(0,0,0,.45))` }} />}
      {no > 0 && (
        <div style={{ position: 'absolute', inset: '-6%', borderRadius: '50%', border: `${sl.size * 0.07}px solid ${s.bad}`, transform: `scale(${no})` }}>
          <div style={{ position: 'absolute', left: '-4%', right: '-4%', top: '46%', height: sl.size * 0.07, background: s.bad, transform: 'rotate(-45deg)' }} />
        </div>
      )}
    </div>
  );
};
const PropLayer: React.FC<{ props?: Prop[] }> = ({ props }) => <>{(props ?? []).map((p, i) => <PropView key={i} p={p} />)}</>;

/** A situation told with big 3D objects (the props are the scene); a soft spotlight behind the hero object. */
const StoryScene: React.FC<{ sc: Of<'story'> }> = ({ sc }) => {
  const s = useStyle();
  const t = useAbsT(sc.start);
  return (
    <>
      <AbsoluteFill style={{ background: `radial-gradient(circle at 50% 38%, ${s.accent}33 0%, transparent ${40 + 4 * Math.sin(t * 2)}%)` }} />
      <Headline hl={sc.headline} size={88} top={190} />
    </>
  );
};

const SceneView: React.FC<{ sc: MotionScene; endCard: string }> = ({ sc, endCard }) => {
  switch (sc.type) {
    case 'hook': return <HookScene sc={sc} />;
    case 'dialer': return <DialerScene sc={sc} />;
    case 'settings': return <SettingsScene sc={sc} />;
    case 'app': return <AppScene sc={sc} />;
    case 'card': return <CardScene sc={sc} />;
    case 'alert': return <AlertScene sc={sc} />;
    case 'compat': return <CompatScene sc={sc} />;
    case 'versus': return <VersusScene sc={sc} />;
    case 'story': return <StoryScene sc={sc} />;
    case 'mock': return <MockScene sc={sc} />;
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
      <span data-qa="caption" style={V(s).caption === 'boxed' ? { display: 'inline-block', padding: '10px 26px', borderRadius: 28, background: CARD, border: `3px solid ${s.accent}`, boxShadow: '0 12px 40px rgba(0,0,0,0.35)' } : undefined}>{words.map((w, i) => {
        const cur2 = i === idx, cs = V(s).caption;
        const style: React.CSSProperties = cs === 'highlight'
          ? { color: cur2 ? '#111' : WHITE, background: cur2 ? s.accent : 'transparent', transform: `scale(${cur2 ? 1.08 : 1})`, WebkitTextStroke: cur2 ? '0' : '2px rgba(0,0,0,0.35)', textShadow: cur2 ? 'none' : '0 4px 18px rgba(0,0,0,0.5)' }
          : cs === 'underline'
            ? { color: cur2 ? s.accent : WHITE, boxShadow: cur2 ? `inset 0 -10px 0 ${s.accent}66` : 'none', transform: `translateY(${cur2 ? -6 : 0}px)`, textShadow: '0 4px 18px rgba(0,0,0,0.45)' }
            : { color: cur2 ? s.accent : WHITE, transform: `scale(${cur2 ? 1.1 : 1})` };
        return <span key={i} style={{ display: 'inline-block', margin: '0 9px', padding: '0 10px', borderRadius: 14, ...style }}>{w}</span>;
      })}</span>
    </div>
  );
};

export const MotionShort: React.FC<MotionPlan> = (plan) => {
  const th = THEMES[V(plan.style).theme] ?? THEMES.night!;
  const s: MotionStyle = { ...plan.style, accent: th.accent, good: th.good, bad: th.bad, bg1: th.bg1, bg2: th.bg2 };
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const t = frame / FPS;
  const cur = plan.scenes.find((x) => t >= x.start && t < x.end) ?? plan.scenes.at(-1);
  const tint = cur?.type === 'app' ? cur.color : cur?.type === 'alert' ? (cur.tone === 'bad' ? s.bad : s.good) : cur?.type === 'cta' || cur?.type === 'compat' ? s.good
    : cur?.type === 'card' && cur.rows.some((r) => r.then && t >= r.then.at) ? s.bad : s.accent;
  const kick = Math.max(0, ...plan.beats.map((b) => (t >= b && t < b + 0.3 ? Math.sin((Math.PI * (t - b)) / 0.3) : 0)));
  const flash = Math.max(0, ...plan.beats.map((b) => (t >= b && t < b + 0.25 ? 1 - (t - b) / 0.25 : 0)));
  const curStart = cur?.start ?? 0, curEnd = cur?.end ?? plan.duration;
  const sinceCut = t - curStart;
  const punch = cur && curStart > 0 && sinceCut < 0.35 ? 0.05 * (1 - sinceCut / 0.35) ** 2 : 0;
  const camPush = 0.035 * Math.min(1, Math.max(0, sinceCut / Math.max(0.5, curEnd - curStart))) + punch;
  const camDrift = 6 * Math.sin(t * 0.7);
  // brand-colour wipe sweeping across at every cut (≈ 0.2 s)
  const wipe = cur && curStart > 0 && sinceCut < 0.22 ? sinceCut / 0.22 : -1;
  // the sound & transitions team decides every cut's transition and every sound (motion/edit.ts)
  const seed = [...(plan.scenes[0]?.headline.text ?? '')].reduce((a, c) => a + c.charCodeAt(0), 0);
  const { trans, sfx } = soundPlan(plan.scenes, plan.sfxLib, plan.captions, seed);
  // music: soft, lower under the voice (smooth 0.2 s ramps), fade in / out
  const talkAt = (x: number) => plan.captions.some((c) => x >= c.a - 0.1 && x < c.b + 0.1);
  const musicVol = (fr: number) => {
    const x = fr / FPS;
    const duck = talkAt(x) ? 0.045 : 0.1;
    const edge = Math.min(1, x / 0.6, Math.max(0, (plan.duration - x) / 1.2));
    return duck * edge;
  };
  return (
    <StyleCtx.Provider value={s}><HeroCtx.Provider value={plan.hero}>
      <AbsoluteFill style={{ ...vars(th), background: s.bg1 }}>
        <Background tint={tint} />
        {s.particles && <Particles color={tint} />}
        {/* never still: a slow push-in through each scene + a punch when a scene starts */}
        <AbsoluteFill style={{ transform: `scale(${1 + 0.03 * kick + camPush}) translate(${camDrift}px, 0)` }}>
          {plan.scenes.map((sc, i) => (
            <Sequence key={i} from={f(sc.start)} durationInFrames={Math.max(1, f(sc.end - sc.start) + 10)}>
              <Shell len={f(sc.end - sc.start)} instant={i === 0} kind={trans[i]}><SceneView sc={sc} endCard={plan.endCard} /></Shell>
            </Sequence>
          ))}
          {/* the things being talked about, alive on screen (absolute times, so not inside the scene sequences) */}
          {plan.scenes.map((sc, i) => <PropLayer key={`p${i}`} props={sc.props} />)}
        </AbsoluteFill>
        <AbsoluteFill style={{ background: '#fff', opacity: s.flash * flash }} />
        {wipe >= 0 && <AbsoluteFill style={{ background: `linear-gradient(100deg, transparent ${wipe * 140 - 40}%, ${s.accent}cc ${wipe * 140 - 25}%, ${s.accent}ee ${wipe * 140 - 18}%, transparent ${wipe * 140}%)`, mixBlendMode: 'screen', opacity: 0.85 }} />}
        <Captions caps={plan.captions} />
        <LayoutGuard />
        <div style={{ position: 'absolute', top: 0, left: 0, height: 10, width: `${(frame / durationInFrames) * 100}%`, background: s.accent, boxShadow: `0 0 20px ${s.accent}` }} />
        <div style={{ position: 'absolute', top: 60, right: 60, fontFamily, fontWeight: 800, fontSize: 34, color: DIM, direction: 'rtl' }}>{plan.brand}</div>
        {plan.audio && <Audio src={staticFile(plan.audio)} />}
        {plan.music && <Audio src={staticFile(plan.music)} volume={musicVol} />}
        {sfx.map(([file, at, vol, max], i) => <Sequence key={`s${i}`} from={Math.max(0, f(at))} {...(max ? { durationInFrames: Math.max(1, f(max)) } : {})}><Audio src={staticFile(file)} volume={vol} /></Sequence>)}
      </AbsoluteFill>
    </HeroCtx.Provider></StyleCtx.Provider>
  );
};
