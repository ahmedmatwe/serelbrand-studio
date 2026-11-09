/**
 * Telegram reporting bot: the owner gets every finished Short as a playable video (with its title, status and
 * publishing times) the moment it is ready, plus every important notification. Free (Telegram Bot API).
 * Off when TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set.
 */
import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';

export class Telegram {
  private readonly o: { token: string; chatId: string; fetchImpl?: typeof fetch };
  constructor(o: Telegram['o']) { this.o = o; }
  private get f() { return this.o.fetchImpl ?? fetch; }
  private url(method: string) { return `https://api.telegram.org/bot${this.o.token}/${method}`; }

  async send(text: string): Promise<void> {
    // Telegram limit: 4096 chars per message.
    for (let i = 0; i < text.length; i += 4000) {
      const res = await this.f(this.url('sendMessage'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: this.o.chatId, text: text.slice(i, i + 4000), disable_web_page_preview: true }) });
      if (!res.ok) throw new Error(`Telegram sendMessage: HTTP ${res.status}`);
    }
  }

  /** Sends a video file (≤ 50 MB for bots) that plays inline in the chat. */
  async video(path: string, caption: string): Promise<void> {
    if (!existsSync(path)) return this.send(`${caption}\n(الفيديو مش موجود: ${basename(path)})`);
    const form = new FormData();
    form.append('chat_id', this.o.chatId);
    form.append('caption', caption.slice(0, 1000));
    form.append('supports_streaming', 'true');
    form.append('video', new Blob([new Uint8Array(readFileSync(path))], { type: 'video/mp4' }), basename(path));
    const res = await this.f(this.url('sendVideo'), { method: 'POST', body: form });
    if (!res.ok) throw new Error(`Telegram sendVideo: HTTP ${res.status}`);
  }
}

export function telegramFromEnv(): Telegram | undefined {
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  return token && chatId ? new Telegram({ token, chatId }) : undefined;
}

/** "2026-11-09T15:00:00.000Z" → "اليوم 5:00 م" (Cairo). */
export function cairoTime(iso: string | undefined, now = new Date()): string {
  if (!iso) return 'دلوقتي';
  const d = new Date(new Date(iso).getTime() + 2 * 3_600_000);
  const n = new Date(now.getTime() + 2 * 3_600_000);
  const day = d.toISOString().slice(0, 10) === n.toISOString().slice(0, 10) ? 'النهارده' : d.toISOString().slice(0, 10) === new Date(n.getTime() + 86_400_000).toISOString().slice(0, 10) ? 'بكرة' : d.toISOString().slice(5, 10);
  const h = d.getUTCHours(), m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day} ${((h + 11) % 12) + 1}:${m} ${h < 12 ? 'ص' : 'م'}`;
}
