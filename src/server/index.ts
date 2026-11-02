import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from '../tools/index.js';
import { disposeContext, type AppContext } from './context.js';
import { VERSION } from '../version.js';

export function createServer(ctx: AppContext): McpServer {
  const server = new McpServer({ name: 'virtualbox-mcp', version: VERSION });
  registerTools(server, ctx);
  return server;
}

/** Serves MCP over stdio until the client disconnects or the process is signalled. */
export async function serveStdio(ctx: AppContext): Promise<void> {
  const server = createServer(ctx);
  const transport = new StdioServerTransport();

  let closing = false;
  const shutdown = async (reason: string) => {
    if (closing) return;
    closing = true;
    ctx.logger.info({ reason }, 'shutting down');
    await disposeContext(ctx).catch((err) => ctx.logger.error({ err }, 'cleanup failed'));
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.stdin.on('end', () => void shutdown('stdin closed'));

  await server.connect(transport);
  const inst = await ctx.vbox.getInstallation();
  ctx.logger.info({ vboxManage: inst.executablePath, version: inst.version, found: inst.found }, 'virtualbox-mcp ready on stdio');
}
