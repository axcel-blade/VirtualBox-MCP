import { randomUUID, randomBytes } from 'node:crypto';
import type { Config, ShellKind } from '../config/schema.js';
import { VBoxMcpError } from '../core/errors.js';
import { buildInteractiveInvocation, markerCommand } from '../core/shells.js';
import { redactString } from '../security/redact.js';
import type { VmRef } from '../security/security-manager.js';
import type { ConnectionManager } from './connection-manager.js';
import type { BackendName, ShellChannel } from '../backends/types.js';

export interface TerminalSessionInfo {
  id: string;
  vmName: string;
  vmUuid: string;
  shell: ShellKind;
  backend: BackendName;
  owner: string;
  pty: boolean;
  cols: number;
  rows: number;
  status: 'open' | 'exited' | 'closed';
  exitCode: number | null;
  createdAt: string;
  lastActivityAt: string;
  bufferedBytes: number;
  outputCursor: number;
}

interface Session extends TerminalSessionInfo {
  channel: ShellChannel;
  /** Absolute byte offsets: `base` is the offset of chunks[0]. */
  output: string;
  base: number;
  total: number;
  waiters: Array<() => void>;
}

/**
 * Persistent interactive guest terminals. Each session is one genuine long-lived guest shell
 * process (SSH channel, WinRM command or guestcontrol process); state such as the working
 * directory and environment lives in that process between MCP calls.
 */
export class TerminalManager {
  private sessions = new Map<string, Session>();
  private sweeper: NodeJS.Timeout;

  constructor(private readonly cfg: Config, private readonly connections: ConnectionManager) {
    this.sweeper = setInterval(() => this.sweep(), 30000);
    this.sweeper.unref();
  }

  private sweep(): void {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (s.status === 'open' && now - Date.parse(s.lastActivityAt) > this.cfg.terminal.sessionTimeout) {
        this.closeSession(s, 'idle timeout');
      }
      if (s.status !== 'open' && now - Date.parse(s.lastActivityAt) > 10 * 60000) this.sessions.delete(s.id);
    }
  }

  private info(s: Session): TerminalSessionInfo {
    const { channel: _c, output: _o, base: _b, total, waiters: _w, ...rest } = s;
    return { ...rest, bufferedBytes: s.output.length, outputCursor: total };
  }

  private getOwned(id: string, owner: string): Session {
    const s = this.sessions.get(id);
    // Sessions owned by another MCP client are reported as missing (session isolation).
    if (!s || s.owner !== owner) throw new VBoxMcpError('SESSION_NOT_FOUND', `Terminal session ${id} not found.`);
    return s;
  }

  list(owner: string, vm?: VmRef): TerminalSessionInfo[] {
    return [...this.sessions.values()].filter((s) => s.owner === owner && (!vm || s.vmUuid === vm.uuid)).map((s) => this.info(s));
  }

  get(id: string, owner: string): TerminalSessionInfo {
    return this.info(this.getOwned(id, owner));
  }

  get openCount(): number {
    return [...this.sessions.values()].filter((s) => s.status === 'open').length;
  }

  async open(req: { vm: VmRef; owner: string; shell?: ShellKind; backend?: BackendName | 'auto'; cols?: number; rows?: number; pty?: boolean; cwd?: string; env?: Record<string, string> }): Promise<TerminalSessionInfo> {
    if (!this.cfg.terminal.persistentSessions) throw new VBoxMcpError('PERMISSION_DENIED', 'Persistent terminal sessions are disabled (terminal.persistentSessions=false).');
    if (this.openCount >= this.cfg.terminal.maximumSessions) {
      throw new VBoxMcpError('PERMISSION_DENIED', `Maximum number of terminal sessions (${this.cfg.terminal.maximumSessions}) reached. Close an existing session first.`);
    }
    const conn = await this.connections.connect(req.vm, req.backend);
    const { shell, path } = await this.connections.resolveShell(conn, req.shell);
    const wantPty = req.pty ?? conn.backend.name === 'ssh';
    const pty = wantPty && conn.backend.name === 'ssh';
    const inv = buildInteractiveInvocation(shell, path, pty);
    const cols = req.cols ?? 120;
    const rows = req.rows ?? 40;
    const channel = await conn.backend.openShell({ exe: inv.exe, args: inv.args, cols, rows, pty });
    const now = new Date().toISOString();
    const s: Session = {
      id: randomUUID(),
      vmName: req.vm.name,
      vmUuid: req.vm.uuid,
      shell,
      backend: conn.backend.name,
      owner: req.owner,
      pty,
      cols,
      rows,
      status: 'open',
      exitCode: null,
      createdAt: now,
      lastActivityAt: now,
      bufferedBytes: 0,
      outputCursor: 0,
      channel,
      output: '',
      base: 0,
      total: 0,
      waiters: [],
    };
    channel.onData((_stream, chunk) => this.append(s, chunk));
    channel.onExit((code) => {
      s.status = s.status === 'closed' ? 'closed' : 'exited';
      s.exitCode = code;
      s.lastActivityAt = new Date().toISOString();
      s.waiters.splice(0).forEach((w) => w());
    });
    this.sessions.set(s.id, s);
    // Initial setup in the shell's own syntax.
    const setup: string[] = [];
    if (shell === 'bash' || shell === 'sh') {
      for (const [k, v] of Object.entries(req.env ?? {})) setup.push(`export ${k}='${v.replace(/'/g, `'\\''`)}'`);
      if (req.cwd) setup.push(`cd -- '${req.cwd.replace(/'/g, `'\\''`)}'`);
      if (!pty) setup.push('PS1=; export TERM=dumb');
    } else if (shell === 'powershell' || shell === 'pwsh') {
      for (const [k, v] of Object.entries(req.env ?? {})) setup.push(`$env:${k} = '${v.replace(/'/g, "''")}'`);
      if (req.cwd) setup.push(`Set-Location -LiteralPath '${req.cwd.replace(/'/g, "''")}'`);
    } else {
      for (const [k, v] of Object.entries(req.env ?? {})) setup.push(`set "${k}=${v}"`);
      if (req.cwd) setup.push(`cd /d "${req.cwd}"`);
    }
    for (const line of setup) channel.write(line + '\n');
    return this.info(s);
  }

  private append(s: Session, chunk: string): void {
    s.output += chunk;
    s.total += chunk.length;
    const max = this.cfg.terminal.bufferBytes;
    if (s.output.length > max) {
      const drop = s.output.length - max;
      s.output = s.output.slice(drop);
      s.base += drop;
    }
    s.lastActivityAt = new Date().toISOString();
    s.waiters.splice(0).forEach((w) => w());
  }

  write(id: string, owner: string, data: string): void {
    const s = this.getOwned(id, owner);
    if (s.status !== 'open') throw new VBoxMcpError('SESSION_NOT_FOUND', `Terminal session ${id} is ${s.status}.`);
    s.lastActivityAt = new Date().toISOString();
    s.channel.write(data);
  }

  /**
   * Sends a command line and waits until the shell prints a unique completion marker, returning
   * the output produced and the command's exit status.
   */
  async runAndWait(id: string, owner: string, command: string, timeoutMs: number): Promise<{ output: string; exitCode: number | null; completed: boolean; cursor: number }> {
    const s = this.getOwned(id, owner);
    const marker = `__VBOXMCP_${randomBytes(6).toString('hex')}`;
    const startCursor = s.total;
    this.write(id, owner, `${command}\n${markerCommand(s.shell, marker)}\n`);
    const re = new RegExp(`${marker}:(-?\\d+)`);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const text = this.slice(s, startCursor);
      // Skip the echoed marker command itself (PTY echo); match only a printed marker line.
      const lines = text.split(/\r?\n/);
      const hitIdx = lines.findIndex((l) => re.test(l) && !l.includes('printf') && !l.includes('Write-Output') && !/echo /i.test(l));
      if (hitIdx >= 0) {
        const code = Number(lines[hitIdx]!.match(re)![1]);
        const output = lines
          .slice(0, hitIdx)
          .filter((l) => !l.includes(marker))
          .join('\n');
        return { output: redactString(output), exitCode: code, completed: true, cursor: s.total };
      }
      if (s.status !== 'open' || Date.now() >= deadline) {
        return { output: redactString(text), exitCode: s.status !== 'open' ? s.exitCode : null, completed: false, cursor: s.total };
      }
      await new Promise<void>((res) => {
        const t = setTimeout(res, Math.min(1000, Math.max(0, deadline - Date.now())));
        s.waiters.push(() => {
          clearTimeout(t);
          res();
        });
      });
    }
  }

  private slice(s: Session, from: number): string {
    const start = Math.max(from, s.base) - s.base;
    return s.output.slice(start);
  }

  /** Reads output since `cursor` (absolute offset). Optionally waits for new output. */
  async read(id: string, owner: string, opts: { cursor?: number; maxBytes?: number; waitMs?: number } = {}): Promise<{ output: string; cursor: number; nextCursor: number; dataLost: boolean; status: string; exitCode: number | null }> {
    const s = this.getOwned(id, owner);
    const cursor = opts.cursor ?? s.base;
    if (opts.waitMs && s.total <= cursor && s.status === 'open') {
      await new Promise<void>((res) => {
        const t = setTimeout(res, Math.min(opts.waitMs!, 60000));
        s.waiters.push(() => {
          clearTimeout(t);
          res();
        });
      });
    }
    const dataLost = cursor < s.base;
    let out = this.slice(s, cursor);
    const max = opts.maxBytes ?? 65536;
    if (out.length > max) out = out.slice(0, max);
    const effectiveStart = Math.max(cursor, s.base);
    return { output: redactString(out), cursor: effectiveStart, nextCursor: effectiveStart + out.length, dataLost, status: s.status, exitCode: s.exitCode };
  }

  resize(id: string, owner: string, cols: number, rows: number): boolean {
    const s = this.getOwned(id, owner);
    if (!s.channel.supportsResize || !s.channel.resize) return false;
    s.channel.resize(cols, rows);
    s.cols = cols;
    s.rows = rows;
    return true;
  }

  interrupt(id: string, owner: string): void {
    const s = this.getOwned(id, owner);
    s.channel.interrupt();
    s.lastActivityAt = new Date().toISOString();
  }

  private closeSession(s: Session, _reason: string): void {
    if (s.status === 'open') {
      s.status = 'closed';
      try {
        s.channel.close();
      } catch {
        // already gone
      }
    }
    s.lastActivityAt = new Date().toISOString();
    s.waiters.splice(0).forEach((w) => w());
  }

  /** Graceful close: asks the shell to exit, then closes the channel. */
  close(id: string, owner: string): TerminalSessionInfo {
    const s = this.getOwned(id, owner);
    if (s.status === 'open') {
      try {
        s.channel.write('exit\n');
      } catch {
        // ignore
      }
      setTimeout(() => this.closeSession(s, 'closed'), 500).unref();
    }
    return this.info(s);
  }

  /** Forced termination. */
  terminate(id: string, owner: string): TerminalSessionInfo {
    const s = this.getOwned(id, owner);
    this.closeSession(s, 'terminated');
    this.sessions.delete(id);
    return this.info(s);
  }

  closeAll(): number {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.status === 'open') n++;
      this.closeSession(s, 'shutdown');
    }
    return n;
  }

  dispose(): void {
    clearInterval(this.sweeper);
    this.closeAll();
  }
}
