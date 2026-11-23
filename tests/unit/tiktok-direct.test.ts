import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../bot/worker.js';

test('tiktok direct post: approval link → login → TikTok-compliant page → upload + post, never twice', async () => {
  const kv = new Map<string, any>();
  const env = {
    BOT: { get: async (k: string, type?: string) => (kv.has(k) ? (type === 'arrayBuffer' ? kv.get(k) : kv.get(k)) : null), put: async (k: string, v: any) => void kv.set(k, v) },
    TELEGRAM_BOT_TOKEN: 't', CHAT_ID: '42', INGEST_SECRET: 's', WEBHOOK_SECRET: 'w', TIKTOK_CLIENT_KEY: 'ck', TIKTOK_CLIENT_SECRET: 'cs',
  };
  kv.set('media:v1-1.mp4', new Uint8Array(1000).buffer);
  const calls: { url: string; body: any; headers?: any }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const u = String(url);
    calls.push({ url: u, body: init.body, headers: init.headers });
    if (u.endsWith('/oauth/token/')) return Response.json({ access_token: 'AT', refresh_token: 'RT', open_id: 'o', expires_in: 86400 });
    if (u.endsWith('/creator_info/query/')) return Response.json({ data: { creator_nickname: 'سر الموبايل', creator_username: 'ser.mobile', creator_avatar_url: 'https://a', privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'], comment_disabled: false, duet_disabled: true, stitch_disabled: false }, error: { code: 'ok' } });
    if (u.endsWith('/video/init/')) return Response.json({ data: { publish_id: 'p1', upload_url: 'https://upload/x' }, error: { code: 'ok' } });
    if (u === 'https://upload/x') return new Response(null, { status: 201 });
    return Response.json({ ok: true });
  }) as any;
  const go = (path: string, init: RequestInit = {}) => (worker as any).fetch(new Request(`https://bot${path}`, init), env);
  try {
    const r = await (await go('/ingest', { method: 'POST', headers: { authorization: 'Bearer s' }, body: JSON.stringify({ ttApprove: { file: 'v1-1.mp4', caption: 'سر <b>', title: 'ميزة' } }) })).json();
    const t = r.link.split('/').pop();
    assert.match(r.link, /^https:\/\/bot\/tiktok\/approve\/[a-z0-9]{24}$/);
    assert.equal(JSON.parse(calls.at(-1)!.body as string).reply_markup.inline_keyboard[0][0].url, r.link);

    assert.match(await (await go(`/tiktok/approve/${t}`)).text(), /Continue with TikTok/);
    const login = await go(`/tiktok/login?t=${t}`);
    const auth = new URL(login.headers.get('location'));
    assert.equal(auth.searchParams.get('scope'), 'user.info.basic,video.upload,video.publish');
    assert.equal((await go('/tiktok/login?t=nope')).status, 404, 'login only from a real approval link');
    const cb = await go(`/tiktok/callback?code=C&state=${auth.searchParams.get('state')}`);
    assert.equal(cb.headers.get('location'), `https://bot/tiktok/approve/${t}`);

    const page = await (await go(`/tiktok/approve/${t}`)).text();
    assert.match(page, /ser\.mobile/);
    assert.match(page, /<option value="" selected disabled>Select privacy/, 'no default privacy');
    assert.match(page, /سر &lt;b&gt;/, 'caption is escaped');
    assert.match(page, /name="duet" disabled/, 'duet greyed out when the account turned it off');
    assert.doesNotMatch(page, /name="comment" checked/);
    assert.match(page, /Music Usage Confirmation/);

    const form = new URLSearchParams({ title: 'كابشن', privacy: 'SELF_ONLY', comment: 'on' });
    const res = await go(`/tiktok/post/${t}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
    assert.match(await res.text(), /Sent to TikTok/);
    const init = JSON.parse(calls.find((c) => c.url.endsWith('/video/init/'))!.body as string);
    assert.deepEqual(init.source_info, { source: 'FILE_UPLOAD', video_size: 1000, chunk_size: 1000, total_chunk_count: 1 });
    assert.equal(init.post_info.privacy_level, 'SELF_ONLY');
    assert.equal(init.post_info.disable_comment, false);
    assert.equal(init.post_info.disable_duet, true);
    assert.equal(init.post_info.is_aigc, true);
    assert.equal((calls.find((c) => c.url === 'https://upload/x')!.headers as any)['content-range'], 'bytes 0-999/1000');
    const n = calls.length;
    await go(`/tiktok/post/${t}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
    assert.equal(calls.length, n, 'a second tap never posts twice');
  } finally { globalThis.fetch = real; }
});
