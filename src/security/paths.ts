import { resolve, relative, isAbsolute, sep } from 'node:path';
import { realpathSync, existsSync } from 'node:fs';
import { VBoxMcpError } from '../core/errors.js';

function canonical(p: string): string {
  const abs = resolve(p);
  try {
    return existsSync(abs) ? realpathSync(abs) : abs;
  } catch {
    return abs;
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Resolves a host path and ensures it lies inside one of the configured staging directories.
 * Symlinks are resolved for existing paths; for new paths the nearest existing parent is checked.
 */
export function assertHostPathAllowed(path: string, stagingDirs: readonly string[]): string {
  if (stagingDirs.length === 0) {
    throw new VBoxMcpError(
      'PERMISSION_DENIED',
      'Host file access is disabled: no staging directories are configured (files.stagingDirectories / VBOX_MCP_STAGING_DIRS).',
    );
  }
  if (path.includes('\0')) throw new VBoxMcpError('INVALID_ARGUMENT', 'Path contains a NUL byte.');
  const abs = resolve(path);
  // Resolve symlinks of the nearest existing ancestor.
  let probe = abs;
  let suffix = '';
  while (!existsSync(probe)) {
    const parent = resolve(probe, '..');
    if (parent === probe) break;
    suffix = suffix ? `${probe.slice(parent.length + 1)}${sep}${suffix}` : probe.slice(parent.length + 1);
    probe = parent;
  }
  const real = suffix ? resolve(canonical(probe), suffix) : canonical(abs);
  const roots = stagingDirs.map(canonical);
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
  const norm = (s: string) => (caseInsensitive ? s.toLowerCase() : s);
  if (!roots.some((r) => isInside(norm(real), norm(r)))) {
    throw new VBoxMcpError('PERMISSION_DENIED', `Host path is outside the configured staging directories: ${path}`);
  }
  return real;
}

export type GuestOs = 'linux' | 'windows';

/** Validates a guest path: absolute, no NUL, no traversal segments. Returns the normalised path. */
export function normalizeGuestPath(path: string, os: GuestOs): string {
  if (!path || path.includes('\0')) throw new VBoxMcpError('INVALID_ARGUMENT', 'Guest path is empty or contains a NUL byte.');
  if (os === 'windows') {
    const p = path.replace(/\//g, '\\');
    if (!/^[a-zA-Z]:\\/.test(p) && !p.startsWith('\\\\')) {
      throw new VBoxMcpError('INVALID_ARGUMENT', `Windows guest path must be absolute (e.g. C:\\Users\\...): ${path}`);
    }
    if (p.split('\\').some((seg) => seg === '..')) throw new VBoxMcpError('INVALID_ARGUMENT', `Path traversal is not permitted: ${path}`);
    return p;
  }
  if (!path.startsWith('/')) throw new VBoxMcpError('INVALID_ARGUMENT', `Linux guest path must be absolute: ${path}`);
  if (path.split('/').some((seg) => seg === '..')) throw new VBoxMcpError('INVALID_ARGUMENT', `Path traversal is not permitted: ${path}`);
  return path.replace(/\/{2,}/g, '/');
}

const CRITICAL_LINUX = ['/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib64', '/opt', '/proc', '/root', '/sbin', '/srv', '/sys', '/usr', '/var', '/var/lib'];
const CRITICAL_WINDOWS = ['c:\\', 'c:\\windows', 'c:\\windows\\system32', 'c:\\program files', 'c:\\program files (x86)', 'c:\\users', 'c:\\programdata'];

/** True when deleting/overwriting this guest path should be treated as destructive. */
export function isProtectedGuestPath(path: string, os: GuestOs, extra: readonly string[] = []): boolean {
  if (os === 'windows') {
    const p = path.toLowerCase().replace(/\\+$/, '') || path.toLowerCase();
    const withSlash = /^[a-z]:$/.test(p) ? `${p}\\` : p;
    return [...CRITICAL_WINDOWS, ...extra.map((e) => e.toLowerCase())].some((c) => c.replace(/\\+$/, '') === withSlash.replace(/\\+$/, '') || withSlash === c);
  }
  const p = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return [...CRITICAL_LINUX, ...extra].includes(p) || /^\/home\/[^/]+$/.test(p);
}
