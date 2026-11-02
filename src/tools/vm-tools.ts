import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { VmRef } from '../security/security-manager.js';
import type { AppContext } from '../server/context.js';
import { approvalArg, defineTool, vmArg } from './helpers.js';

type VmAction = readonly [name: string, description: string, fn: (vm: VmRef) => Promise<string>];

export function registerVmTools(server: McpServer, ctx: AppContext): void {
  const { vms } = ctx;

  defineTool(server, ctx, 'list_vms', {
    description: 'List VirtualBox VMs visible under the current policy, optionally filtered.',
    category: 'read',
    input: {
      query: z.string().optional().describe('Substring matched against name, UUID, OS type, groups and tags'),
      state: z.string().optional().describe('e.g. running, poweroff, paused, saved'),
      group: z.string().optional(),
      tag: z.string().optional(),
    },
  }, async (a, h) => {
    await h.authorize({ category: 'read', description: 'List VMs' });
    return vms.list(a);
  });

  defineTool(server, ctx, 'list_running_vms', {
    description: 'List running VMs.',
    category: 'read',
    input: {},
  }, async (_a, h) => {
    await h.authorize({ category: 'read', description: 'List running VMs' });
    return vms.listRunning();
  });

  defineTool(server, ctx, 'get_vm_info', {
    description: 'Detailed configuration and state of one VM.',
    category: 'read',
    input: { vm: vmArg },
  }, async (a, h) => {
    const vm = await h.resolveVm(a.vm);
    await h.authorize({ category: 'read', vm, description: 'Inspect VM' });
    return vms.info(vm);
  });

  defineTool(server, ctx, 'get_vm_state', {
    description: 'Current power state of a VM.',
    category: 'read',
    input: { vm: vmArg },
  }, async (a, h) => {
    const vm = await h.resolveVm(a.vm);
    await h.authorize({ category: 'read', vm, description: 'Read VM state' });
    return { vm: vm.name, uuid: vm.uuid, state: await vms.state(vm) };
  });

  defineTool(server, ctx, 'get_host_info', {
    description: 'VirtualBox host information (CPU, memory, VirtualBox version).',
    category: 'read',
    input: {},
  }, async (_a, h) => {
    await h.authorize({ category: 'read', description: 'Read host info' });
    return vms.hostInfo();
  });

  defineTool(server, ctx, 'start_vm', {
    description: 'Start a VM.',
    category: 'modify',
    input: { vm: vmArg, type: z.enum(['headless', 'gui', 'separate']).default('headless') },
  }, async (a, h) => {
    const vm = await h.resolveVm(a.vm);
    await h.authorize({ category: 'modify', capability: 'lifecycle', vm, description: `Start VM (${a.type})` });
    return { vm: vm.name, state: await vms.start(vm, a.type) };
  });

  defineTool(server, ctx, 'shutdown_vm', {
    description: 'Gracefully shut down a VM (ACPI power button). Never forces power-off.',
    category: 'modify',
    input: { vm: vmArg, waitMs: z.number().int().min(0).max(600000).default(0).describe('How long to wait for power-off') },
  }, async (a, h) => {
    const vm = await h.resolveVm(a.vm);
    await h.authorize({ category: 'modify', capability: 'lifecycle', vm, description: 'Shut down VM' });
    return { vm: vm.name, ...(await vms.shutdown(vm, a.waitMs)) };
  });

  const modifying: VmAction[] = [
    ['pause_vm', 'Pause a running VM.', (vm) => vms.pause(vm)],
    ['resume_vm', 'Resume a paused VM.', (vm) => vms.resume(vm)],
    ['save_vm_state', 'Save the VM state to disk and stop it.', (vm) => vms.saveState(vm)],
  ];
  for (const [name, description, fn] of modifying) {
    defineTool(server, ctx, name, { description, category: 'modify', input: { vm: vmArg } }, async (a, h) => {
      const vm = await h.resolveVm(a.vm);
      await h.authorize({ category: 'modify', capability: 'lifecycle', vm, description });
      return { vm: vm.name, state: await fn(vm) };
    });
  }

  const destructive: VmAction[] = [
    ['poweroff_vm', 'Force power-off (like pulling the plug). Unsaved guest data is lost.', (vm) => vms.poweroff(vm)],
    ['reset_vm', 'Hard reset a VM. Unsaved guest data is lost.', (vm) => vms.reset(vm)],
    ['discard_saved_state', "Discard a VM's saved state.", (vm) => vms.discardState(vm)],
  ];
  for (const [name, description, fn] of destructive) {
    defineTool(server, ctx, name, { description, category: 'destructive', input: { vm: vmArg, approvalId: approvalArg } }, async (a, h) => {
      const vm = await h.resolveVm(a.vm);
      await h.authorize({ category: 'destructive', capability: 'lifecycle', vm, description, payload: { vm: vm.uuid }, approvalId: a.approvalId });
      return { vm: vm.name, state: await fn(vm) };
    });
  }

  defineTool(server, ctx, 'wait_for_vm_state', {
    description: 'Wait until a VM reaches one of the given states.',
    category: 'read',
    input: { vm: vmArg, states: z.array(z.string()).min(1), timeoutMs: z.number().int().positive().max(600000).default(60000) },
  }, async (a, h) => {
    const vm = await h.resolveVm(a.vm);
    await h.authorize({ category: 'read', vm, description: 'Wait for VM state' });
    return vms.waitForState(vm, a.states, a.timeoutMs);
  });
}
