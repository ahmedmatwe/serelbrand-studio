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
        await env.BOT.put(`media:${media[1]}`, buf, { expirationTtl: 60 * 60 * 24 * 4 });
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
        // Each alert once only (the autopilot may resend it every hour).
        if (await env.BOT.get(`alert:${a.id}`)) continue;
        await env.BOT.put(`alert:${a.id}`, '1', { expirationTtl: 60 * 60 * 24 * 30 });
        await say(env, a.text);
      }
      if (Array.isArray(b.requestsDone) && b.requestsDone.length) {
        const list = JSON.parse((await env.BOT.get('requests')) || '[]');
        await env.BOT.put('requests', JSON.stringify(list.filter((r) => !b.requestsDone.includes(r.id))));
      }
      if (Array.isArray(b.vetoesDone) && b.vetoesDone.length) {
        const list = JSON.parse((await env.BOT.get('vetoes')) || '[]');
        await env.BOT.put('vetoes', JSON.stringify(list.filter((id) => !b.vetoesDone.includes(id))));
      }
      for (const m of b.messages || []) await say(env, m);
      // Messages with buttons: { text, buttons: [[{ text, data }]] }
      for (const m of b.rich || []) await say(env, m.text, { reply_markup: { inline_keyboard: (m.buttons || []).map((row) => row.map((x) => ({ text: String(x.text).slice(0, 60), callback_data: String(x.data).slice(0, 64) }))) } });
      return json({ ok: true });
    }
    return new Response('not found', { status: 404 });
  },
};
