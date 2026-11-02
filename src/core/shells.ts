import type { ShellKind } from '../config/schema.js';
import type { GuestOsFamily } from '../backends/types.js';
import { VBoxMcpError } from './errors.js';

export interface ShellDefinition {
  kind: ShellKind;
  os: GuestOsFamily;
  /** Candidate absolute paths, probed in order during detection. */
  paths: string[];
  label: string;
}

export const SHELLS: Record<ShellKind, ShellDefinition> = {
  bash: { kind: 'bash', os: 'linux', paths: ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'], label: 'GNU Bash' },
  sh: { kind: 'sh', os: 'linux', paths: ['/bin/sh', '/usr/bin/sh'], label: 'POSIX sh' },
  powershell: {
    kind: 'powershell',
    os: 'windows',
    paths: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
    label: 'Windows PowerShell 5.1',
  },
  pwsh: { kind: 'pwsh', os: 'windows', paths: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe'], label: 'PowerShell 7' },
  cmd: { kind: 'cmd', os: 'windows', paths: ['C:\\Windows\\System32\\cmd.exe'], label: 'Command Prompt (cmd.exe)' },
};

export function shellsForOs(os: GuestOsFamily): ShellKind[] {
  return (Object.values(SHELLS) as ShellDefinition[]).filter((s) => s.os === os).map((s) => s.kind);
}

export function defaultShellFor(os: GuestOsFamily): ShellKind {
  return os === 'windows' ? 'powershell' : 'bash';
}

/** POSIX single-quote quoting: safe for any byte sequence except NUL. */
export function quotePosix(s: string): string {
  if (s === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell single-quoted string literal. */
export function quotePwsh(s: string): string {
  return `'${s.replace(/'/g, "''").replace(/[\u2018\u2019\u201A\u201B]/g, "''")}'`;
}

/** Quoting for a Windows CreateProcess command line (MSVCRT rules). */
export function quoteWindowsArg(s: string): string {
  if (s !== '' && !/[\s"]/.test(s)) return s;
  let out = '"';
  let backslashes = 0;
  for (const ch of s) {
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
    } else {
      out += '\\'.repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  return out + '\\'.repeat(backslashes * 2) + '"';
}

const CMD_UNSAFE = /["%^&|<>\r\n]/;

export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export interface ShellContext {
  cwd?: string;
  env?: Record<string, string>;
}

function assertEnvName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new VBoxMcpError('INVALID_ARGUMENT', `Invalid environment variable name: ${name}`);
}

/** Wraps shell source with working-directory and environment setup expressed in that shell's own syntax. */
export function wrapScript(shell: ShellKind, command: string, ctx: ShellContext = {}): string {
  const env = Object.entries(ctx.env ?? {});
  env.forEach(([k]) => assertEnvName(k));
  switch (shell) {
    case 'bash':
    case 'sh': {
      const lines: string[] = [];
      for (const [k, v] of env) lines.push(`export ${k}=${quotePosix(v)}`);
      if (ctx.cwd) lines.push(`cd -- ${quotePosix(ctx.cwd)} || exit 127`);
      lines.push(command);
      return lines.join('\n');
    }
    case 'powershell':
    case 'pwsh': {
      const pre: string[] = ['$ProgressPreference = \'SilentlyContinue\''];
      for (const [k, v] of env) pre.push(`$env:${k} = ${quotePwsh(v)}`);
      if (ctx.cwd) pre.push(`Set-Location -LiteralPath ${quotePwsh(ctx.cwd)} -ErrorAction Stop`);
      // Propagate native exit codes, and turn terminating/non-terminating cmdlet failure into exit 1.
      return `${pre.join('; ')}\n$global:LASTEXITCODE = 0\n& {\n${command}\n}\nif ($LASTEXITCODE) { exit $LASTEXITCODE } elseif (-not $?) { exit 1 } else { exit 0 }`;
    }
    case 'cmd': {
      const parts: string[] = [];
      for (const [k, v] of env) {
        if (CMD_UNSAFE.test(v)) throw new VBoxMcpError('INVALID_ARGUMENT', `CMD environment value for ${k} contains characters that cannot be passed safely.`);
        parts.push(`set "${k}=${v}"`);
      }
      if (ctx.cwd) {
        if (CMD_UNSAFE.test(ctx.cwd)) throw new VBoxMcpError('INVALID_ARGUMENT', 'CMD working directory contains unsafe characters.');
        parts.push(`cd /d "${ctx.cwd}"`);
      }
      parts.push(command.replace(/\r?\n/g, ' & '));
      return parts.join(' && ');
    }
  }
}

export interface Invocation {
  exe: string;
  args: string[];
  verbatimArgs: boolean;
}

/** Builds the guest process invocation for a one-off command in a given shell. */
export function buildInvocation(shell: ShellKind, script: string, exePath?: string): Invocation {
  const exe = exePath ?? SHELLS[shell].paths[0]!;
  switch (shell) {
    case 'bash':
      return { exe, args: ['-c', script], verbatimArgs: false };
    case 'sh':
      return { exe, args: ['-c', script], verbatimArgs: false };
    case 'powershell':
    case 'pwsh':
      return { exe, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(script)], verbatimArgs: false };
    case 'cmd':
      // `/s /c "<line>"`: cmd strips the outer quotes and runs the line exactly as written.
      return { exe, args: ['/d', '/s', '/c', `"${script}"`], verbatimArgs: true };
  }
}

/** Invocation for an interactive, persistent shell process. */
export function buildInteractiveInvocation(shell: ShellKind, exePath: string | undefined, pty: boolean): Invocation {
  const exe = exePath ?? SHELLS[shell].paths[0]!;
  switch (shell) {
    case 'bash':
      return { exe, args: pty ? ['-i'] : ['--noprofile', '--norc', '-s'], verbatimArgs: false };
    case 'sh':
      return { exe, args: pty ? ['-i'] : ['-s'], verbatimArgs: false };
    case 'powershell':
    case 'pwsh':
      // -Command - reads commands from stdin, one per line, preserving state between them.
      return { exe, args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-'], verbatimArgs: false };
    case 'cmd':
      return { exe, args: ['/d', '/q', '/k'], verbatimArgs: false };
  }
}

/** Renders an invocation as a single command line, for transports that take a string (SSH). */
export function renderCommandLine(inv: Invocation, os: GuestOsFamily): string {
  if (os === 'linux') return [inv.exe, ...inv.args].map(quotePosix).join(' ');
  const exe = quoteWindowsArg(inv.exe);
  return inv.verbatimArgs ? [exe, ...inv.args].join(' ') : [exe, ...inv.args.map(quoteWindowsArg)].join(' ');
}

/** Line to send to an interactive shell that prints a unique marker with the last exit status. */
export function markerCommand(shell: ShellKind, marker: string): string {
  switch (shell) {
    case 'bash':
    case 'sh':
      return `printf '\\n${marker}:%s\\n' "$?"`;
    case 'powershell':
    case 'pwsh':
      return `Write-Output ("${marker}:" + $(if ($?) { if ($LASTEXITCODE) { $LASTEXITCODE } else { 0 } } else { 1 }))`;
    case 'cmd':
      return `echo ${marker}:%ERRORLEVEL%`;
  }
}

export function scriptExtension(shell: ShellKind): string {
  return shell === 'bash' || shell === 'sh' ? '.sh' : shell === 'cmd' ? '.cmd' : '.ps1';
}
