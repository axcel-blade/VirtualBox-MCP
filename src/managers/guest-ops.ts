import type { ShellKind } from '../config/schema.js';
import { VBoxMcpError } from '../core/errors.js';
import type { VmRef } from '../security/security-manager.js';
import type { ConnectionManager } from './connection-manager.js';
import type { ExecutionManager, CommandRecord } from './execution-manager.js';
import type { GuestOsFamily } from '../backends/types.js';

/** Helper for managers that implement features as guest commands. */
export class GuestOps {
  constructor(readonly connections: ConnectionManager, readonly exec: ExecutionManager) {}

  async os(vm: VmRef): Promise<GuestOsFamily> {
    return (await this.connections.detectOs(vm)).os;
  }

  /** Runs a command in the OS-appropriate system shell: POSIX sh on Linux, Windows PowerShell on Windows. */
  async run(vm: VmRef, linux: string | null, windows: string | null, opts: { timeoutMs?: number; label?: string; shell?: ShellKind } = {}): Promise<CommandRecord & { os: GuestOsFamily }> {
    const os = await this.os(vm);
    const command = os === 'windows' ? windows : linux;
    if (command === null) throw new VBoxMcpError('INVALID_ARGUMENT', `This operation is not supported on ${os} guests.`);
    const rec = await this.exec.run({ vm, command, shell: opts.shell ?? (os === 'windows' ? 'powershell' : 'sh'), timeoutMs: opts.timeoutMs, label: opts.label });
    return { ...rec, os };
  }

  /** Like run(), but throws on failure and returns stdout. */
  async output(vm: VmRef, linux: string | null, windows: string | null, opts: { timeoutMs?: number; label?: string; allowExit?: number[] } = {}): Promise<string> {
    const r = await this.run(vm, linux, windows, opts);
    if (r.error) throw new VBoxMcpError(r.error.code as never, r.error.message);
    if (r.status === 'timeout') throw new VBoxMcpError('COMMAND_TIMEOUT', `Guest command timed out (${opts.label ?? 'operation'}).`);
    if (r.exitCode !== 0 && !(opts.allowExit ?? []).includes(r.exitCode ?? -1)) {
      throw new VBoxMcpError('COMMAND_EXECUTION_FAILED', `Guest command failed with exit code ${r.exitCode}: ${(r.stderr || r.stdout).trim().slice(0, 4000)}`, { commandId: r.id });
    }
    return r.stdout;
  }

  async json<T = unknown>(vm: VmRef, windowsScript: string, opts: { timeoutMs?: number; label?: string } = {}): Promise<T> {
    const out = await this.output(vm, null, `${windowsScript} | ConvertTo-Json -Depth 6 -Compress`, opts);
    const text = out.trim();
    if (!text) return [] as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new VBoxMcpError('COMMAND_EXECUTION_FAILED', `Could not parse PowerShell JSON output: ${text.slice(0, 500)}`);
    }
  }
}

export function asArray<T>(v: T | T[] | null | undefined): T[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}
