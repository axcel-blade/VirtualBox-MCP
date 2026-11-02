import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, renameSync, readdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import type { VBoxClient } from '../../core/vbox-client.js';
import { VBoxMcpError } from '../../core/errors.js';
import { redactString } from '../../security/redact.js';
import type { ExecRequest, ExecResult, GuestBackend, GuestCredentials, GuestOsFamily, OpenShellRequest, ShellChannel } from '../types.js';

/** Writes the guest password to a private temp file so it never appears on a process command line. */
function withPasswordFile<T>(password: string | undefined, fn: (args: string[]) => Promise<T>): Promise<T> {
  if (!password) return fn([]);
  const dir = mkdtempSync(join(tmpdir(), 'vboxmcp-'));
  const file = join(dir, 'pw');
  writeFileSync(file, password, { mode: 0o600 });
  return fn([`--passwordfile=${file}`]).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const VBOX_ERROR = /VBoxManage(\.exe)?: error:/;

/**
 * Backend A — VirtualBox Guest Control (`VBoxManage guestcontrol`). Requires Guest Additions in a
 * running guest and valid guest account credentials.
 */
export class GuestControlBackend implements GuestBackend {
  readonly name = 'guestcontrol' as const;

  constructor(
    private readonly vbox: VBoxClient,
    private readonly vmUuid: string,
    readonly os: GuestOsFamily,
    private readonly creds: GuestCredentials,
  ) {}

  private authArgs(): string[] {
    const a = [`--username=${this.creds.username}`];
    if (this.creds.domain) a.push(`--domain=${this.creds.domain}`);
    return a;
  }

  async exec(req: ExecRequest): Promise<ExecResult> {
    return withPasswordFile(this.creds.password, async (pw) => {
      const args = [
        'guestcontrol', this.vmUuid, 'run',
        ...this.authArgs(), ...pw,
        `--exe=${req.exe}`,
        '--wait-stdout', '--wait-stderr',
        `--timeout=${req.timeoutMs}`,
        ...(req.verbatimArgs ? ['--unquoted-args'] : []),
        '--', basename(req.exe), ...req.args,
      ];
      const r = await this.vbox.run(args, {
        timeoutMs: req.timeoutMs + 15000,
        signal: req.signal,
        allowFailure: true,
        maxOutputBytes: req.maxOutputBytes,
        input: typeof req.stdin === 'string' ? req.stdin : req.stdin?.toString('utf8'),
      });
      if (r.exitCode !== 0 && VBOX_ERROR.test(r.stderr)) this.throwGuestControlError(r.stderr);
      const timedOut = r.timedOut || (r.durationMs >= req.timeoutMs && r.exitCode !== 0);
      if (r.stdout) req.onOutput?.('stdout', r.stdout);
      if (r.stderr) req.onOutput?.('stderr', r.stderr);
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut, cancelled: r.cancelled, truncated: r.truncated, durationMs: r.durationMs };
    });
  }

  private throwGuestControlError(stderr: string): never {
    const s = redactString(stderr.trim());
    if (/VERR_AUTHENTICATION_FAILURE|logon failure|authentication/i.test(s)) throw new VBoxMcpError('GUEST_AUTHENTICATION_FAILED', `Guest authentication failed: ${s}`);
    if (/Guest Additions|VERR_NOT_SUPPORTED|not.*(ready|available)|VERR_TIMEOUT.*session/i.test(s)) throw new VBoxMcpError('GUEST_ADDITIONS_NOT_INSTALLED', `Guest Control is unavailable (Guest Additions missing, outdated or not started): ${s}`);
    if (/VERR_FILE_NOT_FOUND|VERR_PATH_NOT_FOUND|not found/i.test(s)) throw new VBoxMcpError('SHELL_NOT_AVAILABLE', `Guest executable not found: ${s}`);
    if (/not running|is not currently running|VBOX_E_INVALID_VM_STATE/i.test(s)) throw new VBoxMcpError('VM_NOT_RUNNING', s);
    throw new VBoxMcpError('COMMAND_EXECUTION_FAILED', s);
  }

  private async copy(direction: 'copyto' | 'copyfrom', sources: string[], target: string, recursive: boolean, signal?: AbortSignal): Promise<void> {
    await withPasswordFile(this.creds.password, async (pw) => {
      const r = await this.vbox.run(
        ['guestcontrol', this.vmUuid, direction, ...this.authArgs(), ...pw, ...(recursive ? ['--recursive'] : []), `--target-directory=${target}`, ...sources],
        { timeoutMs: 6 * 60 * 60 * 1000, signal, allowFailure: true },
      );
      if (r.exitCode !== 0) {
        if (VBOX_ERROR.test(r.stderr) && /authentication|Guest Additions/i.test(r.stderr)) this.throwGuestControlError(r.stderr);
        throw new VBoxMcpError('FILE_TRANSFER_FAILED', `guestcontrol ${direction} failed: ${redactString(r.stderr.trim())}`);
      }
    });
  }

  private guestDirname(p: string): string {
    const sep = this.os === 'windows' ? '\\' : '/';
    const idx = p.lastIndexOf(sep);
    return idx <= 0 ? sep : this.os === 'windows' && idx === 2 ? p.slice(0, 3) : p.slice(0, idx);
  }

  private guestBasename(p: string): string {
    return p.split(this.os === 'windows' ? /[\\/]/ : /\//).pop() ?? p;
  }

  async readFile(path: string, maxBytes: number): Promise<Buffer> {
    const dir = mkdtempSync(join(tmpdir(), 'vboxmcp-dl-'));
    try {
      await this.copy('copyfrom', [path], dir, false);
      const local = join(dir, this.guestBasename(path));
      if (statSync(local).size > maxBytes) throw new VBoxMcpError('FILE_TRANSFER_FAILED', `File exceeds the inline read limit of ${maxBytes} bytes; use download_file_from_vm.`);
      return readFileSync(local);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async writeFile(path: string, data: Buffer): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'vboxmcp-ul-'));
    try {
      const local = join(dir, this.guestBasename(path));
      writeFileSync(local, data, { mode: 0o600 });
      await this.copy('copyto', [local], this.guestDirname(path), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async upload(hostPath: string, guestPath: string, opts: { recursive: boolean; onProgress?: (bytes: number) => void; signal?: AbortSignal }): Promise<void> {
    // copyto places sources inside the target directory; stage under the desired final name.
    const desiredName = this.guestBasename(guestPath);
    if (basename(hostPath) === desiredName) {
      await this.copy('copyto', [hostPath], this.guestDirname(guestPath), opts.recursive, opts.signal);
    } else {
      const stage = mkdtempSync(join(tmpdir(), 'vboxmcp-st-'));
      try {
        const staged = join(stage, desiredName);
        // A hard copy keeps the host source untouched.
        cpSync(hostPath, staged, { recursive: opts.recursive });
        await this.copy('copyto', [staged], this.guestDirname(guestPath), opts.recursive, opts.signal);
      } finally {
        rmSync(stage, { recursive: true, force: true });
      }
    }
    opts.onProgress?.(sizeOf(hostPath));
  }

  async download(guestPath: string, hostPath: string, opts: { recursive: boolean; onProgress?: (bytes: number) => void; signal?: AbortSignal }): Promise<void> {
    const stage = mkdtempSync(join(dirname(hostPath), '.vboxmcp-'));
    try {
      await this.copy('copyfrom', [guestPath], stage, opts.recursive, opts.signal);
      const got = join(stage, this.guestBasename(guestPath));
      rmSync(hostPath, { recursive: true, force: true });
      renameSync(got, hostPath);
      opts.onProgress?.(sizeOf(hostPath));
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }

  async openShell(req: OpenShellRequest): Promise<ShellChannel> {
    // Guest Control has no PTY; stdin is forwarded to the guest process by `guestcontrol run`.
    // The password file must outlive process start-up, so it is removed once the process exits.
    const dir = mkdtempSync(join(tmpdir(), 'vboxmcp-'));
    const pwArgs: string[] = [];
    if (this.creds.password) {
      const file = join(dir, 'pw');
      writeFileSync(file, this.creds.password, { mode: 0o600 });
      pwArgs.push(`--passwordfile=${file}`);
    }
    const child = await this.vbox.spawnLongLived([
      'guestcontrol', this.vmUuid, 'run', ...this.authArgs(), ...pwArgs,
      `--exe=${req.exe}`, '--wait-stdout', '--wait-stderr', '--', basename(req.exe), ...req.args,
    ]);
    const cleanup = () => rmSync(dir, { recursive: true, force: true });
    child.on('exit', cleanup);
    child.on('error', cleanup);
    const winInterrupt = this.os === 'windows';
    return {
      pty: false,
      supportsResize: false,
      write: (d) => child.stdin?.write(this.os === 'windows' ? d.replace(/(?<!\r)\n/g, '\r\n') : d),
      onData: (cb) => {
        child.stdout?.on('data', (c: Buffer) => cb('stdout', c.toString('utf8')));
        child.stderr?.on('data', (c: Buffer) => {
          const s = c.toString('utf8');
          if (VBOX_ERROR.test(s)) cb('stderr', redactString(s));
          else cb('stderr', s);
        });
      },
      onExit: (cb) => child.on('exit', (code) => cb(code)),
      // Without a PTY there is no terminal driver to turn ^C into SIGINT; send it anyway for shells that read it.
      interrupt: () => child.stdin?.write(winInterrupt ? '\x03\r\n' : '\x03'),
      close: () => {
        child.stdin?.end();
        setTimeout(() => child.exitCode === null && child.kill(), 3000).unref();
      },
    };
  }

  async close(): Promise<void> {
    // Stateless per call; nothing to release.
  }
}

function sizeOf(p: string): number {
  try {
    const s = statSync(p);
    if (!s.isDirectory()) return s.size;
    return readdirSync(p).reduce((acc, n) => acc + sizeOf(join(p, n)), 0);
  } catch {
    return 0;
  }
}

