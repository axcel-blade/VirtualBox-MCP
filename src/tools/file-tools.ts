import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../server/context.js';
import { approvalArg, defineTool, vmArg } from './helpers.js';

export function registerFileTools(server: McpServer, ctx: AppContext): void {
  const { files } = ctx;

  defineTool(server, ctx, 'list_guest_files', {
    description: 'List a directory in the guest.',
    category: 'read',
    input: { vm: vmArg, path: z.string(), showHidden: z.boolean().default(false) },
  }, async (a, h) => {
    const vm = await h.resolveVm(a.vm);
    await h.authorize({ category: 'read', vm, description: `List ${a.path}` });
    return files.list(vm, a.path, { showHidden: a.showHidden });
  });

  defineTool(server, ctx, 'read_guest_file', {
    description: 'Read a file from the guest.',
    category: 'read',
    input: { vm: vmArg, path: z.string(), maxBytes: z.number().int().positive().optional(), encoding: z.enum(['utf8', 'base64']).default('utf8') },
  }, async (a, h) => {
    const vm = await h.resolveVm(a.vm);
    await h.authorize({ category: 'read', vm, description: `Read ${a.path}` });
    return files.read(vm, a.path, { maxBytes: a.maxBytes, encoding: a.encoding });
  });

  defineTool(server, ctx, 'write_guest_file', {
    description: 'Write (or append to) a file in the guest. Protected system paths need approval.',
    category: 'modify',
    input: {
      vm: vmArg,
      path: z.string(),
      content: z.string(),
      encoding: z.enum(['utf8', 'base64']).default('utf8'),
      append: z.boolean().default(false),
      createParents: z.boolean().default(false),
      approvalId: approvalArg,
    },
  }, async (a, h) => {
    const vm = await h.resolveVm(a.vm);
    const { path, os } = await files.guestPath(vm, a.path);
    await h.authorize({
      category: files.isProtected(path, os) ? 'destructive' : 'modify',
      capability: 'fileWrite',
      vm,
      description: `${a.append ? 'Append to' : 'Write'} ${path}`,
      payload: { vm: vm.uuid, path, append: a.append, bytes: a.content.length },
      approvalId: a.approvalId,
    });
    return files.write(vm, path, a.content, { encoding: a.encoding, append: a.append, createParents: a.createParents });
  });

  defineTool(server, ctx, 'delete_guest_file', {
    description: 'Delete a file or directory in the guest. Recursive deletes and protected system paths need approval.',
    category: 'modify',
    input: { vm: vmArg, path: z.string(), recursive: z.boolean().default(false), directory: z.boolean().default(false), approvalId: approvalArg },
  }, async (a, h) => {
    const vm = await h.resolveVm(a.vm);
    const { path, os } = await files.guestPath(vm, a.path);
    await h.authorize({
      category: files.isProtected(path, os) || a.recursive ? 'destructive' : 'modify',
      capability: 'fileWrite',
      vm,
      description: `Delete ${path}${a.recursive ? ' (recursive)' : ''}`,
      payload: { vm: vm.uuid, path, recursive: a.recursive },
      approvalId: a.approvalId,
    });
    return { deleted: await files.remove(vm, path, { recursive: a.recursive, directory: a.directory }) };
  });
}
