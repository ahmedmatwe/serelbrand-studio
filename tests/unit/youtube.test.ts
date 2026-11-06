import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authUrl, exchangeCode, loadAuth, pkcePair, readClientJson, runLoopbackFlow, saveAuth, TokenSource, YOUTUBE_SCOPES } from '../../src/providers/youtube/oauth.ts';
import { RealYouTube } from '../../src/providers/youtube/youtube.ts';

const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...headers } });
const tmp = () => mkdtempSync(join(tmpdir(), 'yt-'));
const fixedTokens = () => ({ token: async () => 'ACCESS' }) as unknown as TokenSource;

test('oauth: consent URL uses PKCE S256, offline access, all scopes', () => {
  const { verifier, challenge } = pkcePair();
  assert.ok(verifier.length >= 43 && challenge.length >= 43);
  const u = new URL(authUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:5/callback', challenge, state: 'st' }));
  assert.equal(u.hostname, 'accounts.google.com');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.deepEqual(u.searchParams.get('scope')!.split(' '), YOUTUBE_SCOPES);
});

test('oauth: client JSON must be a Desktop app client', () => {
  const d = tmp();
  try {
    writeFileSync(join(d, 'ok.json'), JSON.stringify({ installed: { client_id: 'id', client_secret: 'sec' } }));
    writeFileSync(join(d, 'web.json'), JSON.stringify({ web: { client_id: 'id' } }));
    assert.deepEqual(readClientJson(join(d, 'ok.json')), { clientId: 'id', clientSecret: 'sec' });
    assert.throws(() => readClientJson(join(d, 'web.json')), /Desktop app/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('oauth: tokens are saved with 0600 permissions', () => {
  const d = tmp();
  try {
    const p = join(d, 'secrets', 'youtube.json');
    saveAuth(p, { clientId: 'a', clientSecret: 'b', refreshToken: 'c', savedAt: 'now' });
    assert.equal(statSync(p).mode & 0o777, 0o600);
    assert.equal(loadAuth(p)!.refreshToken, 'c');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('oauth: code exchange reports missing scopes', async () => {
  const f = (async () => json({ refresh_token: 'r', access_token: 'a', scope: YOUTUBE_SCOPES[0] })) as unknown as typeof fetch;
  const r = await exchangeCode({ clientId: 'c', clientSecret: 's', code: 'x', verifier: 'v', redirectUri: 'u', fetchImpl: f });
  assert.equal(r.refreshToken, 'r');
  assert.equal(r.missingScopes.length, 2);
});

test('oauth: loopback flow accepts the right state and rejects a forged one', async () => {
  const f = (async () => json({ refresh_token: 'REFRESH', access_token: 'a', scope: YOUTUBE_SCOPES.join(' ') })) as unknown as typeof fetch;
  const ok = await runLoopbackFlow({
    clientId: 'c', clientSecret: 's', fetchImpl: f,
    open: (url) => { const u = new URL(url); void fetch(`${u.searchParams.get('redirect_uri')}?code=CODE&state=${u.searchParams.get('state')}`); },
  });
  assert.equal(ok.refreshToken, 'REFRESH');
  await assert.rejects(runLoopbackFlow({
    clientId: 'c', clientSecret: 's', fetchImpl: f,
    open: (url) => { const u = new URL(url); void fetch(`${u.searchParams.get('redirect_uri')}?code=CODE&state=FORGED`); },
  }), /state mismatch/);
});

test('token source: caches access token; invalid_grant explains how to fix', async () => {
  let n = 0;
  const ts = new TokenSource({ clientId: 'c', clientSecret: 's', refreshToken: 'r' }, (async () => { n++; return json({ access_token: 'A', expires_in: 3600 }); }) as unknown as typeof fetch);
  assert.equal(await ts.token(), 'A');
  assert.equal(await ts.token(), 'A');
  assert.equal(n, 1);
  const bad = new TokenSource({ clientId: 'c', clientSecret: 's', refreshToken: 'r' }, (async () => json({ error: 'invalid_grant' }, 400)) as unknown as typeof fetch);
  await assert.rejects(bad.token(), /youtube:auth/);
});

function videoFile() {
  const d = tmp();
  writeFileSync(join(d, 'v.mp4'), Buffer.alloc(200, 7));
  writeFileSync(join(d, 't.png'), Buffer.from('png'));
  writeFileSync(join(d, 'c.srt'), '1\n00:00:00,000 --> 00:00:01,000\nمرحبا\n');
  return d;
}
const req = (d: string) => ({ videoPath: join(d, 'v.mp4'), thumbnailPath: join(d, 't.png'), captionsPath: join(d, 'c.srt'), title: 'عنوان', description: 'وصف', tags: ['a'], visibility: 'private' as const, containsSyntheticMedia: true, defaultLanguage: 'ar' });

test('upload: resumable session, private + synthetic disclosure, thumbnail warning is non-fatal, captions sent', async () => {
  const d = videoFile();
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('uploadType=resumable')) return new Response(null, { status: 200, headers: { location: 'https://upload.example/session1' } });
    if (String(url) === 'https://upload.example/session1') return json({ id: 'VID123' });
    if (String(url).includes('thumbnails/set')) return json({ error: { message: 'forbidden' } }, 403);
    if (String(url).includes('/captions')) return json({ id: 'cap' });
    throw new Error('unexpected ' + url);
  }) as unknown as typeof fetch;
  try {
    const r = await new RealYouTube({ tokens: fixedTokens(), categoryId: '27', fetchImpl: f, sleep: async () => {} }).upload(req(d));
    assert.equal(r.youtubeVideoId, 'VID123');
    const meta = JSON.parse(String(calls[0]!.init.body));
    assert.equal(meta.status.privacyStatus, 'private');
    assert.equal(meta.status.containsSyntheticMedia, true);
    assert.equal(meta.status.selfDeclaredMadeForKids, false);
    assert.equal(meta.snippet.categoryId, '27');
    assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer ACCESS');
    assert.equal(r.warnings!.length, 1);
    assert.match(r.warnings![0]!, /phone-verified/);
    assert.ok(String(calls.find((c) => c.url.includes('/captions'))!.init.body).includes('"language":"ar"'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('upload: resumes from the byte offset the server reports after an interruption', async () => {
  const d = videoFile();
  const puts: Record<string, string>[] = [];
  let first = true;
  const f = (async (url: string, init: RequestInit) => {
    if (String(url).includes('uploadType=resumable')) return new Response(null, { status: 200, headers: { location: 'https://upload.example/s' } });
    if (String(url) === 'https://upload.example/s') {
      const h = init.headers as Record<string, string>;
      if (h['content-range']?.startsWith('bytes */')) return new Response(null, { status: 308, headers: { range: 'bytes=0-99' } });
      puts.push(h);
      if (first) { first = false; throw new TypeError('socket hang up'); }
      return json({ id: 'RESUMED' });
    }
    return json({});
  }) as unknown as typeof fetch;
  try {
    const r = await new RealYouTube({ tokens: fixedTokens(), categoryId: '27', fetchImpl: f, sleep: async () => {} }).upload({ ...req(d), thumbnailPath: undefined, captionsPath: undefined });
    assert.equal(r.youtubeVideoId, 'RESUMED');
    assert.equal(puts[1]!['content-range'], 'bytes 100-199/200');
    assert.equal(puts[1]!['content-length'], '100');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('upload: daily quota error is not retried', async () => {
  const d = videoFile();
  const f = (async () => json({ error: { message: 'quota', errors: [{ reason: 'quotaExceeded' }] } }, 403)) as unknown as typeof fetch;
  try {
    await assert.rejects(new RealYouTube({ tokens: fixedTokens(), categoryId: '27', fetchImpl: f }).upload(req(d)), (e: { retryable: boolean; message: string }) => !e.retryable && /quota/.test(e.message));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('analytics: maps report columns; no invented impressions/CTR', async () => {
  const f = (async () => json({
    columnHeaders: ['views', 'estimatedMinutesWatched', 'averageViewDuration', 'averageViewPercentage', 'likes', 'comments', 'shares', 'subscribersGained'].map((name) => ({ name })),
    rows: [[1000, 3000, 180, 42.5, 50, 7, 3, 12]],
  })) as unknown as typeof fetch;
  const m = await new RealYouTube({ tokens: fixedTokens(), categoryId: '27', fetchImpl: f }).metrics('VID');
  assert.equal(m.views, 1000);
  assert.equal(m.watchTimeHours, 50);
  assert.equal(m.avgPercentViewed, 0.425);
  assert.equal(m.ctr, undefined);
  assert.equal(m.impressions, undefined);
});

test('upload: detects YouTube locking a scheduled video to private (unaudited API project)', async () => {
  const d = videoFile();
  const f = (async (url: string) => {
    if (String(url).includes('uploadType=resumable')) return new Response(null, { status: 200, headers: { location: 'https://upload.example/s9' } });
    if (String(url) === 'https://upload.example/s9') return json({ id: 'LOCKED', status: { privacyStatus: 'private', uploadStatus: 'uploaded' } });
    return json({});
  }) as unknown as typeof fetch;
  try {
    const r = await new RealYouTube({ tokens: fixedTokens(), categoryId: '27', fetchImpl: f, sleep: async () => {} }).upload({ ...req(d), thumbnailPath: undefined, captionsPath: undefined, publishAt: '2026-11-08T17:00:00Z' });
    assert.ok(r.warnings!.some((w) => w.startsWith('YOUTUBE_LOCKED_PRIVATE')));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
