"""Synthesises the motion graphics' sound effects (no third-party audio, no licence questions).
Designed for SPEED: every transition sound peaks within ~25 ms and is over in ≤ 0.18 s, so it lands ON the cut.
Run: python3 scripts/make-sfx.py motion/public/sfx"""
import math, random, struct, sys, wave
SR = 48000
out = sys.argv[1] if len(sys.argv) > 1 else 'motion/public/sfx'
random.seed(7)

def save(name, xs, gain=0.9):
    peak = max(1e-9, max(abs(x) for x in xs))
    with wave.open(f'{out}/{name}.wav', 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(b''.join(struct.pack('<h', int(max(-1, min(1, x / peak * gain)) * 32767)) for x in xs))

def env(n, attack, decay):
    a = max(1, int(attack * SR))
    return [(i / a) if i < a else math.exp(-(i - a) / (decay * SR)) for i in range(n)]

def swipe(dur, f0, f1, decay, q=0.35):
    """Band-limited noise whose band sweeps f0 → f1 (a fast 'swish')."""
    n = int(dur * SR); e = env(n, 0.006, decay); xs = []; lp = hp = 0.0
    for i in range(n):
        f = f0 * (f1 / f0) ** (i / n)
        a_lp = 1 - math.exp(-2 * math.pi * f * (1 + q) / SR); a_hp = 1 - math.exp(-2 * math.pi * f * (1 - q) / SR)
        x = random.uniform(-1, 1)
        lp += a_lp * (x - lp); hp += a_hp * (lp - hp)
        xs.append((lp - hp) * e[i])
    return xs

def impact(dur=0.16):
    """Short punchy hit: a click + a falling low tone (for strong cuts: hook, comparison, ending)."""
    n = int(dur * SR); e = env(n, 0.002, 0.045); ph = 0.0; xs = []
    for i in range(n):
        f = 140 * (45 / 140) ** (i / n); ph += 2 * math.pi * f / SR
        click = random.uniform(-1, 1) * math.exp(-i / (0.004 * SR))
        xs.append(math.sin(ph) * e[i] + 0.5 * click)
    return xs

def tick(dur=0.035, f=3200):
    n = int(dur * SR); e = env(n, 0.0005, 0.006)
    return [(math.sin(2 * math.pi * f * i / SR) * 0.6 + random.uniform(-0.4, 0.4)) * e[i] for i in range(n)]

def pop(dur=0.08):
    n = int(dur * SR); e = env(n, 0.002, 0.02); ph = 0.0; xs = []
    for i in range(n):
        f = 1100 * (320 / 1100) ** (i / n); ph += 2 * math.pi * f / SR
        xs.append(math.sin(ph) * e[i])
    return xs

save('swipe', swipe(0.16, 900, 7000, 0.035))            # left/right whip
save('swipe-up', swipe(0.15, 600, 9000, 0.03, 0.45))      # cards rising
save('swipe-down', swipe(0.16, 8000, 700, 0.035))         # zoom-in / drop
save('impact', impact())                                  # strong cut
save('tick', tick(), 0.75)                                # pointer click / item
save('pop', pop(), 0.8)                                   # object appears
# keep the old names working but fast: whoosh → the new swipe
save('whoosh', swipe(0.16, 900, 7000, 0.035))
print('ok')
