#!/usr/bin/env node
import { createContext } from './server/context.js';
import { serveStdio } from './server/index.js';
import { MIN_SUPPORTED_MAJOR } from './platforms/detect.js';
import { toVBoxMcpError } from './core/errors.js';
import { VERSION } from './version.js';

const USAGE = `virtualbox-mcp ${VERSION}

Usage: virtualbox-mcp [command] [--config <path>]

Commands:
  serve    Run the MCP server over stdio (default)
  health   Check that VirtualBox and the configuration are usable
  stop     Activate the emergency stop (blocks all modifying operations)
  resume   Clear the emergency stop
  version  Print the version
  help     Show this message
`;

function parseArgs(argv: string[]): { command: string; configPath?: string } {
  let command = 'serve';
  let configPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--config' || a === '-c') configPath = argv[++i];
    else if (a.startsWith('--config=')) configPath = a.slice('--config='.length);
    else if (a === '--help' || a === '-h') command = 'help';
    else if (a === '--version' || a === '-v') command = 'version';
    else command = a;
  }
  return { command, configPath };
}

async function health(configPath?: string): Promise<number> {
  const ctx = createContext(configPath);
  const inst = await ctx.vbox.getInstallation();
  const supported = inst.found && (inst.major ?? 0) >= MIN_SUPPORTED_MAJOR;
  const checks = {
    version: VERSION,
    node: process.version,
    stateDir: ctx.stateDir,
    virtualbox: inst.found
      ? { found: true, path: inst.executablePath, version: inst.version, supported }
      : { found: false, candidatesChecked: inst.candidatesChecked },
    credentialStore: ctx.creds.available ? 'available' : 'unavailable (set VBOX_MCP_MASTER_KEY to enable)',
    emergencyStop: ctx.security.emergencyStopped,
  };
  let vmCount: number | undefined;
  if (supported) {
    try {
      vmCount = (await ctx.vms.list()).length;
    } catch (err) {
      process.stdout.write(`VM listing failed: ${toVBoxMcpError(err).message}\n`);
    }
  }
  process.stdout.write(`${JSON.stringify({ ...checks, visibleVms: vmCount, ok: supported && vmCount !== undefined }, null, 2)}\n`);
  return supported && vmCount !== undefined ? 0 : 1;
}

async function main(): Promise<number> {
  const { command, configPath } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'serve':
      await serveStdio(createContext(configPath));
      return -1; // keep running
    case 'health':
      return health(configPath);
    case 'stop':
      createContext(configPath).security.activateEmergencyStop('Activated from CLI');
      process.stdout.write('Emergency stop activated. Modifying operations are now blocked.\n');
      return 0;
    case 'resume':
      createContext(configPath).security.clearEmergencyStop();
      process.stdout.write('Emergency stop cleared.\n');
      return 0;
    case 'version':
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case 'help':
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
  }
}

main().then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (err) => {
    const e = toVBoxMcpError(err, 'INVALID_CONFIGURATION');
    process.stderr.write(`virtualbox-mcp: ${e.message}\n`);
    process.exit(1);
  },
);
