import { z } from 'zod';

export const BackendKind = z.enum(['auto', 'guestcontrol', 'ssh', 'winrm']);
export type BackendKind = z.infer<typeof BackendKind>;

export const ShellKind = z.enum(['bash', 'sh', 'powershell', 'pwsh', 'cmd']);
export type ShellKind = z.infer<typeof ShellKind>;

export const AccessLevel = z.enum(['none', 'read', 'modify', 'full']);
export type AccessLevel = z.infer<typeof AccessLevel>;

export const VmPolicySchema = z.object({
  /** none: invisible; read: inspection only; modify: ordinary changes; full: also destructive (still needs approval). */
  access: AccessLevel.default('modify'),
  allowExecution: z.boolean().default(true),
  allowLifecycle: z.boolean().default(true),
  allowFileWrite: z.boolean().default(true),
  allowedShells: z.array(ShellKind).optional(),
  /** Executables (basename) that may never be invoked inside the guest. */
  deniedExecutables: z.array(z.string()).default([]),
});
export type VmPolicy = z.infer<typeof VmPolicySchema>;

export const GuestConnectionSchema = z.object({
  backend: BackendKind.default('auto'),
  os: z.enum(['auto', 'linux', 'windows']).default('auto'),
  username: z.string().optional(),
  /** Name of an environment variable holding the password. */
  passwordEnv: z.string().optional(),
  /** Key in the encrypted credential store. */
  credentialRef: z.string().optional(),
  domain: z.string().optional(),
  ssh: z
    .object({
      host: z.string().optional(),
      port: z.number().int().positive().default(22),
      privateKeyPath: z.string().optional(),
      passphraseEnv: z.string().optional(),
      /** SHA256 fingerprint ("SHA256:...") of the expected host key. */
      hostKeyFingerprint: z.string().optional(),
    })
    .optional(),
  winrm: z
    .object({
      host: z.string().optional(),
      port: z.number().int().positive().optional(),
      https: z.boolean().default(false),
      /** Only for self-signed lab certificates; never enabled automatically. */
      rejectUnauthorized: z.boolean().default(true),
      path: z.string().default('/wsman'),
    })
    .optional(),
  defaultShell: ShellKind.optional(),
});
export type GuestConnection = z.infer<typeof GuestConnectionSchema>;

export const ConfigSchema = z.object({
  virtualbox: z
    .object({
      executablePath: z.string().default('auto'),
      defaultVmDirectory: z.string().default('auto'),
      commandTimeout: z.number().int().positive().default(120000),
    })
    .default({ executablePath: 'auto', defaultVmDirectory: 'auto', commandTimeout: 120000 }),
  transport: z
    .object({
      stdio: z.boolean().default(true),
      http: z.boolean().default(false),
      httpPort: z.number().int().positive().default(3000),
      httpHost: z.string().default('127.0.0.1'),
      httpToken: z.string().optional(),
      tlsCertPath: z.string().optional(),
      tlsKeyPath: z.string().optional(),
      rateLimitPerMinute: z.number().int().positive().default(300),
      allowedOrigins: z.array(z.string()).default([]),
    })
    .default({ stdio: true, http: false, httpPort: 3000, httpHost: '127.0.0.1', rateLimitPerMinute: 300, allowedOrigins: [] }),
  execution: z
    .object({
      defaultBackend: BackendKind.default('auto'),
      defaultTimeout: z.number().int().positive().default(60000),
      maximumTimeout: z.number().int().positive().default(600000),
      maximumConcurrentCommands: z.number().int().positive().default(5),
      maximumOutputBytes: z.number().int().positive().default(1048576),
      historySize: z.number().int().positive().default(500),
    })
    .default({
      defaultBackend: 'auto',
      defaultTimeout: 60000,
      maximumTimeout: 600000,
      maximumConcurrentCommands: 5,
      maximumOutputBytes: 1048576,
      historySize: 500,
    }),
  security: z
    .object({
      readOnlyAutoApproval: z.boolean().default(true),
      allowOrdinaryGuestModifications: z.boolean().default(true),
      requireApprovalForDestructiveOperations: z.boolean().default(true),
      allowHostExecution: z.literal(false).default(false),
      defaultVmPolicy: VmPolicySchema.default({
        access: 'modify',
        allowExecution: true,
        allowLifecycle: true,
        allowFileWrite: true,
        deniedExecutables: [],
      }),
      approvalTtlMs: z.number().int().positive().default(15 * 60 * 1000),
      maxToolCallsPerMinute: z.number().int().positive().default(240),
    })
    .default({
      readOnlyAutoApproval: true,
      allowOrdinaryGuestModifications: true,
      requireApprovalForDestructiveOperations: true,
      allowHostExecution: false,
      defaultVmPolicy: { access: 'modify', allowExecution: true, allowLifecycle: true, allowFileWrite: true, deniedExecutables: [] },
      approvalTtlMs: 900000,
      maxToolCallsPerMinute: 240,
    }),
  terminal: z
    .object({
      persistentSessions: z.boolean().default(true),
      sessionTimeout: z.number().int().positive().default(3600000),
      maximumSessions: z.number().int().positive().default(10),
      bufferBytes: z.number().int().positive().default(1048576),
    })
    .default({ persistentSessions: true, sessionTimeout: 3600000, maximumSessions: 10, bufferBytes: 1048576 }),
  files: z
    .object({
      /** Host directories the server may read from / write to. Everything else is refused. */
      stagingDirectories: z.array(z.string()).default([]),
      maxTransferBytes: z.number().int().positive().default(2 * 1024 * 1024 * 1024),
      maxInlineReadBytes: z.number().int().positive().default(1048576),
      protectedGuestPaths: z.array(z.string()).default([]),
    })
    .default({ stagingDirectories: [], maxTransferBytes: 2147483648, maxInlineReadBytes: 1048576, protectedGuestPaths: [] }),
  orchestration: z
    .object({
      maxWorkflowSteps: z.number().int().positive().default(50),
      maxRetries: z.number().int().nonnegative().default(3),
      maxWorkflowDurationMs: z.number().int().positive().default(3600000),
      maxParallelVms: z.number().int().positive().default(4),
    })
    .default({ maxWorkflowSteps: 50, maxRetries: 3, maxWorkflowDurationMs: 3600000, maxParallelVms: 4 }),
  stateDir: z.string().default('auto'),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Per-VM settings, keyed by VM name or UUID. */
  vms: z
    .record(
      z.string(),
      z.object({
        policy: VmPolicySchema.partial().optional(),
        connection: GuestConnectionSchema.optional(),
        tags: z.array(z.string()).default([]),
      }),
    )
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
