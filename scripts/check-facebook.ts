// Diagnoses Facebook Reels reach: page audience, token permissions, and per-Reel status/privacy/plays (no secrets printed).
const V = process.env.META_GRAPH_VERSION || 'v27.0', T = process.env.META_PAGE_TOKEN!, P = process.env.META_PAGE_ID!;
const g = async (path: string, q: Record<string, string> = {}) => {
  const r = await fetch(`https://graph.facebook.com/${V}/${path}?${new URLSearchParams({ ...q, access_token: T })}`);
  const j = (await r.json().catch(() => ({}))) as any;
  return j.error ? { error: `${j.error.code}/${j.error.error_subcode ?? ''} ${j.error.message}` } : j;
};
const page = await g(P, { fields: 'name,fan_count,followers_count,is_published,verification_status,category' });
console.log('PAGE', JSON.stringify({ ...page, id: undefined }));
const perms = await g('me/permissions');
console.log('PERMS', perms.error ?? (perms.data ?? []).filter((p: any) => p.status === 'granted').map((p: any) => p.permission).join(','));
const debug = await g('debug_token', { input_token: T });
console.log('TOKEN', JSON.stringify({ type: debug.data?.type, scopes: debug.data?.scopes, expires: debug.data?.expires_at, valid: debug.data?.is_valid, error: debug.error }));
const reels = await g(`${P}/video_reels`, { fields: 'id,created_time,status,privacy,permalink_url,length,views', limit: '8' });
if (reels.error) console.log('REELS', reels.error);
for (const v of reels.data ?? []) {
  const ins = await g(`${v.id}/video_insights`, { metric: 'blue_reels_play_count,fb_reels_total_plays,post_impressions_unique,post_video_avg_time_watched' });
  const m = Object.fromEntries((ins.data ?? []).map((d: any) => [d.name, d.values?.[0]?.value]));
  console.log('REEL', v.created_time?.slice(0, 16), JSON.stringify({ status: v.status?.video_status, publish: v.status?.publishing_phase?.status, privacy: v.privacy?.value, views: v.views, length: v.length, ...m, insightsError: ins.error }));
}
