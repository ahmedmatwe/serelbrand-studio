/**
 * Free web evidence for automatic fact-checking: fetch a page as plain text, search Wikipedia.
 * Uses a generic bot User-Agent (Wikipedia asks for one); never sends user data.
 */
import { ProviderError } from '../../core/errors.ts';

export interface WebPage { url: string; text: string; title?: string }
export interface WebProvider {
  readonly name: string;
  fetchText(url: string): Promise<WebPage>;
  wikipedia(query: string, lang?: 'en' | 'ar', limit?: number): Promise<WebPage[]>;
}

const UA = 'SerElBrandStudio/1.0 (automated fact-check; contact via channel)';
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_TEXT = 40_000;

/** Very small HTML → text: drops scripts/styles/nav, tags, entities; collapses whitespace. */
export function htmlToText(html: string): { text: string; title?: string } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  const text = html
    .replace(/<(head|script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t\r]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return { text: text.slice(0, MAX_TEXT), title };
}

export class RealWeb implements WebProvider {
  readonly name = 'web';
  private readonly fetchImpl: typeof fetch;
  constructor(fetchImpl: typeof fetch = fetch) { this.fetchImpl = fetchImpl; }

  async fetchText(url: string): Promise<WebPage> {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new ProviderError('web', 'Only https sources are used', false);
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname)) throw new ProviderError('web', 'Private address refused', false);
    const res = await this.fetchImpl(u, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain' }, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new ProviderError('web', `HTTP ${res.status} for ${u.hostname}`, res.status >= 500);
    const type = res.headers.get('content-type') ?? '';
    if (!/text\/html|text\/plain|xhtml/.test(type)) throw new ProviderError('web', `Unsupported content-type ${type.split(';')[0]}`, false);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new ProviderError('web', 'Page too large', false);
    const { text, title } = type.includes('html') ? htmlToText(buf.toString('utf8')) : { text: buf.toString('utf8').slice(0, MAX_TEXT), title: undefined };
    return { url: res.url || url, text, title };
  }

  async wikipedia(query: string, lang: 'en' | 'ar' = 'en', limit = 2): Promise<WebPage[]> {
    const api = `https://${lang}.wikipedia.org/w/api.php`;
    const s = await this.fetchImpl(`${api}?${new URLSearchParams({ action: 'query', list: 'search', srsearch: query, srlimit: String(limit), format: 'json', origin: '*' })}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20_000) });
    if (!s.ok) throw new ProviderError('web', `Wikipedia search HTTP ${s.status}`, s.status >= 500);
    const titles = (((await s.json()) as { query?: { search?: { title: string }[] } }).query?.search ?? []).map((x) => x.title);
    const pages: WebPage[] = [];
    for (const title of titles) {
      const r = await this.fetchImpl(`${api}?${new URLSearchParams({ action: 'query', prop: 'extracts', explaintext: '1', redirects: '1', titles: title, format: 'json', origin: '*' })}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20_000) });
      if (!r.ok) continue;
      const pg = Object.values(((await r.json()) as { query?: { pages?: Record<string, { extract?: string; title: string }> } }).query?.pages ?? {})[0];
      if (pg?.extract) pages.push({ url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(pg.title.replace(/ /g, '_'))}`, title: pg.title, text: pg.extract.slice(0, MAX_TEXT) });
    }
    return pages;
  }
}

/** Offline stand-in: no evidence anywhere (so nothing is ever auto-verified in dry-run). */
export class MockWeb implements WebProvider {
  readonly name = 'mock-web';
  async fetchText(url: string): Promise<WebPage> { return { url, text: '' }; }
  async wikipedia(): Promise<WebPage[]> { return []; }
}
