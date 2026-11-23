/**
 * TikTok direct posting (Content Posting API, Direct Post) — the owner approves every video on a page that follows
 * TikTok's UX rules: account name + avatar, video preview, editable caption, privacy chosen by hand (no default),
 * comments / duet / stitch (off by default, greyed out when the account turned them off), commercial content
 * disclosure, and the Music Usage / Branded Content consent line next to «Post».
 *
 *  GET  /tiktok/approve/<t>  ← link sent on Telegram for one video (t = random token kept 10 days in KV)
 *  GET  /tiktok/login?t=<t>  → TikTok Login Kit (only from a valid approval link)
 *  GET  /tiktok/callback     ← TikTok sends the code back; tokens are kept in KV (tt:token)
 *  POST /tiktok/post/<t>     → uploads the video (FILE_UPLOAD, from the bot's own media store) and posts it
 *  GET  /tiktok/status/<t>   → publish status (polled by the result page)
 *
 * Vars/secrets: TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET.
 */
const API = 'https://open.tiktokapis.com/v2';
const SCOPES = 'user.info.basic,video.upload,video.publish';
const TTL = 60 * 60 * 24 * 10;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const html = (body, status = 200) => new Response(`<!doctype html><html lang="en" translate="no"><head><meta charset="utf-8"><meta name="google" content="notranslate"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ser El Mobile — Post to TikTok</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;padding:20px 16px;background:#fafafa;color:#161823}
h1{font-size:1.3rem;margin:.2em 0 1em}.card{background:#fff;border:1px solid #e3e3e6;border-radius:14px;padding:16px;margin-bottom:14px}
.acct{display:flex;align-items:center;gap:12px}.acct img{width:44px;height:44px;border-radius:50%}.muted{color:#6b6b73;font-size:.88rem}
video{width:100%;max-height:60vh;border-radius:10px;background:#000}textarea,select{width:100%;box-sizing:border-box;font:inherit;padding:10px;border:1px solid #cfcfd4;border-radius:10px}
label.row{display:flex;justify-content:space-between;align-items:center;padding:8px 0}label.row.off{opacity:.45}
.btn{display:block;width:100%;padding:14px;border:0;border-radius:12px;background:#fe2c55;color:#fff;font-size:1.05rem;font-weight:600;cursor:pointer;text-align:center;text-decoration:none}
.btn[disabled]{background:#f3a3b3;cursor:not-allowed}.note{font-size:.85rem;color:#45454d;margin:10px 0}.warn{color:#b42318;font-size:.88rem}
.sub{padding-left:14px;border-left:3px solid #eee;margin:6px 0}
</style></head><body>${body}</body></html>`, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

const rand = () => [...crypto.getRandomValues(new Uint8Array(18))].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 24);

async function tokenForm(env, params) {
  const r = await fetch(`${API}/oauth/token/`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, ...params }) });
  const j = await r.json();
  if (!j.access_token) throw new Error(j.error_description || j.error || 'token failed');
  const tok = { access_token: j.access_token, refresh_token: j.refresh_token, open_id: j.open_id, expires_at: Date.now() + (j.expires_in - 120) * 1000 };
  await env.BOT.put('tt:token', JSON.stringify(tok));
  return tok;
}

/** A valid access token (refreshed when needed), or null when the owner has to log in. */
export async function accessToken(env) {
  const tok = JSON.parse((await env.BOT.get('tt:token')) || 'null');
  if (!tok) return null;
  if (Date.now() < tok.expires_at) return tok.access_token;
  try { return (await tokenForm(env, { grant_type: 'refresh_token', refresh_token: tok.refresh_token })).access_token; } catch { return null; }
}

async function api(env, path, body) {
  const at = await accessToken(env);
  const r = await fetch(`${API}${path}`, { method: 'POST', headers: { authorization: `Bearer ${at}`, 'content-type': 'application/json; charset=UTF-8' }, body: JSON.stringify(body || {}) });
  return r.json();
}

/** Called from /ingest: { ttApprove: { file, caption, videoId } } → approval link. */
export async function newApproval(env, origin, a) {
  const t = rand();
  await env.BOT.put(`tt:ap:${t}`, JSON.stringify({ file: a.file, caption: String(a.caption || '').slice(0, 2200), videoId: a.videoId || '', at: new Date().toISOString() }), { expirationTtl: TTL });
  return `${origin}/tiktok/approve/${t}`;
}

function approvePage(t, ap, info) {
  const opts = (info.privacy_level_options || []).map((p) => `<option value="${esc(p)}">${esc({ PUBLIC_TO_EVERYONE: 'Everyone', MUTUAL_FOLLOW_FRIENDS: 'Friends', FOLLOWER_OF_CREATOR: 'Followers', SELF_ONLY: 'Only me' }[p] || p)}</option>`).join('');
  const box = (name, label, off) => `<label class="row${off ? ' off' : ''}"><span>${label}${off ? ' <span class="muted">(turned off in your TikTok settings)</span>' : ''}</span><input type="checkbox" name="${name}" ${off ? 'disabled' : ''}></label>`;
  return html(`<h1>Post to TikTok</h1>
<div class="card acct"><img src="${esc(info.creator_avatar_url)}" alt=""><div><b>${esc(info.creator_nickname)}</b><div class="muted">@${esc(info.creator_username)} — this account will post</div></div></div>
<form method="post" action="/tiktok/post/${t}" id="f">
<div class="card"><video src="/media/${esc(ap.file)}" controls playsinline preload="metadata"></video></div>
<div class="card"><b>Caption</b><textarea name="title" rows="4" maxlength="2200">${esc(ap.caption)}</textarea></div>
<div class="card"><b>Who can view this video</b>
<select name="privacy" id="privacy" required><option value="" selected disabled>Select privacy…</option>${opts}</select>
<div style="margin-top:10px"><b>Allow users to</b>
${box('comment', 'Comment', info.comment_disabled)}${box('duet', 'Duet', info.duet_disabled)}${box('stitch', 'Stitch', info.stitch_disabled)}</div></div>
<div class="card"><label class="row"><span><b>Disclose video content</b><div class="muted">Turn on if this video promotes yourself, a brand, product or service</div></span><input type="checkbox" name="disclose" id="disclose"></label>
<div id="dopts" class="sub" hidden>
<label class="row"><span>Your brand<div class="muted">You are promoting yourself or your own business. Labelled “Promotional content”.</div></span><input type="checkbox" name="own" id="own"></label>
<label class="row" id="bcrow"><span>Branded content<div class="muted">You are promoting another brand or a third party. Labelled “Paid partnership”.</div></span><input type="checkbox" name="branded" id="branded"></label>
<div class="warn" id="dwarn">You need to indicate if your content promotes yourself, a third party, or both.</div></div></div>
<p class="note" id="consent">By posting, you agree to TikTok's <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank">Music Usage Confirmation</a>.</p>
<p class="note muted">After you tap Post, it may take a few minutes for the video to process and appear on your profile.</p>
<button class="btn" id="go" disabled>Post</button></form>
<script>
const $=id=>document.getElementById(id);
function upd(){const d=$('disclose').checked;$('dopts').hidden=!d;const own=$('own').checked,br=$('branded').checked;
 const priv=$('privacy').value;
 // branded content cannot be private
 const so=[...$('privacy').options].find(o=>o.value==='SELF_ONLY');if(so){so.disabled=br;so.textContent=br?'Only me (branded content visibility cannot be set to private)':'Only me';}
 if(br&&priv==='SELF_ONLY')$('privacy').value='';
 $('dwarn').hidden=!d||own||br;
 $('consent').innerHTML=br?"By posting, you agree to TikTok's <a href='https://www.tiktok.com/legal/page/global/bc-policy/en' target='_blank'>Branded Content Policy</a> and <a href='https://www.tiktok.com/legal/page/global/music-usage-confirmation/en' target='_blank'>Music Usage Confirmation</a>.":"By posting, you agree to TikTok's <a href='https://www.tiktok.com/legal/page/global/music-usage-confirmation/en' target='_blank'>Music Usage Confirmation</a>.";
 $('go').disabled=!$('privacy').value||(d&&!own&&!br);
 if(d&&(own||br))$('go').title=br?'Your video will be labeled as “Paid partnership”':'Your video will be labeled as “Promotional content”';}
document.querySelectorAll('input,select').forEach(e=>e.addEventListener('change',upd));upd();
$('f').addEventListener('submit',()=>{$('go').disabled=true;$('go').textContent='Posting…';});
</script>`);
}

export async function handleTikTok(req, env, url) {
  const p = url.pathname;
  if (!p.startsWith('/tiktok/')) return null;
  const m = p.match(/^\/tiktok\/(approve|post|status)\/([a-z0-9]{24})$/);
  const t = m?.[2] || url.searchParams.get('t') || '';
  const ap = /^[a-z0-9]{24}$/.test(t) ? JSON.parse((await env.BOT.get(`tt:ap:${t}`)) || 'null') : null;

  if (p === '/tiktok/login') {
    if (!ap) return html('<h1>Link expired</h1><p>Open the newest approval link from Telegram.</p>', 404);
    const state = rand();
    await env.BOT.put(`tt:state:${state}`, t, { expirationTtl: 600 });
    const q = new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY, scope: SCOPES, response_type: 'code', redirect_uri: `${url.origin}/tiktok/callback`, state });
    return Response.redirect(`https://www.tiktok.com/v2/auth/authorize/?${q}`, 302);
  }
  if (p === '/tiktok/callback') {
    const back = await env.BOT.get(`tt:state:${url.searchParams.get('state') || '-'}`);
    if (!back) return html('<h1>Login expired</h1><p>Open the approval link from Telegram again.</p>', 400);
    if (!url.searchParams.get('code')) return html(`<h1>Login cancelled</h1><p class="muted">${esc(url.searchParams.get('error_description') || '')}</p><a class="btn" href="/tiktok/approve/${back}">Back</a>`, 400);
    try { await tokenForm(env, { grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: `${url.origin}/tiktok/callback` }); }
    catch (e) { return html(`<h1>Login failed</h1><p class="muted">${esc(e.message)}</p>`, 400); }
    return Response.redirect(`${url.origin}/tiktok/approve/${back}`, 302);
  }
  if (!m) return new Response('not found', { status: 404 });
  if (!ap) return html('<h1>Link expired</h1><p>Open the newest approval link from Telegram.</p>', 404);

  if (m[1] === 'approve') {
    if (ap.publishId) return html(`<h1>Already posted ✅</h1><p class="muted">Publish id ${esc(ap.publishId)}</p>`);
    if (!(await accessToken(env))) return html(`<h1>Post to TikTok</h1><div class="card"><p>Log in with the TikTok account that will post this video.</p><a class="btn" href="/tiktok/login?t=${t}">Continue with TikTok</a></div>`);
    const ci = await api(env, '/post/publish/creator_info/query/');
    if (ci.error?.code !== 'ok') {
      if (/token/i.test(ci.error?.code || '')) await env.BOT.put('tt:token', 'null');
      return html(`<h1>Can't post right now</h1><p>${esc(ci.error?.message || 'TikTok did not answer')}</p><p class="muted">Please try again later.</p><a class="btn" href="/tiktok/approve/${t}">Try again</a>`, 503);
    }
    return approvePage(t, ap, ci.data);
  }
  if (m[1] === 'post' && req.method === 'POST') {
    if (ap.publishId) return Response.redirect(`${url.origin}/tiktok/approve/${t}`, 303);
    const f = await req.formData();
    const privacy = String(f.get('privacy') || '');
    if (!privacy) return html('<h1>Choose who can view the video first</h1>', 400);
    const branded = f.get('disclose') === 'on' && f.get('branded') === 'on';
    const own = f.get('disclose') === 'on' && f.get('own') === 'on';
    const video = await env.BOT.get(`media:${ap.file}`, 'arrayBuffer');
    if (!video) return html('<h1>The video file expired</h1><p>It will be sent again with the next run.</p>', 410);
    const n = video.byteLength;
    const init = await api(env, '/post/publish/video/init/', {
      post_info: { title: String(f.get('title') || '').slice(0, 2200), privacy_level: privacy, disable_comment: f.get('comment') !== 'on', disable_duet: f.get('duet') !== 'on', disable_stitch: f.get('stitch') !== 'on', brand_content_toggle: branded, brand_organic_toggle: own, is_aigc: true },
      source_info: { source: 'FILE_UPLOAD', video_size: n, chunk_size: n, total_chunk_count: 1 },
    });
    if (init.error?.code !== 'ok') return html(`<h1>TikTok refused the post</h1><p>${esc(init.error?.message || "")}</p><p class="muted">code: ${esc(init.error?.code)}</p><a class="btn" href="/tiktok/approve/${t}">Back</a>`, 400);
    const up = await fetch(init.data.upload_url, { method: 'PUT', headers: { 'content-type': 'video/mp4', 'content-length': String(n), 'content-range': `bytes 0-${n - 1}/${n}` }, body: video });
    if (!up.ok) return html(`<h1>Upload failed</h1><p class="muted">HTTP ${up.status}</p><a class="btn" href="/tiktok/approve/${t}">Try again</a>`, 502);
    await env.BOT.put(`tt:ap:${t}`, JSON.stringify({ ...ap, publishId: init.data.publish_id, privacy, postedAt: new Date().toISOString() }), { expirationTtl: TTL });
    return html(`<h1>Sent to TikTok ✅</h1><div class="card"><p id="s">Processing… it may take a few minutes to appear on your profile.</p></div>
<script>async function poll(){const r=await (await fetch('/tiktok/status/${t}')).json();document.getElementById('s').textContent=r.text;if(!r.done)setTimeout(poll,4000);}poll();</script>`);
  }
  if (m[1] === 'status') {
    if (!ap.publishId) return new Response(JSON.stringify({ done: true, text: 'Not posted yet.' }), { headers: { 'content-type': 'application/json' } });
    const s = await api(env, '/post/publish/status/fetch/', { publish_id: ap.publishId });
    const st = s.data?.status || s.error?.code;
    const text = { PROCESSING_UPLOAD: 'Uploading…', PROCESSING_DOWNLOAD: 'Processing…', SEND_TO_USER_INBOX: 'Sent to your TikTok inbox.', PUBLISH_COMPLETE: 'Posted ✅ — it is on your profile now.', FAILED: `Failed: ${s.data?.fail_reason || ''}` }[st] || `Status: ${st}`;
    return new Response(JSON.stringify({ done: st === 'PUBLISH_COMPLETE' || st === 'FAILED', text }), { headers: { 'content-type': 'application/json' } });
  }
  return new Response('not found', { status: 404 });
}
