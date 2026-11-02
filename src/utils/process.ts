import { spawn, type ChildProcess } from 'node:child_process';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  input?: string | Buffer;
  signal?: AbortSignal;
}

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  durationMs: number;
}

/**
 * Collects output up to a byte limit. Bytes beyond the limit are counted but dropped.
 */
export class BoundedBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  totalBytes = 0;
  truncated = false;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.totalBytes += chunk.length;
    if (this.size >= this.limit) {
      this.truncated = true;
      return;
    }
    const room = this.limit - this.size;
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (part.length < chunk.length) this.truncated = true;
    this.chunks.push(part);
    this.size += part.length;
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/**
 * Spawns an executable with an argument array. Never uses a shell, so arguments are never
 * re-interpreted by the host.
 */
export function runProcess(file: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  const limit = opts.maxOutputBytes ?? 4 * 1024 * 1024;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(file, [...args], {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }
    const out = new BoundedBuffer(limit);
    const err = new BoundedBuffer(limit);
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const kill = () => {
      if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, opts.timeoutMs)
      : undefined;
    const onAbort = () => {
      cancelled = true;
      kill();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.on('close', (code, sig) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode: code,
        signal: sig,
        stdout: out.toString(),
        stderr: err.toString(),
        timedOut,
        cancelled,
        truncated: out.truncated || err.truncated,
        durationMs: Date.now() - started,
      });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}
