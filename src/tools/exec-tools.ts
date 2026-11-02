import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ShellKind } from '../config/index.js';
import { assessCommand } from '../security/command-validation.js';
import { pageOutput, type CommandRecord } from '../managers/execution-manager.js';
import type { AppContext } from '../server/context.js';
import { approvalArg, defineTool, vmArg } from './helpers.js';

/** Status view of a command without its (potentially large) output. */
function summary({ stdout, stderr, ...rest }: CommandRecord) {
  return { ...rest, stdoutBytes: stdout.length, stderrBytes: stderr.length };
}

export function registerExecTools(server: McpServer, ctx: AppContext): void {
  const { exec, connections } = ctx;

  const runInput = {
    vm: vmArg,
    command: z.string().min(1),
    shell: ShellKind.optional().describe("Defaults to the guest's default shell"),
    backend: z.enum(['auto', 'guestcontrol', 'ssh', 'winrm']).default('auto'),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.number().int().positive().optional(),
    approvalId: approvalArg,
  };

  for (const background of [false, true]) {
    defineTool(server, ctx, background ? 'execute_command_async' : 'execute_command', {
      description: background
        ? 'Start a command in the guest and return immediately with a command ID (poll with get_command_status).'
        : 'Run a command in the guest OS and wait for its result.',
      category: 'modify',
      input: runInput,
    }, async (a, h) => {
      const vm = await h.resolveVm(a.vm);
      const assessment = assessCommand(a.command, a.shell ?? 'bash');
      await h.authorize({
        category: assessment.destructive ? 'destructive' : 'modify',
        capability: 'execution',
        vm,
        shell: a.shell,
        description: `Run: ${a.command}`,
        reasons: assessment.reasons,
        payload: { vm: vm.uuid, command: a.command, shell: a.shell },
        approvalId: a.approvalId,
      });
      const req = { vm, command: a.command, shell: a.shell, backend: a.backend, cwd: a.cwd, env: a.env, timeoutMs: a.timeoutMs };
      return background ? summary(exec.start(req)) : exec.run(req);
    });
  }

  defineTool(server, ctx, 'get_command_status', {
    description: 'Status of a command started earlier (output sizes only; use get_command_output for content).',
    category: 'read',
    input: { id: z.string() },
  }, async (a, h) => {
    await h.authorize({ category: 'read', description: 'Read command status' });
    return summary(exec.get(a.id));
  });

  defineTool(server, ctx, 'get_command_output', {
    description: "Page through a command's stdout or stderr.",
    category: 'read',
    input: {
      id: z.string(),
      stream: z.enum(['stdout', 'stderr']).default('stdout'),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().positive().max(1048576).default(65536),
    },
  }, async (a, h) => {
    await h.authorize({ category: 'read', description: 'Read command output' });
    return pageOutput(exec.get(a.id)[a.stream], a.offset, a.limit);
  });

  defineTool(server, ctx, 'wait_for_command', {
    description: 'Wait for an async command to finish and return its result.',
    category: 'read',
    input: { id: z.string(), timeoutMs: z.number().int().positive().max(600000).default(60000) },
  }, async (a, h) => {
    await h.authorize({ category: 'read', description: 'Wait for command' });
    return exec.waitFor(a.id, a.timeoutMs);
  });

  defineTool(server, ctx, 'get_command_history', {
    description: 'Recent commands, optionally for one VM.',
    category: 'read',
    input: { vm: vmArg.optional(), limit: z.number().int().positive().max(500).default(50) },
  }, async (a, h) => {
    const vm = a.vm ? await h.resolveVm(a.vm) : undefined;
    await h.authorize({ category: 'read', vm, description: 'Read command history' });
    return exec.history(vm, a.limit).map(summary);
  });

  defineTool(server, ctx, 'cancel_command', {
    description: 'Cancel a running command.',
    category: 'modify',
    input: { id: z.string() },
  }, async (a, h) => {
    // Stopping work is always allowed, even under emergency stop.
    await h.authorize({ category: 'read', description: 'Cancel command' });
    return { id: a.id, cancelled: exec.cancel(a.id) };
  });

  defineTool(server, ctx, 'detect_guest_os', {
    description: 'Detect the guest OS family and Guest Additions status.',
    category: 'read',
    input: { vm: vmArg },
  }, async (a, h) => {
    const vm = await h.resolveVm(a.vm);
    await h.authorize({ category: 'read', vm, description: 'Detect guest OS' });
    const [os, guestAdditions] = await Promise.all([connections.detectOs(vm), connections.guestAdditionsStatus(vm)]);
    return { vm: vm.name, ...os, guestAdditions };
  });

  defineTool(server, ctx, 'list_available_shells', {
    description: 'Shells available in the guest.',
    category: 'read',
    input: { vm: vmArg, refresh: z.boolean().default(false) },
  }, async (a, h) => {
    const vm = await h.resolveVm(a.vm);
    await h.authorize({ category: 'read', vm, capability: 'execution', description: 'Detect shells' });
    return connections.detectShells(await connections.connect(vm), a.refresh);
  });
}
