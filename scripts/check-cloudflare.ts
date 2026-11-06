/** Verifies the Cloudflare secrets by generating one small image (never prints the token). */
import { CloudflareImage } from '../src/providers/image/cloudflare.ts';
const id = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
console.log(`account id: ${id.length} chars, ${/^[0-9a-f]{32}$/.test(id) ? 'looks valid' : 'UNEXPECTED FORMAT (should be 32 hex chars)'}`);
const img = new CloudflareImage({ accountId: id, token: process.env.CLOUDFLARE_API_TOKEN ?? '' });
const a = await img.generate('a small old garage workshop at dawn, cinematic', 'preview/cloudflare-test.jpg');
console.log('OK — image generated:', a.path);
