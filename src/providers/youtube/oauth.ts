/**
 * Google OAuth 2.0 for an installed (desktop) app: loopback redirect + PKCE.
 * The user signs in and consents on Google's own page in their browser; we never see their password.
 * Tokens are stored locally in data/secrets/youtube.json with 0600 permissions.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import { ProviderError, StudioError } from '../../core/errors.ts';

export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.force-ssl', // thumbnails + captions
  'https://www.googleapis.com/auth/yt-analytics.readonly',
];

export interface ClientCredentials { clientId: string; clientSecret: string }
export interface StoredYouTubeAuth extends ClientCredentials { refreshToken: string; channelId?: string; channelTitle?: string; savedAt: string }

/** Reads the "Desktop app" client JSON downloaded from Google Cloud ({ installed: { client_id, client_secret } }). */
export function readClientJson(path: string): ClientCredentials {
  let j: { installed?: { client_id?: string; client_secret?: string }; web?: unknown };
  try {
    j = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new StudioError('OAUTH_CLIENT', `Cannot read client JSON: ${(err as Error).message}`);
  }
  if (!j.installed) throw new StudioError('OAUTH_CLIENT', j.web ? 'This is a "Web application" client — create a "Desktop app" client instead' : 'Not a Google OAuth client JSON');
  const { client_id, client_secret } = j.installed;
  if (!client_id || !client_secret) throw new StudioError('OAUTH_CLIENT', 'client_id / client_secret missing in client JSON');
  return { clientId: client_id, clientSecret: client_secret };
}

export function saveAuth(path: string, a: StoredYouTubeAuth) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(a, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function loadAuth(path: string): StoredYouTubeAuth | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as StoredYouTubeAuth;
}

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function pkcePair() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export function authUrl(o: { clientId: string; redirectUri: string; challenge: string; state: string; loginHint?: string }) {
  const q = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: 'code',
    scope: YOUTUBE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent', // always return a refresh token
    code_challenge: o.challenge,
    code_challenge_method: 'S256',
    state: o.state,
  });
  if (o.loginHint) q.set('login_hint', o.loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export async function exchangeCode(o: ClientCredentials & { code: string; verifier: string; redirectUri: string; fetchImpl?: typeof fetch }) {
  const res = await (o.fetchImpl ?? fetch)('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: o.code, client_id: o.clientId, client_secret: o.clientSecret, redirect_uri: o.redirectUri, grant_type: 'authorization_code', code_verifier: o.verifier }),
  });
  const j = (await res.json().catch(() => ({}))) as { refresh_token?: string; access_token?: string; error?: string; error_description?: string; scope?: string };
  if (!res.ok || !j.refresh_token) throw new ProviderError('youtube-oauth', `Token exchange failed: ${j.error ?? res.status} ${j.error_description ?? ''}`.trim(), false);
  const granted = (j.scope ?? '').split(' ');
  const missing = YOUTUBE_SCOPES.filter((s) => !granted.includes(s));
  return { refreshToken: j.refresh_token, accessToken: j.access_token!, missingScopes: missing };
}

/**
 * Runs the loopback flow: starts a one-shot server on 127.0.0.1, prints/opens the consent URL,
 * waits for Google to redirect back with ?code=…&state=…, then exchanges the code.
 */
export async function runLoopbackFlow(o: ClientCredentials & { open: (url: string) => void; timeoutMs?: number; fetchImpl?: typeof fetch }) {
  const { verifier, challenge } = pkcePair();
  const state = b64url(randomBytes(16));
  let resolveCode!: (c: string) => void;
  let rejectCode!: (e: Error) => void;
  const got = new Promise<string>((res, rej) => { resolveCode = res; rejectCode = rej; });

  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
    const done = (ok: boolean, msg: string) => {
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html dir="rtl"><body style="font-family:system-ui;padding:40px"><h2>${ok ? '✅ تم ربط YouTube' : '❌ لم يتم الربط'}</h2><p>${msg}</p><p>تقدر تقفل الصفحة دي وترجع للتطبيق.</p></body></html>`);
    };
    if (u.searchParams.get('state') !== state) { done(false, 'state mismatch'); rejectCode(new StudioError('OAUTH_STATE', 'OAuth state mismatch — possible CSRF, aborted')); return; }
    const err = u.searchParams.get('error');
    if (err) { done(false, err); rejectCode(new StudioError('OAUTH_DENIED', `Google returned: ${err}`)); return; }
    const code = u.searchParams.get('code');
    if (!code) { done(false, 'no code'); rejectCode(new StudioError('OAUTH_NO_CODE', 'No authorization code')); return; }
    done(true, 'الموافقة وصلت للنظام.');
    resolveCode(code);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
  const timer = setTimeout(() => rejectCode(new StudioError('OAUTH_TIMEOUT', 'Timed out waiting for Google consent')), o.timeoutMs ?? 5 * 60_000);
  try {
    o.open(authUrl({ clientId: o.clientId, redirectUri, challenge, state }));
    const code = await got;
    return await exchangeCode({ ...o, code, verifier, redirectUri });
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

/** Access-token cache with refresh. */
export class TokenSource {
  private access?: { token: string; exp: number };
  private readonly a: ClientCredentials & { refreshToken: string };
  private readonly fetchImpl: typeof fetch;
  constructor(a: ClientCredentials & { refreshToken: string }, fetchImpl: typeof fetch = fetch) { this.a = a; this.fetchImpl = fetchImpl; }

  async token(): Promise<string> {
    if (this.access && Date.now() < this.access.exp - 60_000) return this.access.token;
    const res = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.a.clientId, client_secret: this.a.clientSecret, refresh_token: this.a.refreshToken, grant_type: 'refresh_token' }),
    });
    const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !j.access_token) {
      const hint = j.error === 'invalid_grant' ? ' — authorization expired/revoked: run "youtube:auth" again (in Testing mode Google expires it after 7 days)' : '';
      throw new ProviderError('youtube-oauth', `Token refresh failed: ${j.error ?? res.status}${hint}`, res.status >= 500);
    }
    this.access = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return j.access_token;
  }
}
