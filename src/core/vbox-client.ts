import { spawn, type ChildProcess } from 'node:child_process';
import { runProcess, type RunResult } from '../utils/process.js';
import { VBoxMcpError, type ErrorCode } from './errors.js';
import { detectVBoxManage, MIN_SUPPORTED_MAJOR, type VBoxInstallation } from '../platforms/detect.js';
import { redactString } from '../security/redact.js';
import type { Logger } from 'pino';

export interface VBoxRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  input?: string;
  /** Do not throw on a non-zero exit code. */
  allowFailure?: boolean;
  errorCode?: ErrorCode;
  maxOutputBytes?: number;
}

export type VBoxRunner = (args: readonly string[], opts: VBoxRunOptions) => Promise<RunResult>;

/**
 * Thin, safe wrapper around the VBoxManage CLI. Every invocation uses an argument array; nothing
 * is passed through a host shell.
 */
export class VBoxClient {
  private installation: VBoxInstallation | undefined;
  private runner: VBoxRunner | undefined;

  constructor(
    private readonly executableOverride: string,
    private readonly defaultTimeoutMs: number,
    private readonly logger?: Logger,
    runner?: VBoxRunner,
  ) {
    this.runner = runner;
  }

  async init(): Promise<VBoxInstallation> {
    if (this.installation) return this.installation;
    if (this.runner) {
      // Injected runner (tests): ask it for the version.
      const r = await this.runner(['--version'], {});
      const m = r.stdout.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
      this.installation = { found: true, executablePath: 'VBoxManage', version: m ? `${m[1]}.${m[2]}.${m[3]}` : r.stdout.trim(), major: Number(m?.[1] ?? 7), minor: Number(m?.[2] ?? 0), candidatesChecked: [] };
      return this.installation;
    }
    this.installation = await detectVBoxManage(this.executableOverride);
    return this.installation;
  }

  async getInstallation(): Promise<VBoxInstallation> {
    return this.init();
  }

  private async ensure(): Promise<VBoxRunner> {
    const inst = await this.init();
    if (!inst.found || !inst.executablePath) {
      throw new VBoxMcpError('VBOX_NOT_INSTALLED', 'VBoxManage was not found. Install VirtualBox or set virtualbox.executablePath / VBOX_MCP_VBOXMANAGE_PATH.', {
        candidatesChecked: inst.candidatesChecked,
      });
    }
    if ((inst.major ?? 0) < MIN_SUPPORTED_MAJOR) {
      throw new VBoxMcpError('VBOX_VERSION_UNSUPPORTED', `VirtualBox ${inst.version} is not supported (minimum ${MIN_SUPPORTED_MAJOR}.0).`);
    }
    if (!this.runner) {
      const exe = inst.executablePath;
      this.runner = (args, o) => runProcess(exe, args, { timeoutMs: o.timeoutMs, signal: o.signal, input: o.input, maxOutputBytes: o.maxOutputBytes });
    }
    return this.runner;
  }

  async run(args: readonly string[], opts: VBoxRunOptions = {}): Promise<RunResult> {
    const runner = await this.ensure();
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    this.logger?.debug({ args: args.map(redactString) }, 'VBoxManage');
    let result: RunResult;
    try {
      result = await runner(args, { ...opts, timeoutMs });
    } catch (err) {
      throw new VBoxMcpError('VBOX_NOT_INSTALLED', `Failed to launch VBoxManage: ${(err as Error).message}`);
    }
    if (result.timedOut) {
      throw new VBoxMcpError('COMMAND_TIMEOUT', `VBoxManage ${args[0]} timed out after ${timeoutMs} ms.`);
    }
    if (result.cancelled) throw new VBoxMcpError('COMMAND_CANCELLED', `VBoxManage ${args[0]} was cancelled.`);
    if (result.exitCode !== 0 && !opts.allowFailure) {
      throw this.mapError(args, result, opts.errorCode);
    }
    return result;
  }

  /** Starts a long-lived VBoxManage process (persistent guest terminals). */
  async spawnLongLived(args: readonly string[]): Promise<ChildProcess> {
    await this.ensure();
    const exe = this.installation?.executablePath;
    if (!exe || exe === 'VBoxManage') throw new VBoxMcpError('VBOX_NOT_INSTALLED', 'Long-lived VBoxManage processes need a detected VBoxManage executable.');
    return spawn(exe, [...args], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  async out(args: readonly string[], opts: VBoxRunOptions = {}): Promise<string> {
    return (await this.run(args, opts)).stdout;
  }

  private mapError(args: readonly string[], r: RunResult, fallback: ErrorCode = 'VM_OPERATION_FAILED'): VBoxMcpError {
    const stderr = redactString(r.stderr.trim() || r.stdout.trim());
    let code: ErrorCode = fallback;
    if (/Could not find a registered machine|VBOX_E_OBJECT_NOT_FOUND.*machine/i.test(stderr)) code = 'VM_NOT_FOUND';
    else if (/is not currently running|not running|machine is not locked/i.test(stderr)) code = 'VM_NOT_RUNNING';
    else if (/is already locked|already running|session.*locked/i.test(stderr)) code = 'VM_ALREADY_RUNNING';
    else if (/guest additions?.*not|VERR_NOT_FOUND.*guest|Guest Additions are not installed|not ready/i.test(stderr) && args[0] === 'guestcontrol') code = 'GUEST_ADDITIONS_NOT_INSTALLED';
    else if (/VERR_AUTHENTICATION_FAILURE|authentication fail|The specified user was not able to logon/i.test(stderr)) code = 'GUEST_AUTHENTICATION_FAILED';
    else if (/VERR_DISK_FULL|not enough space/i.test(stderr)) code = 'DISK_SPACE_INSUFFICIENT';
    const sub = args.slice(0, 2).filter((a) => !a.startsWith('-')).join(' ');
    return new VBoxMcpError(code, `VBoxManage ${sub} failed (exit ${r.exitCode}): ${stderr.split('\n').slice(0, 8).join(' | ')}`, {
      exitCode: r.exitCode,
    });
  }
}
