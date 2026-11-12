// Uploads each given video to Instagram as a Reel container WITHOUT publishing it, and prints whether Instagram
// accepted it (status FINISHED) or not — to find which file format Instagram rejects. Nothing is posted.
const V = process.env.META_GRAPH_VERSION || 'v27.0', T = process.env.META_PAGE_TOKEN!, P = process.env.META_PAGE_ID!;
import { readFileSync } from 'node:fs';
const g = async (path: string, q: Record<string, string>, method = 'GET') => {
  const u = `https://graph.facebook.com/${V}/${path}`;
  const body = new URLSearchParams({ ...q, access_token: T });
  const r = method === 'GET' ? await fetch(`${u}?${body}`) : await fetch(u, { method, body });
  return (await r.json()) as any;
};
const ig = (await g(P, { fields: 'instagram_business_account' })).instagram_business_account?.id;
for (const file of process.argv.slice(2)) {
  const c = await g(`${ig}/media`, { media_type: 'REELS', upload_type: 'resumable', caption: 'test (not published)' }, 'POST');
  if (!c.id) { console.log('RESULT', file, 'container error', JSON.stringify(c.error)); continue; }
  const data = readFileSync(file);
  const up = await fetch(c.uri, { method: 'POST', headers: { authorization: `OAuth ${T}`, offset: '0', file_size: String(data.length), 'content-type': 'application/octet-stream' }, body: new Uint8Array(data) });
  const uj = await up.json().catch(() => ({}));
  let st: any = {};
  for (let i = 0; i < 30; i++) { st = await g(String(c.id), { fields: 'status_code,status' }); if (['FINISHED', 'ERROR', 'EXPIRED'].includes(st.status_code)) break; await new Promise((r) => setTimeout(r, 10_000)); }
  console.log('RESULT', file.split('/').pop(), 'upload', up.status, JSON.stringify(uj).slice(0, 200), '→', st.status_code, st.status ?? '');
}
