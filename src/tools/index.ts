import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../server/context.js';
import { registerVmTools } from './vm-tools.js';
import { registerExecTools } from './exec-tools.js';
import { registerFileTools } from './file-tools.js';

export function registerTools(server: McpServer, ctx: AppContext): void {
  registerVmTools(server, ctx);
  registerExecTools(server, ctx);
  registerFileTools(server, ctx);
}
