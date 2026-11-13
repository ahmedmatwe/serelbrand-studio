/**
 * The sound-effects team's library builder. For every ROLE it searches Freesound for CC0 sounds (free, commercial
 * use, no attribution), downloads the HQ previews, and checks each one like a sound engineer: trims the silence,
 * measures length and where the peak is, rejects ones that are too long / too soft / peak too late, scores the rest
 * (community rating × downloads), normalises the loudness, and keeps the best few variants per role.
 * Output: motion/public/sfx/lib/<role>-<n>.wav + manifest.json (peak time, length, source credit).
 * Run: FREESOUND_API_KEY=… node scripts/build-sfx-library.ts   (GitHub: workflow "sfx-library").
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const KEY = process.env.FREESOUND_API_KEY;
if (!KEY) { console.error('FREESOUND_API_KEY is missing'); process.exit(1); }
const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(ROOT, 'motion/public/sfx/lib');
const TMP = resolve(ROOT, 'data/sfx-tmp');
const FF = process.env.FFMPEG_PATH || (createRequire(import.meta.url)('ffmpeg-static') as string);

/** What the edit needs. peakMax = latest acceptable peak (s) for sounds that must hit instantly. */
/** Relevance: the sound's own name/tags must say it IS this kind of sound; some words always disqualify. */
const MUST: Record<string, RegExp> = {
  whoosh: /whoosh|swoosh|swish|whip|transition|woosh/i, 'swipe-up': /swipe|swoosh|whoosh|swish|interface|ui/i, impact: /impact|hit|boom|punch|thud|cinematic/i,
  click: /click|button|mouse|tap|ui/i, pop: /pop|bubble|blip|ui/i, typing: /typing|keyboard|keys/i, camera: /camera|shutter|photo/i,
  cash: /cash|register|coin|money|ching/i, notify: /notification|notify|ding|alert|message|chime/i, success: /success|correct|positive|win|complete|chime/i,
  error: /error|wrong|fail|buzz|denied|negative/i,
};
const NEVER = /axe|sword|knife|gun|shot|blood|scream|fart|burp|fish|oil|boil|fry|food|animal|dog|cat|bird|kiss|sex|horror|gore|zombie|explosion|bomb|siren|church|bell tower|music|song|vocal|voice|speech|laugh/i;

export const ROLES: Record<string, { q: string[]; dur: [number, number]; maxLen: number; peakMax?: number; keep: number; gainDb: number }> = {
  whoosh: { q: ['fast whoosh', 'swoosh transition', 'whip pan whoosh', 'short swish'], dur: [0.15, 1.2], maxLen: 0.6, keep: 4, gainDb: -6 },
  'swipe-up': { q: ['ui swipe', 'swoosh up', 'interface swipe'], dur: [0.1, 1.0], maxLen: 0.5, keep: 3, gainDb: -7 },
  impact: { q: ['cinematic hit', 'impact punch', 'trailer hit short', 'boom impact'], dur: [0.2, 2.5], maxLen: 1.2, peakMax: 0.06, keep: 4, gainDb: -5 },
  click: { q: ['mouse click', 'ui click', 'button click'], dur: [0.02, 0.4], maxLen: 0.2, peakMax: 0.03, keep: 4, gainDb: -10 },
  pop: { q: ['pop ui', 'bubble pop', 'cartoon pop'], dur: [0.03, 0.6], maxLen: 0.3, peakMax: 0.05, keep: 3, gainDb: -12 },
  typing: { q: ['keyboard typing', 'typing laptop keyboard'], dur: [1, 8], maxLen: 2.5, keep: 2, gainDb: -16 },
  camera: { q: ['camera shutter', 'dslr shutter'], dur: [0.05, 1.5], maxLen: 0.7, peakMax: 0.08, keep: 2, gainDb: -9 },
  cash: { q: ['cash register', 'coins drop', 'cha ching'], dur: [0.2, 2.5], maxLen: 1.2, keep: 2, gainDb: -10 },
  notify: { q: ['notification sound', 'message notification ding', 'phone notification'], dur: [0.1, 2], maxLen: 1.0, peakMax: 0.12, keep: 3, gainDb: -10 },
  success: { q: ['success chime', 'positive ui', 'correct answer'], dur: [0.2, 2], maxLen: 1.2, keep: 2, gainDb: -10 },
  error: { q: ['error buzz', 'wrong answer buzzer', 'ui error'], dur: [0.1, 1.5], maxLen: 0.8, keep: 2, gainDb: -11 },
};

type Hit = { id: number; name: string; tags?: string[]; duration: number; username: string; avg_rating: number; num_downloads: number; license: string; previews: Record<string, string> };

async function search(q: string, dur: [number, number]): Promise<Hit[]> {
  const params = new URLSearchParams({ query: q, filter: `license:"Creative Commons 0" duration:[${dur[0]} TO ${dur[1]}]`, fields: 'id,name,tags,duration,username,avg_rating,num_downloads,license,previews', sort: 'rating_desc', page_size: '15', token: KEY! });
  const r = await fetch(`https://freesound.org/apiv2/search/text/?${params}`);
  if (!r.ok) throw new Error(`Freesound search "${q}": HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return ((await r.json()) as { results: Hit[] }).results.filter((h) => /creativecommons\.org\/publicdomain\/zero/.test(h.license));
}

/** Mono 48 kHz samples after trimming the leading silence. */
function analyse(file: string): { samples: Int16Array; dur: number; peak: number; peakAt: number; rms: number } {
  const raw = execFileSync(FF, ['-v', 'error', '-i', file, '-af', 'silenceremove=start_periods=1:start_threshold=-45dB', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { maxBuffer: 64 * 1024 * 1024 });
  const samples = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
  let peak = 0, peakI = 0, sum = 0;
  for (let i = 0; i < samples.length; i++) { const v = Math.abs(samples[i]!); if (v > peak) { peak = v; peakI = i; } sum += v * v; }
  return { samples, dur: samples.length / 48000, peak: peak / 32768, peakAt: peakI / 48000, rms: Math.sqrt(sum / Math.max(1, samples.length)) / 32768 };
}

const manifest: Record<string, { file: string; peak: number; dur: number; credit: string; url: string }[]> = {};
mkdirSync(OUT, { recursive: true }); mkdirSync(TMP, { recursive: true });
for (const [role, cfg] of Object.entries(ROLES)) {
  const seen = new Set<number>();
  const cands: { hit: Hit; score: number; a: ReturnType<typeof analyse>; src: string }[] = [];
  for (const q of cfg.q) {
    let hits: Hit[] = [];
    try { hits = await search(q, cfg.dur); } catch (e) { console.warn(String(e)); continue; }
    for (const h of hits.slice(0, 15)) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      const words = `${h.name} ${(h.tags ?? []).join(' ')}`;
      if (!MUST[role]!.test(words) || NEVER.test(words)) continue;
      const url = h.previews['preview-hq-mp3'];
      if (!url) continue;
      const src = resolve(TMP, `${h.id}.mp3`);
      try {
        if (!existsSync(src)) { const r = await fetch(url); if (!r.ok) continue; writeFileSync(src, Buffer.from(await r.arrayBuffer())); }
        const a = analyse(src);
        // the engineer's checks: real signal, not clipped mush, short enough, peak early enough for hits
        if (a.peak < 0.05 || a.dur < 0.03) continue;
        if (cfg.peakMax !== undefined && a.peakAt > cfg.peakMax) continue;
        if (a.peakAt > cfg.maxLen * 0.8) continue;
        const crest = a.peak / Math.max(1e-4, a.rms); // punchy sounds have a high crest factor
        const score = (h.avg_rating || 3) * Math.log10(10 + h.num_downloads) * (role === 'typing' ? 1 : Math.min(2, 0.5 + crest / 8));
        cands.push({ hit: h, score, a, src });
      } catch { /* skip a broken file */ }
    }
  }
  cands.sort((x, y) => y.score - x.score);
  manifest[role] = [];
  for (const [n, c] of cands.slice(0, cfg.keep).entries()) {
    const file = `${role}-${n + 1}.wav`;
    // trim the lead silence, cut to the role's length with a short fade, normalise the peak, mono 48 kHz
    const len = Math.min(cfg.maxLen, c.a.dur);
    const g = cfg.gainDb - 20 * Math.log10(c.a.peak);
    execFileSync(FF, ['-v', 'error', '-y', '-i', c.src, '-af', `silenceremove=start_periods=1:start_threshold=-45dB,atrim=0:${len.toFixed(3)},afade=t=out:st=${Math.max(0, len - 0.05).toFixed(3)}:d=0.05,volume=${g.toFixed(2)}dB`, '-ac', '1', '-ar', '48000', resolve(OUT, file)]);
    manifest[role]!.push({ file: `sfx/lib/${file}`, peak: Number(Math.min(c.a.peakAt, len).toFixed(3)), dur: Number(len.toFixed(3)), credit: `"${c.hit.name}" by ${c.hit.username} (CC0)`, url: `https://freesound.org/s/${c.hit.id}/` });
  }
  console.log(`${role}: ${manifest[role]!.length} kept of ${cands.length} that passed the checks`);
}
writeFileSync(resolve(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
rmSync(TMP, { recursive: true, force: true });
const prev = existsSync(resolve(OUT, 'CREDITS.md')) ? readFileSync(resolve(OUT, 'CREDITS.md'), 'utf8') : '';
writeFileSync(resolve(OUT, 'CREDITS.md'), ['# Sound effects (Freesound, CC0 — no attribution required, credited anyway)', '', ...Object.values(manifest).flat().map((x) => `- ${x.file}: ${x.credit} — ${x.url}`), ''].join('\n') || prev);
