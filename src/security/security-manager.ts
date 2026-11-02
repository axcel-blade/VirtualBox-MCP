import { existsSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config, VmPolicy, AccessLevel, ShellKind } from '../config/schema.js';
import { VBoxMcpError } from '../core/errors.js';
import { ApprovalStore } from './approvals.js';

export type OperationCategory = 'read' | 'modify' | 'destructive';
export type Capability = 'execution' | 'lifecycle' | 'fileWrite' | 'configure';

export interface VmRef {
  name: string;
  uuid: string;
}

/** Asks the human (via MCP elicitation) to confirm. Returns undefined when the client cannot elicit. */
export type Elicitor = (message: string) => Promise<boolean | undefined>;

export interface AuthorizeRequest {
  tool: string;
  category: OperationCategory;
  vm?: VmRef;
  capability?: Capability;
  shell?: ShellKind;
  description: string;
  reasons?: string[];
  /** Data identifying the precise operation, so an approval cannot be replayed for something else. */
  payload?: unknown;
  approvalId?: string;
  elicit?: Elicitor;
}

const LEVEL: Record<AccessLevel, number> = { none: 0, read: 1, modify: 2, full: 3 };

/**
 * Central permission engine. Enforced by the server for every tool call, independently of any
 * instruction given to (or by) the AI model.
 */
export class SecurityManager {
  readonly approvals: ApprovalStore;
  private readonly stopFile: string;

  constructor(private readonly cfg: Config, stateDir: string) {
    this.approvals = new ApprovalStore(stateDir, cfg.security.approvalTtlMs);
    this.stopFile = join(stateDir, 'EMERGENCY_STOP');
  }

  policyFor(vm?: VmRef): VmPolicy {
    const base = this.cfg.security.defaultVmPolicy;
    if (!vm) return base;
    const entry = this.cfg.vms[vm.uuid] ?? this.cfg.vms[vm.name];
    return { ...base, ...(entry?.policy ?? {}) } as VmPolicy;
  }

  canSee(vm: VmRef): boolean {
    return this.policyFor(vm).access !== 'none';
  }

  get emergencyStopped(): { active: boolean; since?: string; reason?: string } {
    if (!existsSync(this.stopFile)) return { active: false };
    try {
      return { active: true, ...JSON.parse(readFileSync(this.stopFile, 'utf8')) };
    } catch {
      return { active: true };
    }
  }

  activateEmergencyStop(reason: string): void {
    writeFileSync(this.stopFile, JSON.stringify({ since: new Date().toISOString(), reason }), { mode: 0o600 });
  }

  /** Only callable by a human operator (CLI / admin HTTP endpoint), not via MCP tools. */
  clearEmergencyStop(): void {
    if (existsSync(this.stopFile)) unlinkSync(this.stopFile);
  }

  async authorize(req: AuthorizeRequest): Promise<void> {
    if (req.category !== 'read' && this.emergencyStopped.active) {
      throw new VBoxMcpError('EMERGENCY_STOP_ACTIVE', 'Emergency stop is active. A human operator must run `virtualbox-mcp resume` before any modifying operation.');
    }
    const policy = this.policyFor(req.vm);
    const need = req.category === 'read' ? 'read' : req.category === 'modify' ? 'modify' : 'full';
    if (req.vm && LEVEL[policy.access] < LEVEL[need]) {
      throw new VBoxMcpError('PERMISSION_DENIED', `VM "${req.vm.name}" policy access level "${policy.access}" does not permit ${req.category} operations (${req.tool}).`);
    }
    if (req.vm && req.capability) {
      const allowed =
        req.capability === 'execution' ? policy.allowExecution :
        req.capability === 'lifecycle' ? policy.allowLifecycle :
        req.capability === 'fileWrite' ? policy.allowFileWrite : true;
      if (!allowed) throw new VBoxMcpError('PERMISSION_DENIED', `VM "${req.vm.name}" policy does not allow ${req.capability} (${req.tool}).`);
    }
    if (req.vm && req.shell && policy.allowedShells && !policy.allowedShells.includes(req.shell)) {
      throw new VBoxMcpError('PERMISSION_DENIED', `Shell "${req.shell}" is not permitted for VM "${req.vm.name}".`);
    }
    if (req.category === 'modify' && req.capability === 'execution' && !this.cfg.security.allowOrdinaryGuestModifications) {
      throw new VBoxMcpError('PERMISSION_DENIED', 'Guest modifications are disabled (security.allowOrdinaryGuestModifications=false).');
    }
    if (req.category === 'modify' && !this.cfg.security.allowOrdinaryGuestModifications && req.capability !== 'lifecycle') {
      throw new VBoxMcpError('PERMISSION_DENIED', 'Ordinary modifications are disabled (security.allowOrdinaryGuestModifications=false).');
    }
    if (req.category === 'destructive' && this.cfg.security.requireApprovalForDestructiveOperations) {
      await this.requireApproval(req);
    }
  }

  private async requireApproval(req: AuthorizeRequest): Promise<void> {
    const fingerprint = ApprovalStore.fingerprint(req.tool, req.vm?.uuid, req.payload ?? req.description);
    if (req.approvalId && this.approvals.consume(req.approvalId, fingerprint)) return;

    if (req.elicit) {
      const reasons = req.reasons?.length ? `\nReasons: ${req.reasons.join('; ')}` : '';
      const answer = await req.elicit(
        `VirtualBox MCP: approve destructive operation?\n\nTool: ${req.tool}\n${req.vm ? `VM: ${req.vm.name} (${req.vm.uuid})\n` : ''}Operation: ${req.description}${reasons}`,
      );
      if (answer === true) return;
      if (answer === false) throw new VBoxMcpError('PERMISSION_DENIED', `The operator declined: ${req.description}`);
    }

    const rec = this.approvals.create({
      fingerprint,
      tool: req.tool,
      vm: req.vm?.name,
      description: req.description,
      reasons: req.reasons ?? [],
    });
    throw new VBoxMcpError(
      'APPROVAL_REQUIRED',
      `Destructive operation requires explicit human approval: ${req.description}. ` +
        `A human operator must run \`virtualbox-mcp approve ${rec.id}\` (or POST /admin/approvals/${rec.id}/approve), ` +
        `then repeat the identical call with approvalId="${rec.id}".`,
      { approvalId: rec.id, expiresAt: rec.expiresAt, reasons: req.reasons ?? [] },
    );
  }
}
