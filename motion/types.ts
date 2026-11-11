/**
 * The motion-graphics plan a Short is drawn from. Built by src/media/motion.ts (planner + exact timings from
 * the narration's measured words) and drawn by MotionShort.tsx. All times are seconds from the Short's start.
 */
export type Tone = 'yellow' | 'green' | 'red';
export interface Hl { text: string; accent?: string; tone?: Tone }
export type IconName = 'call' | 'shield' | 'headset' | 'warn' | 'check' | 'lock' | 'antenna' | 'chat' | 'eye' | 'bolt' | 'image' | 'battery' | 'bell' | 'mic' | 'location' | 'trash' | 'star' | 'search' | 'phone' | 'camera' | 'tune';

export type MotionScene = { start: number; end: number; headline: Hl } & (
  | { type: 'hook'; icon: IconName; teaserCode?: string; revealAt?: number; question?: Hl; questionAt?: number }
  | { type: 'dialer'; code: string; keys: { k: string; at: number }[]; callAt?: number }
  | { type: 'settings'; os: 'ios' | 'android'; path: string[]; at: number[] }
  | { type: 'card'; icon?: IconName; title: string; rows: { label: string; value: string; tone: 'good' | 'bad' | 'neutral'; at: number; then?: { at: number; value: string; tone: 'good' | 'bad' | 'neutral'; detail?: string } }[]; alert?: { text: string; at: number } }
  | { type: 'alert'; icon: IconName; tone: 'good' | 'bad'; action?: { text: string; accent?: string; at: number; icon: IconName } }
  | { type: 'compat'; items: string[]; code?: string; badge?: string; badgeAt?: number }
  | { type: 'cta'; code?: string; icon?: IconName; sub?: Hl; subAt?: number; followAt: number }
  | { type: 'statement'; icon: IconName; lines: { text: string; at: number }[] }
);

/** The look the team tunes over time (small steps, from the editing critic and the numbers). */
export interface MotionStyle {
  /** 0–1: how strongly the camera pushes in on the action. */
  camera: number;
  transition: 'whip' | 'zoom' | 'fade';
  particles: boolean;
  /** Caption font size (px on a 1080×1920 frame). */
  captionSize: number;
  /** 0–0.4: white flash on key beats. */
  flash: number;
  accent: string; good: string; bad: string; bg1: string; bg2: string;
}

export interface MotionPlan {
  duration: number;
  /** Narration file name inside the public dir. */
  audio: string;
  style: MotionStyle;
  captions: { a: number; b: number; text: string }[];
  /** Moments that get a flash + camera kick + pop sound. */
  beats: number[];
  scenes: MotionScene[];
  brand: string;
  endCard: string;
}
