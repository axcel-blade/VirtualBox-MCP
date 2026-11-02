import { request as httpRequest } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { createReadStream, createWriteStream, statSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { VBoxMcpError } from '../../core/errors.js';
import { BoundedBuffer } from '../../utils/process.js';
import { quoteWindowsArg, quotePwsh, encodePowerShell, SHELLS } from '../../core/shells.js';
import type { ExecRequest, ExecResult, GuestBackend, GuestCredentials, OpenShellRequest, ShellChannel } from '../types.js';
import * as soap from './soap.js';

export interface WinRmTarget {
  host: string;
  port: number;
  https: boolean;
  path: string;
  rejectUnauthorized: boolean;
}

/**
 * Backend C — WinRM (WS-Management, Basic authentication). Basic auth must be enabled on the
 * guest; use HTTPS whenever possible (see docs/guest-setup.md).
 */
export class WinRmBackend implements GuestBackend {
  readonly name = 'winrm' as const;
  readonly os = 'windows' as const;
  private readonly url: string;
  private readonly agent: HttpsAgent | undefined;

  constructor(private readonly target: WinRmTarget, private readonly creds: GuestCredentials) {
    this.url = `${target.https ? 'https' : 'http'}://${target.host}:${target.port}${target.path}`;
    this.agent = target.https ? new HttpsAgent({ rejectUnauthorized: target.rejectUnauthorized, keepAlive: true }) : undefined;
  }

  private post(body: string, timeoutMs = 60000): Promise<string> {
    const user = this.creds.domain ? `${this.creds.domain}\\${this.creds.username}` : this.creds.username;
    const auth = Buffer.from(`${user}:${this.creds.password ?? ''}`).toString('base64');
    const u = new URL(this.url);
    const req = this.target.https ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const r = req(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname,
          method: 'POST',
          agent: this.agent,
          headers: { 'Content-Type': 'application/soap+xml;charset=UTF-8', Authorization: `Basic ${auth}`, 'Content-Length': Buffer.byteLength(body) },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode === 401) return reject(new VBoxMcpError('GUEST_AUTHENTICATION_FAILED', 'WinRM authentication failed (HTTP 401). Check credentials and that Basic auth is enabled.'));
            const fault = soap.parseFault(text);
            if (fault) {
              const e = new VBoxMcpError('WINRM_CONNECTION_FAILED', `WinRM fault${fault.code ? ` ${fault.code}` : ''}: ${fault.message}`, { faultCode: fault.code });
              return reject(e);
            }
            if ((res.statusCode ?? 500) >= 400) return reject(new VBoxMcpError('WINRM_CONNECTION_FAILED', `WinRM HTTP ${res.statusCode}`));
            resolve(text);
          });
        },
      );
      r.on('timeout', () => r.destroy(new Error('request timed out')));
      r.on('error', (e) => reject(e instanceof VBoxMcpError ? e : new VBoxMcpError('WINRM_CONNECTION_FAILED', `WinRM request to ${this.url} failed: ${e.message}`)));
      r.end(body);
    });
  }

  private async createShell(): Promise<string> {
    const xml = await this.post(
      soap.envelope({ to: this.url, action: soap.ACTION.create, options: { WINRS_NOPROFILE: 'FALSE', WINRS_CODEPAGE: '65001' }, body: soap.createShellBody() }),
    );
    const id = soap.parseShellId(xml);
    if (!id) throw new VBoxMcpError('WINRM_CONNECTION_FAILED', 'WinRM did not return a shell id.');
    return id;
  }

  private async deleteShell(shellId: string): Promise<void> {
    await this.post(soap.envelope({ to: this.url, action: soap.ACTION.delete, shellId, body: '' })).catch(() => undefined);
  }

  private async startCommand(shellId: string, exe: string, args: string): Promise<string> {
    const xml = await this.post(
      soap.envelope({ to: this.url, action: soap.ACTION.command, shellId, options: { WINRS_CONSOLEMODE_STDIN: 'TRUE', WINRS_SKIP_CMD_SHELL: 'TRUE' }, body: soap.commandBody(exe, args) }),
    );
    const id = soap.parseCommandId(xml);
    if (!id) throw new VBoxMcpError('WINRM_CONNECTION_FAILED', 'WinRM did not return a command id.');
    return id;
  }

  private async receive(shellId: string, commandId: string): Promise<soap.ReceiveChunk> {
    try {
      const xml = await this.post(soap.envelope({ to: this.url, action: soap.ACTION.receive, shellId, body: soap.receiveBody(commandId), operationTimeoutSec: 20 }), 40000);
      return soap.parseReceive(xml);
    } catch (e) {
      if (e instanceof VBoxMcpError && e.details?.faultCode === soap.RECEIVE_TIMEOUT_FAULT) return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), done: false };
      throw e;
    }
  }

  private async send(shellId: string, commandId: string, data: Buffer, end: boolean): Promise<void> {
    await this.post(soap.envelope({ to: this.url, action: soap.ACTION.send, shellId, body: soap.sendBody(commandId, data, end) }));
  }

  private async signal(shellId: string, commandId: string, code: string): Promise<void> {
    await this.post(soap.envelope({ to: this.url, action: soap.ACTION.signal, shellId, body: soap.signalBody(commandId, code) })).catch(() => undefined);
  }

  async exec(req: ExecRequest): Promise<ExecResult> {
    const started = Date.now();
    const shellId = await this.createShell();
    const out = new BoundedBuffer(req.maxOutputBytes);
    const err = new BoundedBuffer(req.maxOutputBytes);
    let timedOut = false;
    let cancelled = false;
    let exitCode: number | null = null;
    try {
      const args = req.verbatimArgs ? req.args.join(' ') : req.args.map(quoteWindowsArg).join(' ');
      const commandId = await this.startCommand(shellId, req.exe, args);
      if (req.stdin !== undefined) {
        const buf = Buffer.isBuffer(req.stdin) ? req.stdin : Buffer.from(req.stdin, 'utf8');
        const CHUNK = 256 * 1024;
        for (let off = 0; off < buf.length || off === 0; off += CHUNK) {
          await this.send(shellId, commandId, buf.subarray(off, off + CHUNK), off + CHUNK >= buf.length);
          if (buf.length === 0) break;
        }
      }
      for (;;) {
        if (req.signal?.aborted) {
          cancelled = true;
          await this.signal(shellId, commandId, soap.SIGNAL.terminate);
          break;
        }
        if (Date.now() - started > req.timeoutMs) {
          timedOut = true;
          await this.signal(shellId, commandId, soap.SIGNAL.terminate);
          break;
        }
        const chunk = await this.receive(shellId, commandId);
        if (chunk.stdout.length) {
          out.push(chunk.stdout);
          req.onOutput?.('stdout', chunk.stdout.toString('utf8'));
        }
        if (chunk.stderr.length) {
          err.push(chunk.stderr);
          req.onOutput?.('stderr', chunk.stderr.toString('utf8'));
        }
        if (chunk.done) {
          exitCode = chunk.exitCode ?? null;
          break;
        }
      }
    } finally {
      await this.deleteShell(shellId);
    }
    return { exitCode, stdout: out.toString(), stderr: err.toString(), timedOut, cancelled, truncated: out.truncated || err.truncated, durationMs: Date.now() - started };
  }

  private async ps(script: string, opts: { stdin?: Buffer; timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<ExecResult> {
    const r = await this.exec({
      exe: SHELLS.powershell.paths[0]!,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(`$ProgressPreference='SilentlyContinue'; ${script}`)],
      timeoutMs: opts.timeoutMs ?? 300000,
      maxOutputBytes: opts.maxOutputBytes ?? 64 * 1024 * 1024,
      stdin: opts.stdin,
    });
    if (r.exitCode !== 0) throw new VBoxMcpError('FILE_TRANSFER_FAILED', `WinRM PowerShell file operation failed: ${r.stderr.trim().slice(0, 2000)}`);
    return r;
  }

  async readFile(path: string, maxBytes: number): Promise<Buffer> {
    const size = Number((await this.ps(`(Get-Item -LiteralPath ${quotePwsh(path)}).Length`)).stdout.trim());
    if (size > maxBytes) throw new VBoxMcpError('FILE_TRANSFER_FAILED', `File exceeds the inline read limit of ${maxBytes} bytes; use download_file_from_vm.`);
    return this.readChunked(path, size);
  }

  private async readChunked(path: string, size: number, onProgress?: (n: number) => void, signal?: AbortSignal, sink?: (b: Buffer) => void): Promise<Buffer> {
    const CHUNK = 4 * 1024 * 1024;
    const parts: Buffer[] = [];
    for (let off = 0; off < size || (off === 0 && size === 0); off += CHUNK) {
      if (signal?.aborted) throw new VBoxMcpError('COMMAND_CANCELLED', 'Transfer cancelled.');
      if (size === 0) break;
      const len = Math.min(CHUNK, size - off);
      const r = await this.ps(
        `$f=[IO.File]::OpenRead(${quotePwsh(path)}); try { $null=$f.Seek(${off},'Begin'); $b=New-Object byte[] ${len}; $n=$f.Read($b,0,${len}); [Convert]::ToBase64String($b,0,$n) } finally { $f.Close() }`,
      );
      const buf = Buffer.from(r.stdout.trim(), 'base64');
      if (sink) sink(buf);
      else parts.push(buf);
      onProgress?.(off + buf.length);
    }
    return Buffer.concat(parts);
  }

  async writeFile(path: string, data: Buffer): Promise<void> {
    // Stream bytes through stdin; avoids command-line length limits and keeps data binary-safe.
    await this.ps(
      `$in=[Console]::OpenStandardInput(); $out=[IO.File]::Create(${quotePwsh(path)}); try { $in.CopyTo($out) } finally { $out.Close() }`,
      { stdin: data },
    );
  }

  async upload(hostPath: string, guestPath: string, opts: { recursive: boolean; onProgress?: (bytes: number) => void; signal?: AbortSignal }): Promise<void> {
    let total = 0;
    const put = async (local: string, remote: string): Promise<void> => {
      if (opts.signal?.aborted) throw new VBoxMcpError('COMMAND_CANCELLED', 'Transfer cancelled.');
      const st = statSync(local);
      if (st.isDirectory()) {
        if (!opts.recursive) throw new VBoxMcpError('INVALID_ARGUMENT', `${local} is a directory; use upload_directory_to_vm.`);
        await this.ps(`New-Item -ItemType Directory -Force -Path ${quotePwsh(remote)} | Out-Null`);
        for (const n of readdirSync(local)) await put(join(local, n), `${remote}\\${n}`);
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of createReadStream(local)) chunks.push(c as Buffer);
      await this.writeFile(remote, Buffer.concat(chunks));
      total += st.size;
      opts.onProgress?.(total);
    };
    await put(hostPath, guestPath);
  }

  async download(guestPath: string, hostPath: string, opts: { recursive: boolean; onProgress?: (bytes: number) => void; signal?: AbortSignal }): Promise<void> {
    const listing = await this.ps(
      `$p=${quotePwsh(guestPath)}; if (Test-Path -LiteralPath $p -PathType Container) { Get-ChildItem -LiteralPath $p -Recurse -File | ForEach-Object { $_.FullName.Substring($p.TrimEnd('\\').Length+1) + '|' + $_.Length } ; 'DIR' } else { 'FILE|' + (Get-Item -LiteralPath $p).Length }`,
    );
    const lines = listing.stdout.trim().split(/\r?\n/).filter(Boolean);
    let total = 0;
    const fetchOne = async (remote: string, local: string, size: number) => {
      const ws = createWriteStream(local);
      await this.readChunked(remote, size, (n) => opts.onProgress?.(total + n), opts.signal, (b) => ws.write(b));
      await new Promise<void>((res, rej) => ws.end((e?: Error | null) => (e ? rej(e) : res())));
      total += size;
    };
    if (lines.at(-1) === 'DIR') {
      if (!opts.recursive) throw new VBoxMcpError('INVALID_ARGUMENT', `${guestPath} is a directory; use download_directory_from_vm.`);
      for (const line of lines.slice(0, -1)) {
        const [rel, size] = line.split('|');
        const local = join(hostPath, ...rel!.split('\\'));
        mkdirSync(join(local, '..'), { recursive: true });
        await fetchOne(`${guestPath.replace(/\\$/, '')}\\${rel}`, local, Number(size));
      }
      mkdirSync(hostPath, { recursive: true });
    } else {
      await fetchOne(guestPath, hostPath, Number(lines[0]?.split('|')[1] ?? 0));
    }
  }

  async openShell(req: OpenShellRequest): Promise<ShellChannel> {
    const shellId = await this.createShell();
    const commandId = await this.startCommand(shellId, req.exe, req.args.map(quoteWindowsArg).join(' '));
    const dataCbs: Array<(s: 'stdout' | 'stderr', c: string) => void> = [];
    const exitCbs: Array<(c: number | null) => void> = [];
    let closed = false;
    let sendChain = Promise.resolve();
    const finish = (code: number | null) => {
      if (closed) return;
      closed = true;
      exitCbs.forEach((cb) => cb(code));
      void this.deleteShell(shellId);
    };
    // Receive loop: a genuine long-running remote process whose output is polled continuously.
    void (async () => {
      while (!closed) {
        try {
          const chunk = await this.receive(shellId, commandId);
          if (chunk.stdout.length) dataCbs.forEach((cb) => cb('stdout', chunk.stdout.toString('utf8')));
          if (chunk.stderr.length) dataCbs.forEach((cb) => cb('stderr', chunk.stderr.toString('utf8')));
          if (chunk.done) return finish(chunk.exitCode ?? null);
        } catch (e) {
          dataCbs.forEach((cb) => cb('stderr', `\n[winrm] ${(e as Error).message}\n`));
          return finish(null);
        }
      }
    })();
    return {
      pty: false,
      supportsResize: false,
      write: (d) => {
        const data = Buffer.from(d.replace(/(?<!\r)\n/g, '\r\n'), 'utf8');
        sendChain = sendChain.then(() => this.send(shellId, commandId, data, false)).catch(() => undefined);
      },
      onData: (cb) => dataCbs.push(cb),
      onExit: (cb) => exitCbs.push(cb),
      interrupt: () => void this.signal(shellId, commandId, soap.SIGNAL.ctrlC),
      close: () => {
        void this.signal(shellId, commandId, soap.SIGNAL.terminate).finally(() => finish(null));
      },
    };
  }

  async close(): Promise<void> {
    this.agent?.destroy();
  }
}
