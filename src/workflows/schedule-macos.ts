/**
 * macOS launchd agent that runs one autopilot cycle every 2 hours (free, built into macOS).
 * The Mac must be awake; missed runs simply happen at the next interval.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

export const LABEL = 'com.serelbrand.autopilot';
export const plistPath = () => resolve(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildPlist(o: { node: string; root: string; intervalSec: number }): string {
  const log = resolve(o.root, 'data/logs/autopilot.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(o.node)}</string><string>--no-warnings</string>
    <string>${xml(resolve(o.root, 'src/cli/index.ts'))}</string><string>autopilot</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(o.root)}</string>
  <key>StartInterval</key><integer>${o.intervalSec}</integer>
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(dirname(o.node))}:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
}

const uid = () => String(process.getuid?.() ?? 501);

export function installSchedule(root: string, intervalSec = 7200) {
  mkdirSync(resolve(root, 'data/logs'), { recursive: true });
  mkdirSync(dirname(plistPath()), { recursive: true });
  if (existsSync(plistPath())) removeSchedule();
  writeFileSync(plistPath(), buildPlist({ node: process.execPath, root, intervalSec }));
  execFileSync('launchctl', ['bootstrap', `gui/${uid()}`, plistPath()]);
  return plistPath();
}

export function removeSchedule() {
  try { execFileSync('launchctl', ['bootout', `gui/${uid()}/${LABEL}`], { stdio: 'ignore' }); } catch { /* not loaded */ }
  rmSync(plistPath(), { force: true });
}

export function scheduleStatus(): { installed: boolean; loaded: boolean; lastExit?: string } {
  const installed = existsSync(plistPath());
  try {
    const out = execFileSync('launchctl', ['print', `gui/${uid()}/${LABEL}`], { encoding: 'utf8' });
    return { installed, loaded: true, lastExit: out.match(/last exit code = (.+)/)?.[1]?.trim() };
  } catch {
    return { installed, loaded: false };
  }
}

/** Runs the agent once right now (for testing the schedule). */
export function kickSchedule() {
  execFileSync('launchctl', ['kickstart', `gui/${uid()}/${LABEL}`]);
}
