import React from 'react';
import { Composition } from 'remotion';
import { MotionShort, FPS } from './MotionShort';
import type { MotionPlan } from './types';

const sample: MotionPlan = {
  duration: 4, audio: '', brand: 'سر الموبايل', endCard: 'تابع القناة لسر جديد كل يوم', beats: [], captions: [],
  style: { camera: 0.5, transition: 'whip', particles: true, captionSize: 64, flash: 0.22, accent: '#FFD23F', good: '#22C55E', bad: '#FF4D4D', bg1: '#070B1A', bg2: '#12204A' },
  scenes: [{ type: 'hook', start: 0, end: 4, headline: { text: 'في كود سرّي', accent: 'سرّي' }, icon: 'lock' }],
};

export const Root: React.FC = () => (
  <Composition
    id="MotionShort"
    component={MotionShort as unknown as React.FC<Record<string, unknown>>}
    fps={FPS}
    width={1080}
    height={1920}
    durationInFrames={Math.ceil(sample.duration * FPS)}
    defaultProps={sample as unknown as Record<string, unknown>}
    calculateMetadata={({ props }) => ({ durationInFrames: Math.max(30, Math.ceil(Number((props as unknown as MotionPlan).duration) * FPS)) })}
  />
);
