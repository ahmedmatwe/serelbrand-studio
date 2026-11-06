import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { ProviderError } from '../../core/errors.ts';
import type { TTSProvider, TTSResult } from '../media.ts';

const run = promisify(execFile);

/**
 * Free, offline Arabic TTS using the macOS built-in `say` command (voice "Majed").
 * Quality is acceptable for drafts/tests; a premium voice can replace it later behind the same interface.
 * Text goes through a temp file (never through a shell), so no injection is possible.
 */
export class MacSayTTS implements TTSProvider {
  readonly name = 'macos-say';
  private readonly voice: string;
  constructor(voice = 'Majed') { this.voice = voice; }

  static async available(voice = 'Majed'): Promise<boolean> {
    if (process.platform !== 'darwin') return false;
    try {
      const { stdout } = await run('say', ['-v', '?']);
      return stdout.split('\n').some((l) => l.startsWith(voice + ' '));
    } catch {
      return false;
    }
  }

  async synthesize(text: string, outPath: string): Promise<TTSResult> {
    if (process.platform !== 'darwin') throw new ProviderError('macos-say', 'macOS `say` is only available on macOS', false);
    const path = outPath.endsWith('.aiff') ? outPath : outPath.replace(/\.[^.]+$/, '') + '.aiff';
    mkdirSync(dirname(path), { recursive: true });
    const txt = path + '.txt';
    writeFileSync(txt, text, 'utf8');
    try {
      await run('say', ['-v', this.voice, '-r', '165', '-o', path, '-f', txt], { timeout: 600_000 });
      const { stdout } = await run('afinfo', [path]);
      const m = stdout.match(/estimated duration:\s*([\d.]+)/);
      return { audioPath: path, durationSec: m ? Number(m[1]) : 0, characters: text.length, voice: this.voice };
    } catch (err) {
      throw new ProviderError('macos-say', `say failed: ${(err as Error).message}`, false, { cause: err });
    } finally {
      rmSync(txt, { force: true });
    }
  }
}
