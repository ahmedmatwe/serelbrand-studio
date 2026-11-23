/**
 * "سر الموبايل" Telegram assistant — Cloudflare Worker (free, always on, replies instantly).
 *
 *  /telegram  ← Telegram webhook: the owner writes "تقرير" (report), "فيديو" (scheduled videos as buttons → the
 *               chosen one or all arrive as playable videos), "موضوع: …" / "اعمل فيديو عن …" (a topic request: kept
 *               until the autopilot researches + fact-checks it and replies), anything else → help. Only CHAT_ID.
 *  /requests  ← (GET, autopilot) pending topic requests.
 *  /vetoes    ← (GET, autopilot) library topics the owner removed with the «🗑️ شيل» button (x:<id>).
 *  /ingest    ← the autopilot (GitHub Actions) pushes the latest report, the video list (Telegram file_ids, so
 *               videos are re-sent without re-uploading) and alerts (e.g. a video going viral).
 *
 * Bindings: KV namespace BOT. Secrets: TELEGRAM_BOT_TOKEN, CHAT_ID, INGEST_SECRET, WEBHOOK_SECRET.
 */
import { handleTikTok, newApproval } from './tiktok.js';
const json = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
const say = (env, text, extra = {}) => tg(env, 'sendMessage', { chat_id: env.CHAT_ID, text: text.slice(0, 4000), disable_web_page_preview: true, ...extra });

const HELP = 'أهلاً 👋 أنا مساعد قناة سر الموبايل.\n\n' +
  '📊 اكتب «تقرير» — المشاهدات واللايكات والمتابعين على يوتيوب وفيسبوك وإنستجرام\n' +
  '🎬 اكتب «فيديو» — الفيديوهات المجدولة والجديدة، تختار واحد أو الكل\n' +
  '💡 اكتب «موضوع: …» أو «اعمل فيديو عن …» — أراجع المعلومة وأعمل عنها فيديو في الإنتاج الجاي\n' +
  '🔥 ولو فيديو ضرب مشاهدات عالية هبعتلك تنبيه لوحدي في أي وقت';

const page = (title, body) => `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Tahoma,sans-serif;max-width:760px;margin:0 auto;padding:24px 16px;line-height:1.8;color:#1b1b1f;background:#fafafa}h1{font-size:1.6rem}h2{font-size:1.15rem;margin-top:1.6em}.en{direction:ltr;text-align:left;border-top:1px solid #ddd;margin-top:2em;padding-top:1em}a{color:#5b3fd1}</style></head><body>${body}</body></html>`;
const UPDATED = '2026-11-22';
const PAGES = {
  '/': page('سر الموبايل', `<h1>سر الموبايل</h1><p>قناة بالعامية المصرية بتكشف أسرار الموبايل: أكواد، ميزات مخفية في الآيفون والأندرويد، وحيل التطبيقات — فيديو قصير كل يوم.</p>
<p>الأداة دي داخلية بتنشر فيديوهات القناة نفسها بس على حساباتها الرسمية (يوتيوب، فيسبوك، إنستجرام، تيك توك @ser.mobile) بعد موافقة صاحب القناة.</p>
<p><a href="/privacy">سياسة الخصوصية</a> · <a href="/terms">شروط الاستخدام</a></p>
<div class="en"><h2>Ser El Mobile (Secrets of Your Phone)</h2><p>An Egyptian-Arabic channel of short videos revealing phone tips: hidden codes, iPhone and Android features, and app tricks.</p><p>This internal tool only publishes the channel's own videos to the channel's own official accounts (YouTube, Facebook, Instagram, TikTok @ser.mobile), as approved by the channel owner. It is not offered to other users.</p><p><a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms of Service</a></p></div>`),
  '/privacy': page('سياسة الخصوصية — سر الموبايل', `<h1>سياسة الخصوصية</h1><p>آخر تحديث: ${UPDATED}</p>
<p>الأداة دي بيستخدمها صاحب قناة «سر الموبايل» بس، عشان ينشر فيديوهات القناة على حساباتها. مش بنجمع بيانات من أي حد تاني.</p>
<h2>البيانات اللي بنستخدمها</h2><p>مفاتيح الدخول لحسابات القناة نفسها (زي تيك توك)، واسم الحساب وصورته، وإحصائيات فيديوهات القناة. بنستخدمها لنشر الفيديوهات ومتابعة أدائها بس.</p>
<h2>التخزين والمشاركة</h2><p>المفاتيح محفوظة متشفّرة كأسرار في GitHub وCloudflare. مش بنبيع ولا بنشارك أي بيانات مع أي طرف تالت.</p>
<h2>الحذف</h2><p>صاحب الحساب يقدر يلغي الصلاحية في أي وقت من إعدادات تيك توك (الأمان ← التطبيقات المرتبطة)، وساعتها المفاتيح بتتمسح.</p>
<div class="en"><h1>Privacy Policy</h1><p>Last updated: ${UPDATED}</p><p>This tool is used only by the owner of the «سر الموبايل» (Ser El Mobile) channel to publish the channel's own videos to the channel's own accounts. It does not collect data from anyone else.</p>
<h2>Data we use</h2><p>Access tokens of the channel's own accounts (e.g. TikTok), the account's display name and avatar (to show which account is posting), and statistics of the channel's own videos. They are used only to publish the videos and measure their performance.</p>
<h2>Storage and sharing</h2><p>Tokens are stored encrypted as secrets in GitHub Actions and Cloudflare. We never sell or share any data with third parties.</p>
<h2>Deletion</h2><p>The account owner can revoke access at any time in TikTok (Settings → Security → Apps), after which the stored tokens are deleted.</p><h2>Contact</h2><p>Through the channel's official accounts.</p></div>`),
  '/terms': page('شروط الاستخدام — سر الموبايل', `<h1>شروط الاستخدام</h1><p>آخر تحديث: ${UPDATED}</p>
<p>الأداة دي خاصة بقناة «سر الموبايل» ومش متاحة لمستخدمين تانيين. صاحب القناة بيراجع كل فيديو ويوافق عليه قبل ما يتنشر، ومسؤول عن محتواه ومطابقته لقواعد كل منصة.</p>
<div class="en"><h1>Terms of Service</h1><p>Last updated: ${UPDATED}</p><p>This tool is private to the «سر الموبايل» (Ser El Mobile) channel and is not offered to other users. The channel owner reviews and approves each video before it is published, and is responsible for its content and for following each platform's rules, including TikTok's Community Guidelines and Terms of Service.</p></div>`),
};

const norm = (t) => (t || '').trim().replace(/[إأآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').toLowerCase();

async function videosMenu(env) {
  const list = JSON.parse((await env.BOT.get('videos')) || '[]');
  if (!list.length) return say(env, 'مفيش فيديوهات جاهزة دلوقتي — أول ما الشورتس الجاية تجهز هتلاقيها هنا.');
  const rows = list.slice(0, 12).map((v, i) => [{ text: `${v.icon || '🎬'} ${v.title}`.slice(0, 60), callback_data: `v:${i}` }]);
  rows.push([{ text: '📦 ابعتلي الكل', callback_data: 'v:all' }]);
  const lines = list.slice(0, 12).map((v) => `${v.icon || '🎬'} ${v.title}\n     ${v.status}`);
  return say(env, `🎬 الفيديوهات (${list.length}):\n\n${lines.join('\n')}\n\nاختار اللي عايز تشوفه 👇`, { reply_markup: { inline_keyboard: rows } });
}

/** Starts the GitHub "bot" workflow (fresh report, or fetching videos the bot has no copy of yet). */
async function dispatch(env, inputs = {}, workflow = 'bot.yml') {
  if (!env.GH_TOKEN) return false;
  const r = await fetch(`https://api.github.com/repos/ahmedmatwe/serelbrand-studio/actions/workflows/${workflow}/dispatches`, {
    method: 'POST', headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'ser-mobile-bot', 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'main', inputs }),
  }).catch(() => undefined);
  return Boolean(r && r.status === 204);
}

/**
 * «🔧 إصلاح» buttons under a problem: each problem type has one safe, known fix that runs on GitHub; the
 * workflow tells the owner the result when it ends (its `fix` input).
 */
const FIXES = {
  produce: { label: 'إنتاج فيديوهات النهارده', workflow: 'autopilot.yml', inputs: { force: 'true' } },
  library: { label: 'تجهيز مواضيع جديدة للمكتبة', workflow: 'autopilot.yml', inputs: { library_only: 'true' } },
  social: { label: 'النشر على فيسبوك وإنستجرام', workflow: 'social.yml', inputs: {} },
  motion: { label: 'فحص الموشن وتجربة رندر', workflow: 'motion-check.yml', inputs: {} },
  cycle: { label: 'دورة كاملة (بتعيد جدولة اللي فشل)', workflow: 'autopilot.yml', inputs: {} },
};
async function runFix(env, action) {
  const [kind, arg] = action.split(':');
  if (kind === 'rerun' && /^\d+$/.test(arg || '')) {
    const r = env.GH_TOKEN ? await fetch(`https://api.github.com/repos/ahmedmatwe/serelbrand-studio/actions/runs/${arg}/rerun-failed-jobs`, {
      method: 'POST', headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'ser-mobile-bot' },
    }).catch(() => undefined) : undefined;
    return r && r.status === 201 ? '🔧 بدأت أعيد التشغيل اللي فشل — لو فشل تاني المراقب هيبلّغك.' : '❌ مقدرتش أعيد التشغيل ده (يمكن قديم أو اتعاد قبل كده).';
  }
  const f = FIXES[kind];
  if (!f) return '❌ الإصلاح ده مش معروف.';
  const ok = await dispatch(env, { ...f.inputs, fix: f.label }, f.workflow);
  return ok ? `🔧 بدأت الإصلاح: ${f.label}
هبعتلك النتيجة أول ما يخلص (غالباً خلال دقايق).` : '❌ مقدرتش أبدأ الإصلاح دلوقتي — جرّب تاني بعد شوية.';
}

async function sendVideos(env, which) {
  const list = JSON.parse((await env.BOT.get('videos')) || '[]');
  const chosen = which === 'all' ? list : [list[Number(which)]].filter(Boolean);
  const fetchLater = [];
  for (const v of chosen) {
    const caption = `${v.icon || '🎬'} ${v.title}\n${v.status}`;
    const r = v.file_id ? await tg(env, 'sendVideo', { chat_id: env.CHAT_ID, video: v.file_id, caption, supports_streaming: true }) : { ok: false };
    if (r.ok) continue;
    if (v.asset) fetchLater.push(v.asset);
    else await say(env, `${caption}\n(الفيديو ده مش متاح للإرسال)`);
  }
  if (fetchLater.length) {
    const ok = await dispatch(env, { videos: fetchLater.join(',') });
    await say(env, ok ? `⏳ بجيبلك ${fetchLater.length === 1 ? 'الفيديو' : `${fetchLater.length} فيديوهات`} — هيوصل خلال دقيقة أو اتنين.` : 'الفيديو ده محتاج يتجاب من GitHub والربط لسه مش متفعّل.');
  }
}

/**
 * The channel's clock. GitHub's own schedule drops most runs on a busy day (9 Nov: 2 of 8 autopilot runs,
 * 1 of 17 social runs → a Short reached Facebook 5 h late), Cloudflare's cron fires on time. The free plan allows
 * only 5 crons per account (shared with other bots), so ONE hourly cron decides what to start:
 * autopilot every 3 hours, Facebook/Instagram posting every hour 05–21 UTC (07:00–23:00 Cairo).
 */
export function dueWorkflows(date) {
  const h = date.getUTCHours();
  return [...(h % 3 === 0 ? ['autopilot.yml'] : []), ...(h >= 5 && h <= 21 ? ['social.yml'] : [])];
}

export default {
  async scheduled(event, env) {
    for (const wf of dueWorkflows(new Date(event.scheduledTime))) await dispatch(env, {}, wf);
  },

  async fetch(req, env) {
    const url = new URL(req.url);
    // --- Short-lived public video links (Buffer fetches the TikTok video from here at posting time) -------
    const media = url.pathname.match(/^\/media\/([\w.-]{1,120}\.mp4)$/);
    if (media) {
      if (req.method === 'PUT') {
        if (req.headers.get('authorization') !== `Bearer ${env.INGEST_SECRET}`) return new Response('forbidden', { status: 403 });
        const buf = await req.arrayBuffer();
        if (buf.byteLength > 25 * 1024 * 1024) return new Response('too large', { status: 413 });
        await env.BOT.put(`media:${media[1]}`, buf, { expirationTtl: 60 * 60 * 24 * 10 });
        return json({ ok: true, url: `${url.origin}/media/${media[1]}` });
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const v = await env.BOT.get(`media:${media[1]}`, 'arrayBuffer');
        if (!v) return new Response('not found', { status: 404 });
        return new Response(req.method === 'HEAD' ? null : v, { headers: { 'content-type': 'video/mp4', 'content-length': String(v.byteLength), 'cache-control': 'public, max-age=86400' } });
      }
    }
    if (url.pathname === '/vetoes' && req.method === 'GET') {
      if (req.headers.get('authorization') !== `Bearer ${env.INGEST_SECRET}`) return new Response('forbidden', { status: 403 });
      return json({ vetoes: JSON.parse((await env.BOT.get('vetoes')) || '[]') });
    }
    if (url.pathname === '/requests' && req.method === 'GET') {
      if (req.headers.get('authorization') !== `Bearer ${env.INGEST_SECRET}`) return new Response('forbidden', { status: 403 });
      return json({ requests: JSON.parse((await env.BOT.get('requests')) || '[]') });
    }
    // Public pages TikTok for Developers asks for (website, privacy policy, terms) + its site-verification file.
    if (req.method === 'GET' && PAGES[url.pathname]) return new Response(PAGES[url.pathname], { headers: { 'content-type': 'text/html; charset=utf-8' } });
    const verify = url.pathname.match(/^\/(tiktok[\w-]{1,80}\.txt)$/);
    if (req.method === 'GET' && verify) {
      const v = await env.BOT.get(`ttverify:${verify[1]}`);
      return v ? new Response(v, { headers: { 'content-type': 'text/plain' } }) : new Response('not found', { status: 404 });
    }
    const tt = await handleTikTok(req, env, url);
    if (tt) return tt;
    if (req.method !== 'POST') return new Response('ok');

    // --- Telegram webhook -------------------------------------------------------------------------
    if (url.pathname === '/telegram') {
      if (req.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      const u = await req.json();
      const chat = String(u.message?.chat?.id ?? u.callback_query?.message?.chat?.id ?? '');
      if (chat !== String(env.CHAT_ID)) return json({ ok: true }); // only the owner
      if (u.callback_query) {
        await tg(env, 'answerCallbackQuery', { callback_query_id: u.callback_query.id, text: 'ثواني وهيوصلك…' });
        const d = u.callback_query.data || '';
        if (d.startsWith('v:')) await sendVideos(env, d.slice(2));
        if (d.startsWith('f:')) {
          // the pressed fix button disappears (no double runs), then the fix starts
          const m = u.callback_query.message;
          const kb = (m?.reply_markup?.inline_keyboard || []).filter((row) => !row.some((b) => b.callback_data === d));
          if (m) await tg(env, 'editMessageReplyMarkup', { chat_id: env.CHAT_ID, message_id: m.message_id, reply_markup: { inline_keyboard: kb } });
          await say(env, await runFix(env, d.slice(2)));
        }
        // «🗑️ شيل»: the library agent drops this topic before it is ever produced.
        if (d.startsWith('x:')) {
          const id = d.slice(2, 64);
          const list = JSON.parse((await env.BOT.get('vetoes')) || '[]');
          if (!list.includes(id)) { list.push(id); await env.BOT.put('vetoes', JSON.stringify(list.slice(-200))); }
          const m = u.callback_query.message;
          const kb = (m?.reply_markup?.inline_keyboard || []).filter((row) => !row.some((b) => b.callback_data === d));
          if (m) await tg(env, 'editMessageReplyMarkup', { chat_id: env.CHAT_ID, message_id: m.message_id, reply_markup: { inline_keyboard: kb } });
          await say(env, '🗑️ تمام، الموضوع ده اتشال ومش هيتعمل.');
        }
        return json({ ok: true });
      }
      const t = norm(u.message?.text);
      const topic = (u.message?.text || '').trim().match(/^(?:\/topic|موضوع|فكر[ةه]|اعمل(?:لي)? فيديو عن|ع[اa]?[وي]ز فيديو عن|عايز فيديو عن|عاوز فيديو عن)\s*[:：-]?\s*([\s\S]{3,400})$/i);
      if (topic) {
        const list = JSON.parse((await env.BOT.get('requests')) || '[]');
        if (list.length >= 10) { await say(env, 'عندي 10 مواضيع مستنية مراجعة — استنى لما أخلّصهم وابعت تاني 🙏'); return json({ ok: true }); }
        list.push({ id: String(Date.now()), text: topic[1].trim(), at: new Date().toISOString() });
        await env.BOT.put('requests', JSON.stringify(list));
        // Wake the autopilot now so the topic is researched + fact-checked within minutes.
        const woke = await dispatch(env, {}, 'autopilot.yml');
        await say(env, `📝 استلمت الموضوع:\n«${topic[1].trim().slice(0, 200)}»\n\n🔎 ${woke ? 'بتأكد من المعلومة دلوقتي وهرد عليك خلال دقايق' : 'هتأكد من المعلومة في الدورة الجاية وهرد عليك'} — لو صح هيتعمل أول فيديو في الإنتاج الجاي.`);
        return json({ ok: true });
      }
      if (/تقرير|احصا|مشاهد|متابع|لايك|report|stats/.test(t)) {
        const rep = await env.BOT.get('report');
        const at = await env.BOT.get('report_at');
        // Ask GitHub (where the platform keys live) for fresh numbers now; they arrive in about a minute.
        const fresh = await dispatch(env, { report: 'true' });
        const tail = fresh ? '\n\n⏳ بجيبلك أحدث الأرقام دلوقتي — هتوصلك خلال دقيقة.' : '';
        await say(env, rep ? `${rep}${at ? `\n\n🕐 آخر تحديث: ${at}` : ''}${tail}` : (fresh ? '⏳ بجهزلك التقرير — هيوصلك خلال دقيقة.' : 'التقرير بيتجهز — هيوصلك قريب.'));
      } else if (/فيديو|فديو|فيديوهات|مجدول|video/.test(t)) {
        await videosMenu(env);
      } else {
        await say(env, HELP);
      }
      return json({ ok: true });
    }

    // --- Self-registration of the Telegram webhook (retried hourly until Telegram can reach us) ---------
    if (url.pathname === '/setup') {
      if (req.headers.get('authorization') !== `Bearer ${env.INGEST_SECRET}`) return new Response('forbidden', { status: 403 });
      // ?force=1 (from the setup script) re-registers even if linked before, e.g. after the secrets changed.
      if (!url.searchParams.has('force') && await env.BOT.get('webhook_ok')) return json({ ok: true, already: true });
      const r = await tg(env, 'setWebhook', { url: `${url.origin}/telegram`, secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'] });
      if (r.ok) { await env.BOT.put('webhook_ok', '1'); await say(env, HELP); }
      return json(r);
    }

    // --- Autopilot → bot ------------------------------------------------------------------------------
    if (url.pathname === '/ingest') {
      if (req.headers.get('authorization') !== `Bearer ${env.INGEST_SECRET}`) return new Response('forbidden', { status: 403 });
      const b = await req.json();
      if (b.report) { await env.BOT.put('report', b.report); await env.BOT.put('report_at', b.reportAt || ''); }
      if (Array.isArray(b.videos)) await env.BOT.put('videos', JSON.stringify(b.videos));
      for (const a of b.alerts || []) {
        // Each alert once only (the autopilot may resend it every hour); a fix button under it when there is one.
        if (await env.BOT.get(`alert:${a.id}`)) continue;
        await env.BOT.put(`alert:${a.id}`, '1', { expirationTtl: 60 * 60 * 24 * 30 });
        await say(env, a.text, a.fix ? { reply_markup: { inline_keyboard: [[{ text: '🔧 إصلاح', callback_data: `f:${a.fix}`.slice(0, 64) }]] } } : {});
      }
      if (Array.isArray(b.requestsDone) && b.requestsDone.length) {
        const list = JSON.parse((await env.BOT.get('requests')) || '[]');
        await env.BOT.put('requests', JSON.stringify(list.filter((r) => !b.requestsDone.includes(r.id))));
      }
      // TikTok site verification file (name + content from TikTok for Developers → URL properties)
      if (b.ttVerify && /^tiktok[\w-]{1,80}\.txt$/.test(b.ttVerify.name || '')) await env.BOT.put(`ttverify:${b.ttVerify.name}`, String(b.ttVerify.content || '').slice(0, 500));
      if (Array.isArray(b.vetoesDone) && b.vetoesDone.length) {
        const list = JSON.parse((await env.BOT.get('vetoes')) || '[]');
        await env.BOT.put('vetoes', JSON.stringify(list.filter((id) => !b.vetoesDone.includes(id))));
      }
      // TikTok direct post: an approval link for one video (the owner taps «Post» on TikTok's required page)
      if (b.ttApprove?.file) {
        const link = await newApproval(env, url.origin, b.ttApprove);
        if (b.ttApprove.notify !== false) await say(env, `🎵 فيديو جاهز لتيك توك: ${b.ttApprove.title || ''}`.trim(), { reply_markup: { inline_keyboard: [[{ text: '✅ راجع وانشر', url: link }]] } });
        return json({ ok: true, link });
      }
      for (const m of b.messages || []) await say(env, m);
      // Messages with buttons: { text, buttons: [[{ text, data }]] }
      for (const m of b.rich || []) await say(env, m.text, { reply_markup: { inline_keyboard: (m.buttons || []).map((row) => row.map((x) => ({ text: String(x.text).slice(0, 60), callback_data: String(x.data).slice(0, 64) }))) } });
      return json({ ok: true });
    }
    return new Response('not found', { status: 404 });
  },
};
