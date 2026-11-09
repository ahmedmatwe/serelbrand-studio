/**
 * "سر الموبايل" Telegram assistant — Cloudflare Worker (free, always on, replies instantly).
 *
 *  /telegram  ← Telegram webhook: the owner writes "تقرير" (report), "فيديو" (scheduled videos as buttons → the
 *               chosen one or all arrive as playable videos), anything else → help. Only CHAT_ID is answered.
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
async function dispatch(env, inputs = {}) {
  if (!env.GH_TOKEN) return false;
  const r = await fetch('https://api.github.com/repos/ahmedmatwe/serelbrand-studio/actions/workflows/bot.yml/dispatches', {
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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
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
        return json({ ok: true });
      }
      const t = norm(u.message?.text);
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
      for (const m of b.messages || []) await say(env, m);
      return json({ ok: true });
    }
    return new Response('not found', { status: 404 });
  },
};
