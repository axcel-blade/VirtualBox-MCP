import { loadConfig, resolveStateDir, type Config } from '../config/index.js';
import { createLogger, AuditLog } from '../logging/index.js';
import { VBoxClient } from '../core/vbox-client.js';
import { SecurityManager } from '../security/security-manager.js';
import { CredentialStore } from '../security/credentials.js';
import { registerSecret } from '../security/redact.js';
import { VmManager } from '../managers/vm-manager.js';
import { ConnectionManager } from '../managers/connection-manager.js';
import { ExecutionManager } from '../managers/execution-manager.js';
import { GuestOps } from '../managers/guest-ops.js';
import { FileManager } from '../managers/file-manager.js';
import { TerminalManager } from '../managers/terminal-manager.js';
import type { Logger } from 'pino';

/** Every long-lived service the server needs, wired together once at startup. */
export interface AppContext {
  cfg: Config;
  stateDir: string;
  logger: Logger;
  audit: AuditLog;
  vbox: VBoxClient;
  security: SecurityManager;
  creds: CredentialStore;
  vms: VmManager;
  connections: ConnectionManager;
  exec: ExecutionManager;
  files: FileManager;
  terminals: TerminalManager;
}

export function createContext(configPath?: string, env: NodeJS.ProcessEnv = process.env): AppContext {
  const cfg = loadConfig(env, configPath);
  const stateDir = resolveStateDir(cfg);
  const logger = createLogger(cfg.logLevel);
  registerSecret(env.VBOX_MCP_MASTER_KEY);
  registerSecret(cfg.transport.httpToken);
  const audit = new AuditLog(stateDir);
  const vbox = new VBoxClient(cfg.virtualbox.executablePath, cfg.virtualbox.commandTimeout, logger);
  const security = new SecurityManager(cfg, stateDir);
  const creds = new CredentialStore(stateDir, env.VBOX_MCP_MASTER_KEY);
  const vms = new VmManager(vbox, cfg, security);
  const connections = new ConnectionManager(cfg, vbox, vms, creds, stateDir);
  const exec = new ExecutionManager(cfg, connections);
  const files = new FileManager(cfg, new GuestOps(connections, exec));
  const terminals = new TerminalManager(cfg, connections);
  return { cfg, stateDir, logger, audit, vbox, security, creds, vms, connections, exec, files, terminals };
}

export async function disposeContext(ctx: AppContext): Promise<void> {
  ctx.exec.cancelAll();
  ctx.terminals.closeAll();
  ctx.terminals.dispose();
  await ctx.connections.closeAll();
}
