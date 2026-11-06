/**
 * Local approval dashboard (Arabic, RTL): verify sources, watch the render, approve or reject.
 * Bound to 127.0.0.1 only; every POST needs the per-process CSRF token and a same-origin request.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type { AgentContext } from '../agents/base.ts';
import type { FactCheckReport } from '../agents/schemas.ts';
import type { RenderOutput } from '../media/renderer.ts';
import type { PublishLog } from '../publishing/publisher.ts';
import type { PrePublicationReport } from '../reports/prepublication.ts';
import { approve, reject, verifyClaim } from '../publishing/approval.ts';
import { publish, review } from '../workflows/orchestrator.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const MEDIA = /^(video\.mp4|short-\d{1,2}\.mp4|thumbnail\.png)$/;
const ID = /^[a-z]+_[a-f0-9]{16}$/;

function page(title: string, body: string, csrf: string) {
  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{--bg:#f6f6f3;--fg:#1b1b19;--mut:#6d6d66;--card:#fff;--line:#e3e3dd;--ok:#1f7a4d;--okb:#e2f3e9;--warn:#8a5a00;--warnb:#fdf0d6;--bad:#a12622;--badb:#fbe3e1;--acc:#0B1E3F;--gold:#F5B700}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecece7;--mut:#a2a29b;--card:#1d1d1b;--line:#32322e;--okb:#163a27;--ok:#80d4a7;--warnb:#3a2d10;--warn:#f0c46a;--badb:#3f1a18;--bad:#f2938d;--acc:#dfe6f5}}
*{box-sizing:border-box}body{margin:0;font-family:"Geeza Pro",system-ui,sans-serif;background:var(--bg);color:var(--fg);line-height:1.7}
header{background:#0B1E3F;color:#fff;padding:14px 24px;display:flex;gap:12px;align-items:center}header b{color:var(--gold);font-size:1.3rem}
main{max-width:1100px;margin:auto;padding:20px}section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin:16px 0}
h2{margin:.2em 0 .6em;font-size:1.15rem}h3{margin:.6em 0 .3em;font-size:1rem}.mut{color:var(--mut);font-size:.9rem}
.b{display:inline-block;padding:1px 10px;border-radius:999px;font-size:.85em}.ok{background:var(--okb);color:var(--ok)}.warn{background:var(--warnb);color:var(--warn)}.bad{background:var(--badb);color:var(--bad)}
button{font:inherit;border-radius:9px;border:1px solid var(--line);background:var(--card);color:var(--fg);padding:6px 14px;cursor:pointer}button.p{background:#0B1E3F;color:#fff;border-color:#0B1E3F}button.r{color:var(--bad)}
input[type=url],textarea{font:inherit;width:100%;padding:6px 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
.claim{border-top:1px solid var(--line);padding:10px 0}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.media{display:grid;grid-template-columns:2fr 1fr;gap:12px}.shorts{display:flex;gap:8px;overflow-x:auto}.shorts video{height:320px;border-radius:10px}video,img{max-width:100%;border-radius:10px;background:#000}
@media(max-width:800px){.media{grid-template-columns:1fr}}
</style></head><body><header><b>سر البراند</b><span>لوحة التحكم</span></header><main>${body}</main>
<script>document.querySelectorAll('form').forEach(f=>{const i=document.createElement('input');i.type='hidden';i.name='csrf';i.value=${JSON.stringify(csrf)};f.appendChild(i)})</script></body></html>`;
}

function renderHome(ctx: AgentContext, flash: string) {
  const parts: string[] = [];
  if (flash) parts.push(`<section class="ok">${esc(flash)}</section>`);

  // 1) Videos waiting for source verification.
  const toVerify = ctx.repos.videos.list('reviewed').map((v) => ({ v, fc: ctx.repos.artifacts.latest<FactCheckReport>(v.id, 'fact_check')?.data })).filter((x) => x.fc?.claims.some((c) => c.humanReviewRequired));
  for (const { v, fc } of toVerify) {
    const claims = fc!.claims.map((c, i) => ({ c, i })).filter((x) => x.c.humanReviewRequired);
    parts.push(`<section><h2>🔎 أكّد المصادر: ${esc(v.title)}</h2>
      <p class="mut">افتح كل رابط بنفسك. لو المصدر بيأكد الجملة دوس "المصدر صحيح". لو مفيش مصدر، حط رابط حقيقي (https) أو ارفض الفيديو. (${claims.length} ادعاء)</p>
      ${claims.map(({ c, i }) => `<div class="claim"><div><b>#${i}</b> ${esc(c.claim)} <span class="b ${c.status === 'unverified' ? 'bad' : 'warn'}">${esc(c.type)}</span></div>
        ${c.sourceUrl ? `<div class="mut">المصدر المقترح: <a href="${esc(c.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(c.sourceUrl)}</a></div>` : '<div class="mut">مفيش مصدر مقترح</div>'}
        <form method="post" action="/claim/${esc(v.id)}/${i}" class="row">
          <input type="url" name="url" placeholder="${c.sourceUrl ? 'سيبها فاضية لو المصدر المقترح صحيح' : 'https://… رابط المصدر'}" ${c.sourceUrl ? '' : 'required'} style="flex:1;min-width:240px">
          <button class="p">المصدر صحيح ✓</button></form></div>`).join('')}
      <form method="post" action="/reject-video/${esc(v.id)}" class="row" style="margin-top:10px"><button class="r">ارفض الفيديو ده</button></form>
    </section>`);
  }

  // 2) Pending approvals.
  for (const a of ctx.repos.approvals.pending()) {
    const r = JSON.parse(a.report) as PrePublicationReport;
    const rd = ctx.repos.artifacts.latest<RenderOutput>(a.video_id, 'render')?.data;
    const media = (f: string) => `/media/${esc(a.video_id)}/${f}`;
    parts.push(`<section><h2>✅ مستني موافقتك: ${esc(r.title)}</h2>
      <div class="row"><span class="b ${r.qualityScore >= 85 ? 'ok' : 'warn'}">الجودة ${r.qualityScore}</span><span class="b ${r.complianceScore >= 90 ? 'ok' : 'bad'}">الامتثال ${r.complianceScore}</span><span class="b ok">الحقوق: ${esc(r.copyrightStatus)}</span><span class="b ${r.factCheckStatus === 'verified' ? 'ok' : 'warn'}">المصادر: ${esc(r.factCheckStatus)}</span><span class="mut">المدة ${Math.round(r.durationSec / 60)} دقيقة · التكلفة $${r.estimatedCostUsd}</span></div>
      ${rd ? `<div class="media" style="margin-top:12px"><video controls preload="metadata" src="${media('video.mp4')}"></video><img src="${media('thumbnail.png')}" alt="الصورة المصغّرة"></div>
      ${rd.shorts.length ? `<h3>الـShorts (${rd.shorts.length})</h3><div class="shorts">${rd.shorts.map((s) => `<video controls preload="metadata" src="${media(s.path.split('/').pop()!)}"></video>`).join('')}</div>` : ''}` : '<p class="mut">لا يوجد render.</p>'}
      ${r.warnings.length ? `<h3>تحذيرات</h3><ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      <form method="post" action="/approve/${esc(a.id)}"><h3>ملاحظتك (مطلوبة)</h3><textarea name="note" rows="2" required>شفت الفيديو والمعلومات صحيحة.</textarea>
        <div class="row" style="margin-top:8px"><button class="p">وافق وارفع private ⬆️</button><span class="mut">الرفع بيبقى private. النشر العلني مقفول.</span></div></form>
      <form method="post" action="/reject/${esc(a.id)}" class="row" style="margin-top:8px"><button class="r">ارفض</button></form>
    </section>`);
  }

  // 3) Uploaded.
  const up = ctx.repos.videos.list().filter((v) => v.youtube_video_id);
  if (up.length) parts.push(`<section><h2>⬆️ اترفع على القناة</h2>${up.map((v) => {
    const pl = ctx.repos.artifacts.latest<PublishLog>(v.id, 'publish_log')?.data;
    const m = ctx.repos.analytics.forVideo(v.id).at(-1)?.metrics;
    return `<div class="claim"><a href="https://studio.youtube.com/video/${esc(v.youtube_video_id)}/edit" target="_blank" rel="noopener noreferrer">${esc(v.title)}</a> <span class="b ok">${esc(v.visibility)}</span> <span class="mut">${pl?.shorts?.length ?? 0} Shorts${m ? ` · ${m.views ?? 0} مشاهدة` : ''}</span></div>`;
  }).join('')}</section>`);

  if (parts.length === (flash ? 1 : 0)) parts.push('<section><h2>مفيش حاجة مستنياك دلوقتي 👌</h2><p class="mut">النظام هيبعتلك إشعار أول ما فيديو جديد يجهز.</p></section>');
  return parts.join('');
}

async function body(req: IncomingMessage): Promise<URLSearchParams> {
  let s = '';
  for await (const ch of req) { s += ch; if (s.length > 20_000) break; }
  return new URLSearchParams(s);
}

export function startDashboard(ctx: AgentContext, port = 8787) {
  const csrf = randomBytes(18).toString('hex');
  const origin = `http://127.0.0.1:${port}`;
  const renders = resolve(ctx.config.rootDir, 'data/renders');

  const send = (res: ServerResponse, code: number, html: string) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; media-src 'self'; img-src 'self'" }); res.end(html); };
  const back = (res: ServerResponse, msg: string) => { res.writeHead(303, { location: `/?m=${encodeURIComponent(msg)}` }); res.end(); };

  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', origin);
      if (req.method === 'GET' && u.pathname === '/') return send(res, 200, page('لوحة التحكم', renderHome(ctx, u.searchParams.get('m') ?? ''), csrf));

      const mm = u.pathname.match(/^\/media\/([^/]+)\/([^/]+)$/);
      if (req.method === 'GET' && mm) {
        const [, vid, file] = mm;
        if (!ID.test(vid!) || !MEDIA.test(file!)) return send(res, 404, 'not found');
        const p = resolve(renders, vid!, file!);
        if (!p.startsWith(renders) || !existsSync(p)) return send(res, 404, 'not found');
        const size = statSync(p).size;
        const type = file!.endsWith('.png') ? 'image/png' : 'video/mp4';
        const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
        if (range) {
          const start = range[1] ? Number(range[1]) : 0;
          const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
          res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
          return createReadStream(p, { start, end }).pipe(res);
        }
        res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
        return createReadStream(p).pipe(res);
      }

      if (req.method !== 'POST') return send(res, 404, 'not found');
      // CSRF: same-origin + token.
      const o = req.headers.origin;
      if (o && o !== origin && o !== `http://localhost:${port}`) return send(res, 403, 'forbidden');
      const f = await body(req);
      if (f.get('csrf') !== csrf) return send(res, 403, 'forbidden (refresh the page)');
      const by = 'dashboard';

      let m = u.pathname.match(/^\/claim\/([^/]+)\/(\d+)$/);
      if (m && ID.test(m[1]!)) {
        const url = f.get('url')?.trim() || undefined;
        const fc = verifyClaim(ctx, m[1]!, Number(m[2]), { url, by });
        if (!fc.claims.some((c) => c.humanReviewRequired)) {
          const r = await review(ctx, m[1]!);
          return back(res, r.approval ? 'كل المصادر اتأكدت ✓ — الفيديو بقى جاهز لموافقتك تحت' : `كل المصادر اتأكدت، بس الفيديو لسه عليه ملاحظات: ${r.report?.recommendationText ?? ''}`);
        }
        return back(res, `اتأكد الادعاء #${m[2]} ✓`);
      }
      m = u.pathname.match(/^\/approve\/([^/]+)$/);
      if (m && ID.test(m[1]!)) {
        const a = approve(ctx, m[1]!, { by, note: f.get('note') ?? '', acceptRisks: true, visibility: 'private' });
        void publish(ctx, a.video_id).then((r) => ctx.logger.info('dashboard publish', { videoId: a.video_id, status: r.status, error: r.error }));
        return back(res, 'اتوافق ✓ — الرفع (private) بدأ، وهيظهر تحت لما يخلص');
      }
      m = u.pathname.match(/^\/reject\/([^/]+)$/);
      if (m && ID.test(m[1]!)) { reject(ctx, m[1]!, by, f.get('note') || 'rejected from dashboard'); return back(res, 'اترفض ✓'); }
      m = u.pathname.match(/^\/reject-video\/([^/]+)$/);
      if (m && ID.test(m[1]!)) {
        ctx.repos.videos.update(m[1]!, { status: 'rejected' });
        ctx.audit.record({ actor: 'human', action: 'video.rejected', target: m[1]!, details: { via: 'dashboard' } });
        return back(res, 'اترفض ✓');
      }
      return send(res, 404, 'not found');
    } catch (err) {
      ctx.logger.warn('dashboard error', { error: (err as Error).message });
      return back(res, `⚠️ ${(err as Error).message}`);
    }
  });
  return new Promise<{ url: string; close: () => void; csrf: string }>((ok) => server.listen(port, '127.0.0.1', () => ok({ url: origin, close: () => server.close(), csrf })));
}
