import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRuns, watchdogMessage } from '../../src/agents/watchdog.ts';

test('watchdog: a failed social run is re-run once; an autopilot failure is only reported', async () => {
  const calls: string[] = [];
  const now = new Date('2026-11-12T15:00:00Z');
  const runs = [
    { id: 1, name: 'social', conclusion: 'failure', created_at: '2026-11-12T13:04:00Z', run_attempt: 1 },
    { id: 2, name: 'autopilot', conclusion: 'failure', created_at: '2026-11-12T12:04:00Z', run_attempt: 1 },
    { id: 3, name: 'social', conclusion: 'success', created_at: '2026-11-12T14:04:00Z', run_attempt: 1 },
  ];
  const f = (async (url: string, init?: RequestInit) => { calls.push(`${init?.method ?? 'GET'} ${url.replace(/\?.*/, '')}`); return new Response(JSON.stringify({ workflow_runs: runs }), { status: 200 }); }) as unknown as typeof fetch;
  const out = await checkRuns('o/r', 't', now, f);
  assert.equal(out.length, 2);
  assert.equal(out.find((x) => x.key === 'run:1')!.fixed, 'اتعاد تشغيله');
  assert.equal(out.find((x) => x.key === 'run:2')!.fixed, undefined);
  assert.ok(calls.includes('POST https://api.github.com/repos/o/r/actions/runs/1/rerun-failed-jobs'));
  assert.ok(!calls.some((c) => c.includes('runs/2/rerun')));
});

test('watchdog: social stalled is flagged in posting hours', async () => {
  const f = (async () => new Response(JSON.stringify({ workflow_runs: [{ id: 9, name: 'social', conclusion: 'success', created_at: '2026-11-12T09:04:00Z', run_attempt: 1 }] }), { status: 200 })) as unknown as typeof fetch;
  const out = await checkRuns('o/r', 't', new Date('2026-11-12T15:00:00Z'), f);
  assert.ok(out.some((x) => x.key.startsWith('social-stalled')));
});

test('watchdog: message separates what it fixed from what needs a fix', () => {
  const m = watchdogMessage([{ key: 'a', text: 'منشور واقف', fixed: 'اتصلّح' }, { key: 'b', text: 'تشغيل فشل' }])!;
  assert.match(m, /🔧 منشور واقف/); assert.match(m, /⚠️ تشغيل فشل/); assert.match(m, /صلّح/);
  assert.equal(watchdogMessage([]), undefined);
});
