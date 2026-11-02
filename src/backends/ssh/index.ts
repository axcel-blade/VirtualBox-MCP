import { Client, type ClientChannel, type SFTPWrapper, type ConnectConfig } from 'ssh2';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, createReadStream, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { VBoxMcpError } from '../../core/errors.js';
import { BoundedBuffer } from '../../utils/process.js';
import { renderCommandLine } from '../../core/shells.js';
import type { ExecRequest, ExecResult, GuestBackend, GuestCredentials, GuestOsFamily, OpenShellRequest, ShellChannel } from '../types.js';

export interface SshTarget {
  host: string;
  port: number;
  /** Expected "SHA256:<base64>" fingerprint. Connections are refused when it does not match. */
  hostKeyFingerprint?: string;
  connectTimeoutMs?: number;
}

export function sshFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/**
 * Backend B — SSH (ssh2). Host-key verification is mandatory: without a configured/trusted
 * fingerprint the connection is refused and the observed fingerprint is reported for an operator
 * to verify and trust.
 */
export class SshBackend implements GuestBackend {
  readonly name = 'ssh' as const;
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;
  private sftpHandle: SFTPWrapper | undefined;

  constructor(
    private readonly target: SshTarget,
    readonly os: GuestOsFamily,
    private readonly creds: GuestCredentials,
  ) {}

  private connect(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<Client>((resolve, reject) => {
      const c = new Client();
      let observed: string | undefined;
      const cfg: ConnectConfig = {
        host: this.target.host,
        port: this.target.port,
        username: this.creds.username,
        readyTimeout: this.target.connectTimeoutMs ?? 20000,
        keepaliveInterval: 15000,
        hostVerifier: (key: Buffer) => {
          observed = sshFingerprint(key);
          return !!this.target.hostKeyFingerprint && observed === this.target.hostKeyFingerprint.replace(/=+$/, '');
        },
      };
      if (this.creds.privateKey) {
        cfg.privateKey = this.creds.privateKey;
        if (this.creds.passphrase) cfg.passphrase = this.creds.passphrase;
      }
      if (this.creds.password) cfg.password = this.creds.password;
      c.on('ready', () => {
        this.client = c;
        this.connecting = undefined;
        resolve(c);
      });
      c.on('error', (err: Error & { level?: string }) => {
        this.connecting = undefined;
        this.client = undefined;
        if (observed && (!this.target.hostKeyFingerprint || observed !== this.target.hostKeyFingerprint.replace(/=+$/, ''))) {
          reject(
            new VBoxMcpError('SSH_CONNECTION_FAILED', `SSH host key for ${this.target.host}:${this.target.port} is not trusted (observed ${observed}). Verify it out-of-band and configure ssh.hostKeyFingerprint, or call trust_ssh_host_key (requires operator approval).`, {
              observedFingerprint: observed,
              expectedFingerprint: this.target.hostKeyFingerprint,
            }),
          );
          return;
        }
        if (err.level === 'client-authentication') {
          reject(new VBoxMcpError('GUEST_AUTHENTICATION_FAILED', `SSH authentication failed for user ${this.creds.username}.`));
          return;
        }
        reject(new VBoxMcpError('SSH_CONNECTION_FAILED', `SSH connection to ${this.target.host}:${this.target.port} failed: ${err.message}`));
      });
      c.on('close', () => {
        this.client = undefined;
        this.sftpHandle = undefined;
      });
      c.connect(cfg);
    });
    return this.connecting;
  }

  async exec(req: ExecRequest): Promise<ExecResult> {
    const c = await this.connect();
    const cmdline = renderCommandLine({ exe: req.exe, args: req.args, verbatimArgs: !!req.verbatimArgs }, this.os);
    const started = Date.now();
    return new Promise<ExecResult>((resolve, reject) => {
      c.exec(cmdline, (err, ch) => {
        if (err) return reject(new VBoxMcpError('COMMAND_EXECUTION_FAILED', `SSH exec failed: ${err.message}`));
        const out = new BoundedBuffer(req.maxOutputBytes);
        const errb = new BoundedBuffer(req.maxOutputBytes);
        let timedOut = false;
        let cancelled = false;
        let exitCode: number | null = null;
        const stop = () => {
          try {
            ch.signal('KILL');
          } catch {
            // not all servers support signals
          }
          ch.close();
        };
        const timer = setTimeout(() => {
          timedOut = true;
          stop();
        }, req.timeoutMs);
        const onAbort = () => {
          cancelled = true;
          stop();
        };
        req.signal?.addEventListener('abort', onAbort, { once: true });
        ch.on('data', (d: Buffer) => {
          out.push(d);
          req.onOutput?.('stdout', d.toString('utf8'));
        });
        ch.stderr.on('data', (d: Buffer) => {
          errb.push(d);
          req.onOutput?.('stderr', d.toString('utf8'));
        });
        ch.on('exit', (code: number | null) => {
          exitCode = code;
        });
        ch.on('close', () => {
          clearTimeout(timer);
          req.signal?.removeEventListener('abort', onAbort);
          resolve({ exitCode, stdout: out.toString(), stderr: errb.toString(), timedOut, cancelled, truncated: out.truncated || errb.truncated, durationMs: Date.now() - started });
        });
        if (req.stdin !== undefined) ch.end(req.stdin);
        else ch.end();
      });
    });
  }

  private async sftp(): Promise<SFTPWrapper> {
    if (this.sftpHandle) return this.sftpHandle;
    const c = await this.connect();
    this.sftpHandle = await new Promise<SFTPWrapper>((res, rej) => c.sftp((e, s) => (e ? rej(new VBoxMcpError('FILE_TRANSFER_FAILED', `SFTP unavailable: ${e.message}`)) : res(s))));
    return this.sftpHandle;
  }

  async readFile(path: string, maxBytes: number): Promise<Buffer> {
    const s = await this.sftp();
    const st = await new Promise<{ size: number }>((res, rej) => s.stat(path, (e, a) => (e ? rej(e) : res(a)))).catch((e: Error) => {
      throw new VBoxMcpError('FILE_TRANSFER_FAILED', `Cannot stat ${path}: ${e.message}`);
    });
    if (st.size > maxBytes) throw new VBoxMcpError('FILE_TRANSFER_FAILED', `File exceeds the inline read limit of ${maxBytes} bytes; use download_file_from_vm.`);
    return new Promise((res, rej) => s.readFile(path, (e, b) => (e ? rej(new VBoxMcpError('FILE_TRANSFER_FAILED', e.message)) : res(b))));
  }

  async writeFile(path: string, data: Buffer): Promise<void> {
    const s = await this.sftp();
    await new Promise<void>((res, rej) => s.writeFile(path, data, (e: Error | null | undefined) => (e ? rej(new VBoxMcpError('FILE_TRANSFER_FAILED', e.message)) : res())));
  }

  async upload(hostPath: string, guestPath: string, opts: { recursive: boolean; onProgress?: (bytes: number) => void; signal?: AbortSignal }): Promise<void> {
    const s = await this.sftp();
    let total = 0;
    const put = async (local: string, remote: string): Promise<void> => {
      if (opts.signal?.aborted) throw new VBoxMcpError('COMMAND_CANCELLED', 'Transfer cancelled.');
      const st = statSync(local);
      if (st.isDirectory()) {
        if (!opts.recursive) throw new VBoxMcpError('INVALID_ARGUMENT', `${local} is a directory; use upload_directory_to_vm.`);
        await new Promise<void>((res) => s.mkdir(remote, () => res()));
        for (const name of readdirSync(local)) await put(join(local, name), `${remote}${this.os === 'windows' ? '\\' : '/'}${name}`);
        return;
      }
      const rs = createReadStream(local);
      rs.on('data', (c) => {
        total += c.length;
        opts.onProgress?.(total);
      });
      await pipeline(rs, s.createWriteStream(remote.replace(/\\/g, '/')), { signal: opts.signal });
    };
    try {
      await put(hostPath, guestPath);
    } catch (e) {
      if (e instanceof VBoxMcpError) throw e;
      throw new VBoxMcpError('FILE_TRANSFER_FAILED', `SFTP upload failed: ${(e as Error).message}`);
    }
  }

  async download(guestPath: string, hostPath: string, opts: { recursive: boolean; onProgress?: (bytes: number) => void; signal?: AbortSignal }): Promise<void> {
    const s = await this.sftp();
    let total = 0;
    const get = async (remote: string, local: string): Promise<void> => {
      if (opts.signal?.aborted) throw new VBoxMcpError('COMMAND_CANCELLED', 'Transfer cancelled.');
      const st = await new Promise<{ isDirectory(): boolean }>((res, rej) => s.stat(remote, (e, a) => (e ? rej(e) : res(a))));
      if (st.isDirectory()) {
        if (!opts.recursive) throw new VBoxMcpError('INVALID_ARGUMENT', `${remote} is a directory; use download_directory_from_vm.`);
        mkdirSync(local, { recursive: true });
        const entries = await new Promise<Array<{ filename: string }>>((res, rej) => s.readdir(remote, (e, l) => (e ? rej(e) : res(l))));
        for (const ent of entries) await get(`${remote}/${ent.filename}`, join(local, ent.filename));
        return;
      }
      const rs = s.createReadStream(remote);
      rs.on('data', (c: Buffer) => {
        total += c.length;
        opts.onProgress?.(total);
      });
      await pipeline(rs, createWriteStream(local), { signal: opts.signal });
    };
    try {
      await get(guestPath.replace(/\\/g, '/'), hostPath);
    } catch (e) {
      if (e instanceof VBoxMcpError) throw e;
      throw new VBoxMcpError('FILE_TRANSFER_FAILED', `SFTP download failed: ${(e as Error).message}`);
    }
  }

  async openShell(req: OpenShellRequest): Promise<ShellChannel> {
    const c = await this.connect();
    const cmdline = renderCommandLine({ exe: req.exe, args: req.args, verbatimArgs: false }, this.os);
    const ch = await new Promise<ClientChannel>((res, rej) =>
      c.exec(cmdline, req.pty ? { pty: { cols: req.cols, rows: req.rows, term: 'xterm-256color' } } : {}, (e, chan) =>
        e ? rej(new VBoxMcpError('SSH_CONNECTION_FAILED', `Could not open SSH shell: ${e.message}`)) : res(chan),
      ),
    );
    return {
      pty: req.pty,
      supportsResize: req.pty,
      write: (d) => ch.write(d),
      onData: (cb) => {
        ch.on('data', (d: Buffer) => cb('stdout', d.toString('utf8')));
        ch.stderr.on('data', (d: Buffer) => cb('stderr', d.toString('utf8')));
      },
      onExit: (cb) => ch.on('close', (code: number | null) => cb(code ?? null)),
      resize: (cols, rows) => ch.setWindow(rows, cols, 0, 0),
      interrupt: () => {
        // With a PTY, ^C is turned into SIGINT by the guest's terminal driver.
        if (req.pty) ch.write('\x03');
        else
          try {
            ch.signal('INT');
          } catch {
            ch.write('\x03');
          }
      },
      close: () => {
        ch.end();
        ch.close();
      },
    };
  }

  async close(): Promise<void> {
    this.client?.end();
    this.client = undefined;
    this.sftpHandle = undefined;
  }
}
