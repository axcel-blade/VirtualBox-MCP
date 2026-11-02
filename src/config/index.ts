import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConfigSchema, type Config } from './schema.js';
import { VBoxMcpError } from '../core/errors.js';

export * from './schema.js';

type Env = Record<string, string | undefined>;

function bool(v: string | undefined): boolean | undefined {
  if (v === undefined || v === '') return undefined;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function int(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function setIfDefined(target: Record<string, any>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

/** Applies VBOX_MCP_* environment overrides on top of a raw (unvalidated) config object. */
export function applyEnvOverrides(raw: Record<string, any>, env: Env): Record<string, any> {
  const out = structuredClone(raw);
  out.virtualbox ??= {};
  out.transport ??= {};
  out.execution ??= {};
  out.security ??= {};
  out.terminal ??= {};
  out.files ??= {};
  setIfDefined(out.virtualbox, 'executablePath', env.VBOX_MCP_VBOXMANAGE_PATH || undefined);
  setIfDefined(out.virtualbox, 'defaultVmDirectory', env.VBOX_MCP_VM_DIRECTORY || undefined);
  setIfDefined(out.transport, 'stdio', bool(env.VBOX_MCP_STDIO));
  setIfDefined(out.transport, 'http', bool(env.VBOX_MCP_HTTP));
  setIfDefined(out.transport, 'httpPort', int(env.VBOX_MCP_HTTP_PORT));
  setIfDefined(out.transport, 'httpHost', env.VBOX_MCP_HTTP_HOST || undefined);
  setIfDefined(out.transport, 'httpToken', env.VBOX_MCP_HTTP_TOKEN || undefined);
  setIfDefined(out.transport, 'tlsCertPath', env.VBOX_MCP_TLS_CERT || undefined);
  setIfDefined(out.transport, 'tlsKeyPath', env.VBOX_MCP_TLS_KEY || undefined);
  setIfDefined(out.execution, 'defaultTimeout', int(env.VBOX_MCP_DEFAULT_TIMEOUT));
  setIfDefined(out.execution, 'maximumTimeout', int(env.VBOX_MCP_MAX_TIMEOUT));
  setIfDefined(out.execution, 'maximumConcurrentCommands', int(env.VBOX_MCP_MAX_CONCURRENT));
  setIfDefined(out.execution, 'maximumOutputBytes', int(env.VBOX_MCP_MAX_OUTPUT_BYTES));
  setIfDefined(out.security, 'requireApprovalForDestructiveOperations', bool(env.VBOX_MCP_REQUIRE_APPROVAL));
  setIfDefined(out.security, 'allowOrdinaryGuestModifications', bool(env.VBOX_MCP_ALLOW_GUEST_MODIFICATIONS));
  setIfDefined(out.terminal, 'maximumSessions', int(env.VBOX_MCP_MAX_SESSIONS));
  if (env.VBOX_MCP_STAGING_DIRS) out.files.stagingDirectories = env.VBOX_MCP_STAGING_DIRS.split(/[;,]/).filter(Boolean);
  setIfDefined(out, 'stateDir', env.VBOX_MCP_STATE_DIR || undefined);
  setIfDefined(out, 'logLevel', env.VBOX_MCP_LOG_LEVEL || undefined);
  return out;
}

export function parseConfig(raw: unknown): Config {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new VBoxMcpError('INVALID_CONFIGURATION', `Invalid configuration: ${issues.join('; ')}`, { issues });
  }
  const cfg = result.data;
  if (cfg.transport.http && !cfg.transport.httpToken) {
    throw new VBoxMcpError(
      'INVALID_CONFIGURATION',
      'HTTP transport requires an authentication token (transport.httpToken or VBOX_MCP_HTTP_TOKEN).',
    );
  }
  if (cfg.transport.httpToken && cfg.transport.httpToken.length < 16) {
    throw new VBoxMcpError('INVALID_CONFIGURATION', 'transport.httpToken must be at least 16 characters.');
  }
  if (cfg.execution.defaultTimeout > cfg.execution.maximumTimeout) {
    throw new VBoxMcpError('INVALID_CONFIGURATION', 'execution.defaultTimeout must not exceed execution.maximumTimeout.');
  }
  return cfg;
}

export function resolveStateDir(cfg: Config): string {
  const dir = cfg.stateDir === 'auto' ? join(homedir(), '.virtualbox-mcp') : resolve(cfg.stateDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function loadConfig(env: Env = process.env, explicitPath?: string): Config {
  const candidates = [explicitPath, env.VBOX_MCP_CONFIG, join(process.cwd(), 'virtualbox-mcp.config.json'), join(homedir(), '.virtualbox-mcp', 'config.json')];
  let raw: Record<string, any> = {};
  for (const p of candidates) {
    if (p && existsSync(p)) {
      try {
        raw = JSON.parse(readFileSync(p, 'utf8'));
      } catch (err) {
        throw new VBoxMcpError('INVALID_CONFIGURATION', `Could not parse config file ${p}: ${(err as Error).message}`);
      }
      break;
    }
  }
  return parseConfig(applyEnvOverrides(raw, env));
}
