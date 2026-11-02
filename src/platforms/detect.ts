import { existsSync, statfsSync } from 'node:fs';
import { cpus, totalmem, freemem, platform, arch, release, homedir, hostname, networkInterfaces } from 'node:os';
import { join, delimiter } from 'node:path';
import { runProcess } from '../utils/process.js';

export interface HostInfo {
  platform: NodeJS.Platform;
  arch: string;
  release: string;
  hostname: string;
  cpuCores: number;
  cpuModel: string | undefined;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  networkInterfaces: Array<{ name: string; addresses: string[] }>;
}

export function getHostInfo(): HostInfo {
  const c = cpus();
  return {
    platform: platform(),
    arch: arch(),
    release: release(),
    hostname: hostname(),
    cpuCores: c.length,
    cpuModel: c[0]?.model,
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    networkInterfaces: Object.entries(networkInterfaces()).map(([name, addrs]) => ({
      name,
      addresses: (addrs ?? []).map((a) => `${a.address}/${a.family}`),
    })),
  };
}

export function getDiskSpace(path: string): { path: string; totalBytes: number; freeBytes: number } | undefined {
  try {
    const s = statfsSync(path);
    return { path, totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
  } catch {
    return undefined;
  }
}

/** Candidate VBoxManage locations, most specific first. Callers may also pass a manual override. */
export function vboxManageCandidates(env: NodeJS.ProcessEnv = process.env, plat: NodeJS.Platform = platform()): string[] {
  const exe = plat === 'win32' ? 'VBoxManage.exe' : 'VBoxManage';
  const out: string[] = [];
  if (env.VBOX_MSI_INSTALL_PATH) out.push(join(env.VBOX_MSI_INSTALL_PATH, exe));
  if (env.VBOX_INSTALL_PATH) out.push(join(env.VBOX_INSTALL_PATH, exe));
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) out.push(join(dir, exe));
  if (plat === 'win32') {
    for (const pf of [env.ProgramFiles, env['ProgramFiles(x86)'], 'C:\\Program Files']) {
      if (pf) out.push(join(pf, 'Oracle', 'VirtualBox', exe));
    }
  } else if (plat === 'darwin') {
    out.push('/Applications/VirtualBox.app/Contents/MacOS/VBoxManage', '/usr/local/bin/VBoxManage', '/opt/homebrew/bin/VBoxManage');
  } else {
    out.push('/usr/bin/VBoxManage', '/usr/local/bin/VBoxManage', '/usr/lib/virtualbox/VBoxManage', '/opt/VirtualBox/VBoxManage');
  }
  return [...new Set(out)];
}

export interface VBoxInstallation {
  found: boolean;
  executablePath?: string;
  version?: string;
  major?: number;
  minor?: number;
  build?: string;
  candidatesChecked: string[];
}

export function parseVBoxVersion(raw: string): { version: string; major: number; minor: number; build?: string } | undefined {
  const m = raw.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[_A-Za-z0-9]*)?(?:r(\d+))?/);
  if (!m) return undefined;
  return { version: `${m[1]}.${m[2]}.${m[3]}`, major: Number(m[1]), minor: Number(m[2]), build: m[4] };
}

export async function detectVBoxManage(override = 'auto', env: NodeJS.ProcessEnv = process.env): Promise<VBoxInstallation> {
  const candidates = override && override !== 'auto' ? [override] : vboxManageCandidates(env);
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    try {
      const r = await runProcess(c, ['--version'], { timeoutMs: 15000 });
      const v = parseVBoxVersion(r.stdout);
      if (r.exitCode === 0 && v) return { found: true, executablePath: c, ...v, candidatesChecked: candidates };
    } catch {
      // try next candidate
    }
  }
  return { found: false, candidatesChecked: candidates };
}

export const MIN_SUPPORTED_MAJOR = 6;

export function defaultVmDirectoryGuess(): string {
  return join(homedir(), 'VirtualBox VMs');
}
