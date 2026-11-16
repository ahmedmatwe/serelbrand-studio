/**
 * The motion-graphics plan a Short is drawn from. Built by src/media/motion.ts (planner + exact timings from
 * the narration's measured words) and drawn by MotionShort.tsx. All times are seconds from the Short's start.
 */
export type Tone = 'yellow' | 'green' | 'red';
export interface Hl { text: string; accent?: string; tone?: Tone }
export type IconName = 'call' | 'shield' | 'headset' | 'warn' | 'check' | 'lock' | 'antenna' | 'chat' | 'eye' | 'bolt' | 'image' | 'battery' | 'bell' | 'mic' | 'location' | 'trash' | 'star' | 'search' | 'phone' | 'camera' | 'tune';

/**
 * The acted-out screens (owner's reference style): each sentence's idea shown as a realistic mini UI.
 * chat = messages (value 1 = mine) · bars = chart (value = height, text = label like "×5.0", mark win = the winner)
 * checklist = items ticked one by one · ranked = numbered list (value = score) · search = title typed, items = results
 * link = message with a link preview (title = sender, items: url, page title) · video = REC frame (title = label, items = chips)
 * doc = text lines with highlighted words · timer = clock counting (items[0].value = seconds) · notify = stacked notifications
 * price = plan rows (text, value as price text in label) with cross/win marks.
 */
export type MockKind = 'chat' | 'bars' | 'checklist' | 'ranked' | 'search' | 'link' | 'video' | 'doc' | 'timer' | 'notify' | 'price';
export interface MockItem { text: string; at: number; value?: number; label?: string; mark?: 'check' | 'cross' | 'win'; highlight?: string[] }
/** How a 3D object enters / behaves (the story told with things, not only screens). */
export type PropAction = 'pop' | 'fly-in' | 'drop' | 'fly-away' | 'shake' | 'spin' | 'pulse' | 'no';
/** A 3D illustration (Fluent Emoji 3D, MIT) of the exact thing the narration names, appearing when it is said. */
export interface Prop { src: string; at: number; until: number; action: PropAction; slot: number; /** Animated version (Lottie JSON in the public dir) — played instead of the still image. */ lottie?: string }
export type MotionScene = { start: number; end: number; headline: Hl; props?: Prop[] } & (
  | { type: 'hook'; icon: IconName; teaserCode?: string; revealAt?: number; question?: Hl; questionAt?: number }
  | { type: 'dialer'; code: string; keys: { k: string; at: number }[]; callAt?: number }
  | { type: 'settings'; os: 'ios' | 'android'; path: string[]; at: number[] }
  /** Steps inside an app (Instagram, WhatsApp…) or the phone, drawn in the app's colours; each step tapped when said. */
  | { type: 'app'; app: string; color: string; color2: string; steps: string[]; at: number[]; done?: string }
  | { type: 'card'; icon?: IconName; title: string; rows: { label: string; value: string; tone: 'good' | 'bad' | 'neutral'; at: number; then?: { at: number; value: string; tone: 'good' | 'bad' | 'neutral'; detail?: string } }[]; alert?: { text: string; at: number } }
  | { type: 'alert'; icon: IconName; tone: 'good' | 'bad'; action?: { text: string; accent?: string; at: number; icon: IconName } }
  | { type: 'compat'; items: string[]; code?: string; badge?: string; badgeAt?: number }
  /** An idea ACTED OUT by a small realistic screen (chat, chart, checklist, search, link, video frame…). */
  | { type: 'mock'; kind: MockKind; title?: string; items: MockItem[]; final?: { text: string; at: number; tone: 'good' | 'bad' } }
  /** A REAL photo or video clip of the situation the sentence describes (mixes real footage into the motion). */
  | { type: 'real'; media: 'video' | 'image'; src: string; credit?: string }
  /** A situation told with big 3D objects (e.g. money flying out of a wallet every month). */
  | { type: 'story' }
  /** Paid tool vs the free one that does the same job: the paid card is crossed out when the free one is named. */
  | { type: 'versus'; paid: { name: string; note: string }; free: { name: string; note: string }; freeAt: number }
  | { type: 'cta'; code?: string; icon?: IconName; sub?: Hl; subAt?: number; followAt: number }
  | { type: 'statement'; icon: IconName; lines: { text: string; at: number }[] }
);

/**
 * Design genes: each has several versions. Every Short uses one version per gene — mostly the best known,
 * sometimes a different one to try (exploration) — and the critic's scores + view counts decide which survive.
 */
export const GENES = {
  theme: ['studio', 'night', 'light', 'pop', 'teal', 'sunset'],
  bg: ['dots', 'grid', 'noise', 'mesh', 'rays', 'shapes', 'photo', 'waves', 'blobs'],
  /** Variety (owner: videos must not look alike): font, accent colour and card style change between videos. */
  font: ['cairo', 'tajawal', 'almarai', 'changa', 'rubik', 'lalezar'],
  accent: ['orange', 'cyan', 'lime', 'pink', 'violet', 'gold'],
  card: ['solid', 'glass', 'outline'],
  caption: ['highlight', 'underline', 'boxed'],
  transition: ['whip', 'zoom', 'fade', 'rise'],
  hook: ['rings', 'slam', 'phone3d'],
  headline: ['pop', 'stagger'],
  phone: ['flat', 'tilt'],
} as const;
export type Variants = { [K in keyof typeof GENES]: (typeof GENES)[K][number] };

/** The look the team tunes over time (small steps, from the editing critic and the numbers). */
export interface MotionStyle {
  variants?: Variants;
  /** 0–1: how strongly the camera pushes in on the action. */
  camera: number;
  transition: 'whip' | 'zoom' | 'fade' | 'rise';
  particles: boolean;
  /** Caption font size (px on a 1080×1920 frame). */
  captionSize: number;
  /** 0–0.4: white flash on key beats. */
  flash: number;
  accent: string; good: string; bad: string; bg1: string; bg2: string;
}

export interface MotionPlan {
  duration: number;
  /** Background music file in the public dir (licensed, soft, ducked under the voice). */
  music?: string;
  /** The sound-effects team's professional library (role → variants with where each one peaks). */
  sfxLib?: Record<string, { file: string; peak: number; dur: number }[]>;
  /** Background media (blurred real photo / clip of the topic) when the bg gene is 'photo'. */
  bgMedia?: { kind: 'image' | 'video'; src: string };
  /** THE main object of the video (3D, e.g. a PDF page for a PDF tip): drawn instead of generic icons. */
  hero?: string;
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
