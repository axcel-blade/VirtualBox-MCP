import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { toVBoxMcpError } from '../core/errors.js';
import { redact } from '../security/redact.js';
import type { AuthorizeRequest, Elicitor, OperationCategory, VmRef } from '../security/security-manager.js';
import type { AppContext } from '../server/context.js';

export const vmArg = z.string().min(1).describe('VM name or UUID');
export const approvalArg = z.string().optional().describe('Approval ID issued for a previously requested destructive operation');

export interface ToolHelpers {
  /** Checks policy (and asks for approval when needed). Throws when the operation is not allowed. */
  authorize(req: Omit<AuthorizeRequest, 'tool' | 'elicit'>): Promise<void>;
  resolveVm(idOrName: string): Promise<VmRef>;
}

type Shape = z.ZodRawShape;

/** Asks the connected client to confirm via MCP elicitation; undefined when it can't. */
function elicitorFor(server: McpServer): Elicitor {
  return async (message) => {
    try {
      const r = await server.server.elicitInput({
        message,
        requestedSchema: { type: 'object', properties: { approve: { type: 'boolean', title: 'Approve' } }, required: ['approve'] },
      });
      if (r.action !== 'accept') return false;
      return r.content?.approve === true;
    } catch {
      return undefined;
    }
  };
}

export function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(redact(value), null, 2) }] };
}

/**
 * Registers a tool whose handler is audited and whose errors come back as structured tool errors.
 * The handler is responsible for calling `h.authorize` with the right category before acting.
 */
export function defineTool<S extends Shape>(
  server: McpServer,
  ctx: AppContext,
  name: string,
  spec: { description: string; category: OperationCategory; input: S },
  handler: (args: z.infer<z.ZodObject<S>>, h: ToolHelpers) => Promise<unknown>,
): void {
  const elicit = elicitorFor(server);
  server.registerTool(name, { description: spec.description, inputSchema: spec.input }, (async (args: z.infer<z.ZodObject<S>>) => {
    const started = Date.now();
    let vmName: string | undefined;
    const h: ToolHelpers = {
      authorize: (req) => {
        vmName = req.vm?.name ?? vmName;
        return ctx.security.authorize({ ...req, tool: name, elicit });
      },
      resolveVm: async (idOrName) => {
        const vm = await ctx.vms.resolve(idOrName);
        vmName = vm.name;
        return vm;
      },
    };
    try {
      const result = await handler(args, h);
      ctx.audit.record({ tool: name, category: spec.category, vm: vmName, outcome: 'success', durationMs: Date.now() - started, args });
      return json(result);
    } catch (err) {
      const e = toVBoxMcpError(err);
      const outcome = e.code === 'PERMISSION_DENIED' || e.code === 'EMERGENCY_STOP_ACTIVE' ? 'denied' : e.code === 'APPROVAL_REQUIRED' ? 'approval_required' : 'error';
      ctx.audit.record({ tool: name, category: spec.category, vm: vmName, outcome, durationMs: Date.now() - started, args, error: e.message });
      return { ...json(e.toJSON()), isError: true };
    }
  }) as never);
}
