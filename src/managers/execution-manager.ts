import { randomUUID } from 'node:crypto';
import type { Config, ShellKind } from '../config/schema.js';
import { VBoxMcpError } from '../core/errors.js';
import { buildInvocation, wrapScript, scriptExtension, quotePosix, quotePwsh } from '../core/shells.js';
import { Semaphore } from '../security/rate-limit.js';
import { redactString } from '../security/redact.js';
import type { VmRef } from '../security/security-manager.js';
import type { ConnectionManager, ResolvedConnection } from './connection-manager.js';
import type { BackendName } from '../backends/types.js';

export type CommandStatus = 'queued' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled';

export interface CommandRecord {
  id: string;
  vmName: string;
  vmUuid: string;
  backend?: BackendName;
  shell?: ShellKind;
  command: string;
  workingDirectory?: string;
  status: CommandStatus;
  startTime?: string;
  completionTime?: string;
  durationMs?: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  error?: { code: string; message: string };
  tags?: string[];
}

export interface RunCommandRequest {
  vm: VmRef;
  command: string;
  shell?: ShellKind;
  backend?: BackendName | 'auto';
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
  label?: string;
}

export interface ScriptRequest extends Omit<RunCommandRequest, 'command'> {
  script: string;
  args?: string[];
  interpreter?: 'python';
}

/** Runs guest commands, tracks them, and keeps a bounded history for inspection. */
export class ExecutionManager {
  private records = new Map<string, CommandRecord>();
  private controllers = new Map<string, AbortController>();
  private order: string[] = [];
  private readonly semaphore: Semaphore;
  private tempDirs = new Map<string, string>();

  constructor(private readonly cfg: Config, private readonly connections: ConnectionManager) {
    this.semaphore = new Semaphore(cfg.execution.maximumConcurrentCommands);
  }

  clampTimeout(ms?: number): number {
    return Math.min(Math.max(ms ?? this.cfg.execution.defaultTimeout, 1000), this.cfg.execution.maximumTimeout);
  }

  private track(rec: CommandRecord): void {
    this.records.set(rec.id, rec);
    this.order.push(rec.id);
    while (this.order.length > this.cfg.execution.historySize) {
      const old = this.order.shift()!;
      if (!this.controllers.has(old)) this.records.delete(old);
    }
  }

  get(id: string): CommandRecord {
    const r = this.records.get(id);
    if (!r) throw new VBoxMcpError('NOT_FOUND', `Unknown command id ${id}.`);
    return r;
  }

  history(vm?: VmRef, limit = 50): CommandRecord[] {
    return this.order
      .map((id) => this.records.get(id))
      .filter((r): r is CommandRecord => !!r && (!vm || r.vmUuid === vm.uuid))
      .slice(-limit)
      .reverse();
  }

  cancel(id: string): boolean {
    const c = this.controllers.get(id);
    if (!c) return false;
    c.abort();
    return true;
  }

  cancelAll(): number {
    let n = 0;
    for (const c of this.controllers.values()) {
      c.abort();
      n++;
    }
    return n;
  }

  get activeCount(): number {
    return this.controllers.size;
  }

  /** Starts a command and returns its record immediately (async mode). */
  start(req: RunCommandRequest): CommandRecord {
    const rec: CommandRecord = {
      id: randomUUID(),
      vmName: req.vm.name,
      vmUuid: req.vm.uuid,
      shell: req.shell,
      command: redactString(req.command),
      workingDirectory: req.cwd,
      status: 'queued',
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      truncated: false,
      tags: req.label ? [req.label] : undefined,
    };
    this.track(rec);
    const ctl = new AbortController();
    this.controllers.set(rec.id, ctl);
    void this.execute(rec, req, ctl).finally(() => this.controllers.delete(rec.id));
    return rec;
  }

  /** Runs a command to completion. */
  async run(req: RunCommandRequest): Promise<CommandRecord> {
    const rec = this.start(req);
    await this.waitFor(rec.id);
    return this.get(rec.id);
  }

  async waitFor(id: string, timeoutMs = Number.MAX_SAFE_INTEGER): Promise<CommandRecord> {
    const start = Date.now();
    for (;;) {
      const r = this.get(id);
      if (!this.controllers.has(id) && r.status !== 'queued' && r.status !== 'running') return r;
      if (Date.now() - start > timeoutMs) return r;
      await new Promise((res) => setTimeout(res, 100));
    }
  }

  private async execute(rec: CommandRecord, req: RunCommandRequest, ctl: AbortController): Promise<void> {
    const release = await this.semaphore.acquire();
    try {
      if (ctl.signal.aborted) {
        rec.status = 'cancelled';
        return;
      }
      rec.status = 'running';
      rec.startTime = new Date().toISOString();
      const conn = await this.connections.connect(req.vm, req.backend);
      const { shell, path } = await this.connections.resolveShell(conn, req.shell);
      rec.backend = conn.backend.name;
      rec.shell = shell;
      const script = wrapScript(shell, req.command, { cwd: req.cwd, env: req.env });
      const inv = buildInvocation(shell, script, path);
      const r = await conn.backend.exec({
        exe: inv.exe,
        args: inv.args,
        verbatimArgs: inv.verbatimArgs,
        timeoutMs: this.clampTimeout(req.timeoutMs),
        maxOutputBytes: this.cfg.execution.maximumOutputBytes,
        signal: ctl.signal,
        stdin: req.stdin,
        onOutput: (stream, chunk) => {
          // Live view for get_command_output while running (bounded).
          const max = this.cfg.execution.maximumOutputBytes;
          if (stream === 'stdout' && rec.stdout.length < max) rec.stdout += chunk.slice(0, max - rec.stdout.length);
          if (stream === 'stderr' && rec.stderr.length < max) rec.stderr += chunk.slice(0, max - rec.stderr.length);
        },
      });
      rec.stdout = redactString(r.stdout);
      rec.stderr = redactString(r.stderr);
      rec.exitCode = r.exitCode;
      rec.timedOut = r.timedOut;
      rec.truncated = r.truncated;
      rec.status = r.cancelled ? 'cancelled' : r.timedOut ? 'timeout' : r.exitCode === 0 ? 'completed' : 'failed';
    } catch (err) {
      const e = err instanceof VBoxMcpError ? err : new VBoxMcpError('COMMAND_EXECUTION_FAILED', (err as Error).message);
      rec.status = ctl.signal.aborted ? 'cancelled' : 'failed';
      rec.error = { code: e.code, message: redactString(e.message) };
      if (e.code === 'SSH_CONNECTION_FAILED' || e.code === 'WINRM_CONNECTION_FAILED') await this.connections.invalidate(req.vm);
    } finally {
      rec.completionTime = new Date().toISOString();
      rec.durationMs = rec.startTime ? Date.parse(rec.completionTime) - Date.parse(rec.startTime) : 0;
      release();
    }
  }

  async guestTempDir(conn: ResolvedConnection): Promise<string> {
    const cached = this.tempDirs.get(conn.vm.uuid);
    if (cached) return cached;
    let dir = '/tmp';
    if (conn.os === 'windows') {
      const r = await conn.backend.exec({ exe: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/c', '"echo %TEMP%"'], verbatimArgs: true, timeoutMs: 20000, maxOutputBytes: 4096 });
      dir = r.stdout.trim().split(/\r?\n/).pop()?.trim() || 'C:\\Windows\\Temp';
    }
    this.tempDirs.set(conn.vm.uuid, dir);
    return dir;
  }

  /**
   * Executes a script file: the script is written to a guest temp file through the backend's file
   * channel, executed with the requested shell/interpreter, and removed afterwards.
   */
  async runScript(req: ScriptRequest): Promise<CommandRecord> {
    const conn = await this.connections.connect(req.vm, req.backend);
    const { shell } = await this.connections.resolveShell(conn, req.shell);
    const tmp = await this.guestTempDir(conn);
    const sep = conn.os === 'windows' ? '\\' : '/';
    const ext = req.interpreter === 'python' ? '.py' : scriptExtension(shell);
    const path = `${tmp}${sep}vboxmcp-${randomUUID().slice(0, 12)}${ext}`;
    const body = conn.os === 'windows' && ext !== '.ps1' ? req.script.replace(/(?<!\r)\n/g, '\r\n') : req.script;
    await conn.backend.writeFile(path, Buffer.from(ext === '.ps1' ? '\uFEFF' + body : body, 'utf8'));
    const args = req.args ?? [];
    let command: string;
    if (req.interpreter === 'python') {
      command =
        conn.os === 'windows'
          ? `$py = (Get-Command python, python3, py -ErrorAction SilentlyContinue | Select-Object -First 1).Source; if (-not $py) { Write-Error 'Python interpreter not found in guest'; exit 127 }; try { & $py ${quotePwsh(path)} ${args.map(quotePwsh).join(' ')} } finally { Remove-Item -LiteralPath ${quotePwsh(path)} -Force -ErrorAction SilentlyContinue }`
          : `PY=$(command -v python3 || command -v python) || { echo 'Python interpreter not found in guest' >&2; rm -f ${quotePosix(path)}; exit 127; }; "$PY" ${quotePosix(path)} ${args.map(quotePosix).join(' ')}; rc=$?; rm -f ${quotePosix(path)}; exit $rc`;
    } else if (shell === 'bash' || shell === 'sh') {
      command = `${shell} ${quotePosix(path)} ${args.map(quotePosix).join(' ')}; rc=$?; rm -f ${quotePosix(path)}; exit $rc`;
    } else if (shell === 'cmd') {
      if (args.some((a) => /["%^&|<>]/.test(a))) throw new VBoxMcpError('INVALID_ARGUMENT', 'CMD script arguments may not contain " % ^ & | < >.');
      command = `call "${path}" ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;
    } else {
      command = `try { & ${quotePwsh(path)} ${args.map(quotePwsh).join(' ')} } finally { Remove-Item -LiteralPath ${quotePwsh(path)} -Force -ErrorAction SilentlyContinue }`;
    }
    const effectiveShell: ShellKind = req.interpreter === 'python' ? (conn.os === 'windows' ? 'powershell' : 'sh') : shell;
    const rec = await this.run({ ...req, shell: effectiveShell, command });
    if (shell === 'cmd' && !req.interpreter) {
      // cmd cannot reliably clean up in the same line while preserving the script's exit code.
      await conn.backend.exec({ exe: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/c', `"del /f /q "${path}""`], verbatimArgs: true, timeoutMs: 20000, maxOutputBytes: 4096 }).catch(() => undefined);
    }
    return rec;
  }
}

/** Slices output for pagination. */
export function pageOutput(text: string, offset = 0, limit = 65536): { content: string; offset: number; nextOffset: number | null; totalLength: number } {
  const content = text.slice(offset, offset + limit);
  const next = offset + content.length;
  return { content, offset, nextOffset: next < text.length ? next : null, totalLength: text.length };
}
