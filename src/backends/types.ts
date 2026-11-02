export type BackendName = 'guestcontrol' | 'ssh' | 'winrm';
export type GuestOsFamily = 'linux' | 'windows';

export interface ExecRequest {
  /** Absolute path (guestcontrol needs one) or program name of the guest executable. */
  exe: string;
  args: string[];
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  stdin?: Buffer | string;
  /** cmd.exe needs its command line passed verbatim (guestcontrol --unquoted-args). */
  verbatimArgs?: boolean;
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface ShellChannel {
  write(data: string): void;
  onData(cb: (stream: 'stdout' | 'stderr', chunk: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  resize?(cols: number, rows: number): void;
  interrupt(): void;
  close(): void;
  readonly supportsResize: boolean;
  readonly pty: boolean;
}

export interface OpenShellRequest {
  exe: string;
  args: string[];
  cols: number;
  rows: number;
  /** Ask for a pseudo-terminal where the backend supports one (SSH). */
  pty: boolean;
}

export interface GuestBackend {
  readonly name: BackendName;
  readonly os: GuestOsFamily;
  exec(req: ExecRequest): Promise<ExecResult>;
  readFile(path: string, maxBytes: number): Promise<Buffer>;
  writeFile(path: string, data: Buffer): Promise<void>;
  /** Host → guest copy of a file or directory tree. */
  upload(hostPath: string, guestPath: string, opts: { recursive: boolean; onProgress?: (bytes: number) => void; signal?: AbortSignal }): Promise<void>;
  /** Guest → host copy of a file or directory tree. */
  download(guestPath: string, hostPath: string, opts: { recursive: boolean; onProgress?: (bytes: number) => void; signal?: AbortSignal }): Promise<void>;
  openShell(req: OpenShellRequest): Promise<ShellChannel>;
  close(): Promise<void>;
}

export interface GuestCredentials {
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  domain?: string;
}
