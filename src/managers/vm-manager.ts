import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VBoxClient } from '../core/vbox-client.js';
import { VBoxMcpError } from '../core/errors.js';
import { parseVmList, parseVmInfo, parseKeyValueLines, type VmDetails, type VmListEntry } from '../core/parsers.js';
import type { Config } from '../config/schema.js';
import type { SecurityManager, VmRef } from '../security/security-manager.js';
import { getHostInfo, getDiskSpace, defaultVmDirectoryGuess } from '../platforms/detect.js';

export interface VmFilter {
  name?: string;
  uuid?: string;
  os?: string;
  state?: string;
  group?: string;
  tag?: string;
  query?: string;
}

export interface VmSummary {
  name: string;
  uuid: string;
  state: string;
  osType?: string;
  groups: string[];
  tags: string[];
  memoryMb?: number;
  cpus?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_RE = /^[^\0\r\n/\\]{1,128}$/;

export function assertVmName(name: string): void {
  if (!NAME_RE.test(name) || name.startsWith('-')) throw new VBoxMcpError('INVALID_ARGUMENT', `Invalid VM name: ${JSON.stringify(name)}`);
}

export interface CreateVmOptions {
  name: string;
  osType: string;
  memoryMb: number;
  cpus: number;
  vramMb?: number;
  firmware?: 'bios' | 'efi' | 'efi32' | 'efi64';
  chipset?: 'piix3' | 'ich9';
  diskSizeMb?: number;
  diskFormat?: 'VDI' | 'VMDK' | 'VHD';
  existingDiskPath?: string;
  isoPath?: string;
  network?: { mode: 'nat' | 'bridged' | 'hostonly' | 'intnet' | 'natnetwork' | 'none'; attachTo?: string };
  baseFolder?: string;
  groups?: string[];
  description?: string;
  storageController?: 'sata' | 'nvme' | 'ide' | 'scsi';
  audio?: boolean;
  usb?: 'off' | 'ohci' | 'ehci' | 'xhci';
  graphicsController?: 'vboxsvga' | 'vmsvga' | 'vboxvga' | 'none';
  bootOrder?: Array<'none' | 'floppy' | 'dvd' | 'disk' | 'net'>;
  unattended?: { user: string; password: string; fullName?: string; hostname?: string; installAdditions?: boolean; locale?: string; timeZone?: string; productKey?: string };
}

export class VmManager {
  constructor(
    private readonly vbox: VBoxClient,
    private readonly cfg: Config,
    private readonly security: SecurityManager,
  ) {}

  async listRaw(): Promise<VmListEntry[]> {
    return parseVmList(await this.vbox.out(['list', 'vms']));
  }

  async listRunningRaw(): Promise<VmListEntry[]> {
    return parseVmList(await this.vbox.out(['list', 'runningvms']));
  }

  tagsFor(vm: VmRef): string[] {
    return (this.cfg.vms[vm.uuid] ?? this.cfg.vms[vm.name])?.tags ?? [];
  }

  /** Resolves a VM by UUID or exact (then case-insensitive) name. Hidden VMs behave as missing. */
  async resolve(idOrName: string): Promise<VmRef> {
    if (!idOrName) throw new VBoxMcpError('INVALID_ARGUMENT', 'A VM name or UUID is required.');
    const all = await this.listRaw();
    const needle = idOrName.trim().replace(/^\{|\}$/g, '');
    let hit = UUID_RE.test(needle) ? all.find((v) => v.uuid === needle.toLowerCase()) : undefined;
    hit ??= all.find((v) => v.name === needle) ?? all.find((v) => v.name.toLowerCase() === needle.toLowerCase());
    if (!hit) {
      const close = all.filter((v) => v.name.toLowerCase().includes(needle.toLowerCase()) && this.security.canSee(v)).map((v) => v.name);
      throw new VBoxMcpError('VM_NOT_FOUND', `No VirtualBox VM named or identified by "${idOrName}".${close.length ? ` Did you mean: ${close.join(', ')}?` : ''}`);
    }
    if (!this.security.canSee(hit)) throw new VBoxMcpError('VM_NOT_FOUND', `No VirtualBox VM named or identified by "${idOrName}".`);
    return hit;
  }

  async info(vm: VmRef): Promise<VmDetails> {
    return parseVmInfo(await this.vbox.out(['showvminfo', vm.uuid, '--machinereadable']));
  }

  async state(vm: VmRef): Promise<string> {
    return (await this.info(vm)).state;
  }

  summarize(d: VmDetails): VmSummary {
    return { name: d.name, uuid: d.uuid, state: d.state, osType: d.osType, groups: d.groups, tags: this.tagsFor(d), memoryMb: d.memoryMb, cpus: d.cpus };
  }

  async list(filter: VmFilter = {}): Promise<VmSummary[]> {
    const all = (await this.listRaw()).filter((v) => this.security.canSee(v));
    const out: VmSummary[] = [];
    for (const v of all) {
      try {
        out.push(this.summarize(await this.info(v)));
      } catch {
        out.push({ name: v.name, uuid: v.uuid, state: 'inaccessible', groups: [], tags: this.tagsFor(v) });
      }
    }
    return out.filter((s) => matches(s, filter));
  }

  async listRunning(): Promise<VmSummary[]> {
    const running = (await this.listRunningRaw()).filter((v) => this.security.canSee(v));
    const res: VmSummary[] = [];
    for (const v of running) res.push(this.summarize(await this.info(v)));
    return res;
  }

  // ---------- lifecycle ----------

  async start(vm: VmRef, type: 'headless' | 'gui' | 'separate' = 'headless'): Promise<string> {
    const state = await this.state(vm);
    if (state === 'running') throw new VBoxMcpError('VM_ALREADY_RUNNING', `VM "${vm.name}" is already running.`);
    if (state === 'paused') throw new VBoxMcpError('VM_ALREADY_RUNNING', `VM "${vm.name}" is paused; use resume_vm.`);
    await this.vbox.run(['startvm', vm.uuid, '--type', type], { timeoutMs: 120000 });
    return this.state(vm);
  }

  private async requireRunning(vm: VmRef, allowPaused = false): Promise<string> {
    const s = await this.state(vm);
    if (s !== 'running' && !(allowPaused && s === 'paused')) throw new VBoxMcpError('VM_NOT_RUNNING', `VM "${vm.name}" is not running (state: ${s}).`);
    return s;
  }

  /** Graceful: ACPI power button. Never escalates to power-off on its own. */
  async shutdown(vm: VmRef, waitMs = 0): Promise<{ state: string; completed: boolean }> {
    await this.requireRunning(vm);
    await this.vbox.run(['controlvm', vm.uuid, 'acpipowerbutton']);
    if (waitMs <= 0) return { state: await this.state(vm), completed: false };
    const r = await this.waitForState(vm, ['poweroff'], waitMs);
    return { state: r.state, completed: r.reached };
  }

  async poweroff(vm: VmRef): Promise<string> {
    await this.requireRunning(vm, true);
    await this.vbox.run(['controlvm', vm.uuid, 'poweroff']);
    return this.state(vm);
  }

  async pause(vm: VmRef): Promise<string> {
    await this.requireRunning(vm);
    await this.vbox.run(['controlvm', vm.uuid, 'pause']);
    return this.state(vm);
  }

  async resume(vm: VmRef): Promise<string> {
    const s = await this.state(vm);
    if (s !== 'paused') throw new VBoxMcpError('VM_OPERATION_FAILED', `VM "${vm.name}" is not paused (state: ${s}).`);
    await this.vbox.run(['controlvm', vm.uuid, 'resume']);
    return this.state(vm);
  }

  async reset(vm: VmRef): Promise<string> {
    await this.requireRunning(vm);
    await this.vbox.run(['controlvm', vm.uuid, 'reset']);
    return this.state(vm);
  }

  /** Graceful restart: ACPI shutdown, wait, start again. Fails (does not force) if the guest ignores ACPI. */
  async restart(vm: VmRef, timeoutMs: number, type: 'headless' | 'gui' = 'headless'): Promise<string> {
    const r = await this.shutdown(vm, timeoutMs);
    if (!r.completed) {
      throw new VBoxMcpError('VM_OPERATION_FAILED', `VM "${vm.name}" did not shut down within ${timeoutMs} ms (state: ${r.state}). Use reset_vm or poweroff_vm explicitly if a forced restart is intended.`);
    }
    return this.start(vm, type);
  }

  async saveState(vm: VmRef): Promise<string> {
    await this.requireRunning(vm, true);
    await this.vbox.run(['controlvm', vm.uuid, 'savestate'], { timeoutMs: 300000 });
    return this.state(vm);
  }

  async discardState(vm: VmRef): Promise<string> {
    const s = await this.state(vm);
    if (s !== 'saved') throw new VBoxMcpError('VM_OPERATION_FAILED', `VM "${vm.name}" has no saved state (state: ${s}).`);
    await this.vbox.run(['discardstate', vm.uuid]);
    return this.state(vm);
  }

  async waitForState(vm: VmRef, states: string[], timeoutMs: number, pollMs = 1000): Promise<{ state: string; reached: boolean; waitedMs: number }> {
    const start = Date.now();
    for (;;) {
      const s = await this.state(vm);
      if (states.includes(s)) return { state: s, reached: true, waitedMs: Date.now() - start };
      if (Date.now() - start >= timeoutMs) return { state: s, reached: false, waitedMs: Date.now() - start };
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  // ---------- host ----------

  async hostInfo(): Promise<Record<string, unknown>> {
    const host = getHostInfo();
    let vboxHost: Record<string, string> = {};
    let sys: Record<string, string> = {};
    try {
      vboxHost = parseKeyValueLines(await this.vbox.out(['list', 'hostinfo']));
      sys = parseKeyValueLines(await this.vbox.out(['list', 'systemproperties']));
    } catch {
      // VirtualBox missing: still report host data
    }
    const vmDir = await this.defaultVmDirectory().catch(() => undefined);
    return {
      host,
      virtualbox: vboxHost,
      defaultVmDirectory: vmDir,
      vmDirectoryDisk: vmDir && existsSync(vmDir) ? getDiskSpace(vmDir) : undefined,
      systemProperties: sys,
    };
  }

  async defaultVmDirectory(): Promise<string> {
    if (this.cfg.virtualbox.defaultVmDirectory !== 'auto') return this.cfg.virtualbox.defaultVmDirectory;
    try {
      const sys = parseKeyValueLines(await this.vbox.out(['list', 'systemproperties']));
      return sys['Default machine folder'] ?? defaultVmDirectoryGuess();
    } catch {
      return defaultVmDirectoryGuess();
    }
  }

  async osTypes(): Promise<Array<{ id: string; description: string; family?: string }>> {
    const out = await this.vbox.out(['list', 'ostypes']);
    const blocks: Array<{ id: string; description: string; family?: string }> = [];
    let cur: Record<string, string> = {};
    for (const line of [...out.split(/\r?\n/), '']) {
      if (!line.trim()) {
        if (cur.ID) blocks.push({ id: cur.ID, description: cur.Description ?? '', family: cur['Family ID'] });
        cur = {};
        continue;
      }
      const m = line.match(/^([^:]+):\s*(.*)$/);
      if (m) cur[m[1]!.trim()] = m[2]!.trim();
    }
    return blocks;
  }

  /** Validates a requested allocation against host resources. Returns warnings; throws on impossible requests. */
  async validateAllocation(memoryMb: number, cpus: number, diskMb = 0, folder?: string): Promise<string[]> {
    const host = getHostInfo();
    const warnings: string[] = [];
    const totalMb = Math.floor(host.totalMemoryBytes / 1048576);
    if (cpus > host.cpuCores) throw new VBoxMcpError('INVALID_ARGUMENT', `Requested ${cpus} vCPUs but the host has ${host.cpuCores} logical cores.`);
    if (memoryMb > totalMb * 0.9) throw new VBoxMcpError('INVALID_ARGUMENT', `Requested ${memoryMb} MB RAM exceeds 90% of host memory (${totalMb} MB).`);
    if (memoryMb > Math.floor(host.freeMemoryBytes / 1048576)) warnings.push(`Requested RAM (${memoryMb} MB) exceeds currently free host memory (${Math.floor(host.freeMemoryBytes / 1048576)} MB).`);
    if (cpus > host.cpuCores / 2) warnings.push(`Allocating ${cpus} of ${host.cpuCores} host cores may degrade host performance.`);
    const running = await this.listRunning().catch(() => []);
    const committed = running.reduce((a, v) => a + (v.memoryMb ?? 0), 0);
    if (committed + memoryMb > totalMb * 0.85) warnings.push(`Running VMs already use ${committed} MB; total would exceed 85% of host RAM.`);
    if (diskMb > 0) {
      const dir = folder ?? (await this.defaultVmDirectory());
      let probe = dir;
      while (!existsSync(probe) && probe !== (probe = probe.replace(/[\\/][^\\/]*$/, ''))) {
        // walk up to an existing ancestor
      }
      const disk = getDiskSpace(existsSync(probe) ? probe : process.cwd());
      if (disk && diskMb * 1048576 > disk.freeBytes) {
        throw new VBoxMcpError('DISK_SPACE_INSUFFICIENT', `Requested ${diskMb} MB disk but only ${Math.floor(disk.freeBytes / 1048576)} MB free at ${disk.path}.`);
      }
      if (disk && diskMb * 1048576 > disk.freeBytes * 0.8) warnings.push('Dynamically allocated disk could consume most of the free host storage if filled.');
    }
    return warnings;
  }

  async create(o: CreateVmOptions): Promise<{ vm: VmRef; warnings: string[]; steps: string[] }> {
    assertVmName(o.name);
    const existing = await this.listRaw();
    if (existing.some((v) => v.name.toLowerCase() === o.name.toLowerCase())) throw new VBoxMcpError('VM_OPERATION_FAILED', `A VM named "${o.name}" already exists.`);
    const types = await this.osTypes();
    if (!types.some((t) => t.id === o.osType)) {
      const sugg = types.filter((t) => t.id.toLowerCase().includes(o.osType.toLowerCase().split(/[_ ]/)[0] ?? '')).slice(0, 8).map((t) => t.id);
      throw new VBoxMcpError('INVALID_ARGUMENT', `Unknown OS type "${o.osType}".${sugg.length ? ` Candidates: ${sugg.join(', ')}` : ' Use list_os_types.'}`);
    }
    if (o.isoPath && !existsSync(o.isoPath)) throw new VBoxMcpError('INVALID_ARGUMENT', `ISO not found on host: ${o.isoPath}`);
    if (o.existingDiskPath && !existsSync(o.existingDiskPath)) throw new VBoxMcpError('INVALID_ARGUMENT', `Disk image not found on host: ${o.existingDiskPath}`);
    const warnings = await this.validateAllocation(o.memoryMb, o.cpus, o.existingDiskPath ? 0 : (o.diskSizeMb ?? 0), o.baseFolder);
    const steps: string[] = [];
    const createArgs = ['createvm', '--name', o.name, '--ostype', o.osType, '--register'];
    if (o.baseFolder) createArgs.push('--basefolder', o.baseFolder);
    if (o.groups?.length) createArgs.push('--groups', o.groups.map((g) => (g.startsWith('/') ? g : `/${g}`)).join(','));
    const out = await this.vbox.out(createArgs);
    const uuid = out.match(/UUID:\s*([0-9a-f-]{36})/i)?.[1]?.toLowerCase();
    const settingsFile = out.match(/Settings file:\s*'([^']+)'/)?.[1];
    const vm: VmRef = { name: o.name, uuid: uuid ?? (await this.resolve(o.name)).uuid };
    steps.push(`createvm ${o.name} (${vm.uuid})`);
    try {
      const modify = ['modifyvm', vm.uuid, '--memory', String(o.memoryMb), '--cpus', String(o.cpus), '--vram', String(o.vramMb ?? 16)];
      if (o.firmware) modify.push('--firmware', o.firmware);
      if (o.chipset) modify.push('--chipset', o.chipset);
      if (o.graphicsController) modify.push('--graphicscontroller', o.graphicsController);
      if (o.audio === false) modify.push('--audio-enabled', 'off');
      if (o.usb) modify.push(...usbArgs(o.usb));
      if (o.description) modify.push('--description', o.description);
      const net = o.network ?? { mode: 'nat' as const };
      modify.push(...nicArgs(1, net.mode, net.attachTo));
      (o.bootOrder ?? ['dvd', 'disk', 'none', 'none']).slice(0, 4).forEach((b, i) => modify.push(`--boot${i + 1}`, b));
      await this.vbox.run(modify);
      steps.push('modifyvm hardware/network');

      const ctlType = o.storageController ?? 'sata';
      const ctlName = ctlType.toUpperCase();
      const chip = ctlType === 'sata' ? 'IntelAhci' : ctlType === 'nvme' ? 'NVMe' : ctlType === 'ide' ? 'PIIX4' : 'LsiLogic';
      await this.vbox.run(['storagectl', vm.uuid, '--name', ctlName, '--add', ctlType === 'nvme' ? 'pcie' : ctlType, '--controller', chip, '--bootable', 'on']);
      steps.push(`storagectl ${ctlName}`);
      let diskPath = o.existingDiskPath;
      if (!diskPath && o.diskSizeMb) {
        const dir = settingsFile ? settingsFile.replace(/[\\/][^\\/]+$/, '') : await this.defaultVmDirectory();
        const ext = (o.diskFormat ?? 'VDI').toLowerCase();
        diskPath = `${dir}${dir.includes('\\') ? '\\' : '/'}${o.name}.${ext}`;
        await this.vbox.run(['createmedium', 'disk', '--filename', diskPath, '--size', String(o.diskSizeMb), '--format', o.diskFormat ?? 'VDI', '--variant', 'Standard'], { timeoutMs: 600000 });
        steps.push(`createmedium ${diskPath} (${o.diskSizeMb} MB)`);
      }
      if (diskPath) {
        await this.vbox.run(['storageattach', vm.uuid, '--storagectl', ctlName, '--port', '0', '--device', '0', '--type', 'hdd', '--medium', diskPath]);
        steps.push('attach disk');
      }
      // Optical drive on its own IDE controller for maximum installer compatibility.
      await this.vbox.run(['storagectl', vm.uuid, '--name', 'IDE', '--add', 'ide', '--controller', 'PIIX4']);
      await this.vbox.run(['storageattach', vm.uuid, '--storagectl', 'IDE', '--port', '1', '--device', '0', '--type', 'dvddrive', '--medium', o.isoPath ?? 'emptydrive']);
      steps.push(o.isoPath ? `attach ISO ${o.isoPath}` : 'add empty DVD drive');

      if (o.unattended && o.isoPath) {
        const u = o.unattended;
        const pwDir = mkdtempSync(join(tmpdir(), 'vboxmcp-'));
        const pwFile = join(pwDir, 'pw');
        writeFileSync(pwFile, u.password, { mode: 0o600 });
        const args = ['unattended', 'install', vm.uuid, `--iso=${o.isoPath}`, `--user=${u.user}`, `--password-file=${pwFile}`];
        if (u.fullName) args.push(`--full-user-name=${u.fullName}`);
        if (u.hostname) args.push(`--hostname=${u.hostname}`);
        if (u.locale) args.push(`--locale=${u.locale}`);
        if (u.timeZone) args.push(`--time-zone=${u.timeZone}`);
        if (u.productKey) args.push(`--key=${u.productKey}`);
        if (u.installAdditions) args.push('--install-additions');
        try {
          await this.vbox.run(args, { timeoutMs: 600000 });
        } finally {
          rmSync(pwDir, { recursive: true, force: true });
        }
        steps.push('unattended install prepared (start the VM to begin installation)');
      }
    } catch (err) {
      // Roll back the partially created VM (only the VM we just created; disks are kept only if pre-existing).
      await this.vbox.run(['unregistervm', vm.uuid, ...(o.existingDiskPath ? [] : ['--delete'])], { allowFailure: true });
      throw err;
    }
    return { vm, warnings, steps };
  }

  async clone(vm: VmRef, opts: { name: string; snapshot?: string; mode?: 'machine' | 'machineandchildren' | 'all'; linked?: boolean; baseFolder?: string; register?: boolean; groups?: string[] }): Promise<VmRef> {
    assertVmName(opts.name);
    const args = ['clonevm', vm.uuid, '--name', opts.name];
    if (opts.snapshot) args.push('--snapshot', opts.snapshot);
    if (opts.mode) args.push('--mode', opts.mode);
    if (opts.linked) {
      if (!opts.snapshot) throw new VBoxMcpError('INVALID_ARGUMENT', 'Linked clones require a snapshot.');
      args.push('--options', 'Link');
    }
    if (opts.baseFolder) args.push('--basefolder', opts.baseFolder);
    if (opts.groups?.length) args.push('--groups', opts.groups.join(','));
    if (opts.register !== false) args.push('--register');
    await this.vbox.run(args, { timeoutMs: 3600000 });
    return opts.register === false ? { name: opts.name, uuid: '' } : this.resolve(opts.name);
  }

  async modify(vm: VmRef, s: ModifySettings): Promise<string[]> {
    const state = await this.state(vm);
    const args = modifyArgs(s);
    if (args.length === 0) throw new VBoxMcpError('INVALID_ARGUMENT', 'No settings to change were provided.');
    const hotChangeable = state === 'running' || state === 'paused';
    if (hotChangeable) {
      throw new VBoxMcpError('VM_ALREADY_RUNNING', `VM "${vm.name}" must be powered off to change hardware settings (state: ${state}). Use network/device tools for runtime changes.`);
    }
    await this.vbox.run(['modifyvm', vm.uuid, ...args]);
    return args;
  }

  async rename(vm: VmRef, newName: string): Promise<VmRef> {
    assertVmName(newName);
    await this.vbox.run(['modifyvm', vm.uuid, '--name', newName]);
    return { name: newName, uuid: vm.uuid };
  }

  async delete(vm: VmRef, deleteFiles: boolean): Promise<void> {
    const s = await this.state(vm);
    if (s === 'running' || s === 'paused') throw new VBoxMcpError('VM_ALREADY_RUNNING', `Power off VM "${vm.name}" before deleting it.`);
    await this.vbox.run(['unregistervm', vm.uuid, ...(deleteFiles ? ['--delete'] : [])], { timeoutMs: 600000 });
  }

  async register(path: string): Promise<VmRef> {
    if (!existsSync(path)) throw new VBoxMcpError('INVALID_ARGUMENT', `Settings file not found: ${path}`);
    const before = new Set((await this.listRaw()).map((v) => v.uuid));
    await this.vbox.run(['registervm', path]);
    const added = (await this.listRaw()).find((v) => !before.has(v.uuid));
    if (!added) throw new VBoxMcpError('VM_OPERATION_FAILED', 'VM registered but could not be located.');
    return added;
  }

  async importAppliance(path: string, opts: { name?: string; baseFolder?: string; dryRun?: boolean; memoryMb?: number; cpus?: number }): Promise<string> {
    if (!existsSync(path)) throw new VBoxMcpError('INVALID_ARGUMENT', `Appliance not found: ${path}`);
    const args = ['import', path];
    if (opts.dryRun) args.push('--dry-run');
    if (opts.name || opts.memoryMb || opts.cpus || opts.baseFolder) args.push('--vsys', '0');
    if (opts.name) args.push('--vmname', opts.name);
    if (opts.memoryMb) args.push('--memory', String(opts.memoryMb));
    if (opts.cpus) args.push('--cpus', String(opts.cpus));
    if (opts.baseFolder) args.push('--basefolder', opts.baseFolder);
    return this.vbox.out(args, { timeoutMs: 6 * 3600000 });
  }

  async exportAppliance(vms: VmRef[], output: string, opts: { format?: 'ovf-0.9' | 'ovf-1.0' | 'ovf-2.0'; manifest?: boolean; includeIsos?: boolean }): Promise<string> {
    const args = ['export', ...vms.map((v) => v.uuid), '--output', output];
    if (opts.format) args.push(`--${opts.format.replace('ovf-', 'ovf').replace('.', '')}`);
    if (opts.manifest) args.push('--manifest');
    if (opts.includeIsos) args.push('--iso');
    return this.vbox.out(args, { timeoutMs: 6 * 3600000 });
  }
}

export interface ModifySettings {
  memoryMb?: number;
  cpus?: number;
  vramMb?: number;
  firmware?: 'bios' | 'efi' | 'efi32' | 'efi64';
  chipset?: 'piix3' | 'ich9';
  bootOrder?: Array<'none' | 'floppy' | 'dvd' | 'disk' | 'net'>;
  audio?: boolean;
  usb?: 'off' | 'ohci' | 'ehci' | 'xhci';
  graphicsController?: 'vboxsvga' | 'vmsvga' | 'vboxvga' | 'none';
  description?: string;
  groups?: string[];
  nestedVirtualization?: boolean;
  pae?: boolean;
  ioapic?: boolean;
  cpuExecutionCap?: number;
  osType?: string;
}

function usbArgs(u: 'off' | 'ohci' | 'ehci' | 'xhci'): string[] {
  return u === 'off'
    ? ['--usb-ohci', 'off', '--usb-ehci', 'off', '--usb-xhci', 'off']
    : ['--usb-ohci', u === 'ohci' || u === 'ehci' ? 'on' : 'off', '--usb-ehci', u === 'ehci' ? 'on' : 'off', '--usb-xhci', u === 'xhci' ? 'on' : 'off'];
}

export function nicArgs(index: number, mode: string, attachTo?: string): string[] {
  const a = [`--nic${index}`, mode === 'natnetwork' ? 'natnetwork' : mode];
  if (mode === 'bridged') {
    if (!attachTo) throw new VBoxMcpError('INVALID_ARGUMENT', 'Bridged networking requires a host adapter (attachTo).');
    a.push(`--bridge-adapter${index}`, attachTo);
  } else if (mode === 'hostonly') {
    if (!attachTo) throw new VBoxMcpError('INVALID_ARGUMENT', 'Host-only networking requires a host-only interface (attachTo).');
    a.push(`--host-only-adapter${index}`, attachTo);
  } else if (mode === 'intnet') a.push(`--intnet${index}`, attachTo ?? 'intnet');
  else if (mode === 'natnetwork') {
    if (!attachTo) throw new VBoxMcpError('INVALID_ARGUMENT', 'NAT Network mode requires a NAT network name (attachTo).');
    a.push(`--nat-network${index}`, attachTo);
  }
  return a;
}

export function modifyArgs(s: ModifySettings): string[] {
  const a: string[] = [];
  if (s.memoryMb !== undefined) a.push('--memory', String(s.memoryMb));
  if (s.cpus !== undefined) a.push('--cpus', String(s.cpus));
  if (s.vramMb !== undefined) a.push('--vram', String(s.vramMb));
  if (s.firmware) a.push('--firmware', s.firmware);
  if (s.chipset) a.push('--chipset', s.chipset);
  if (s.bootOrder) [0, 1, 2, 3].forEach((i) => a.push(`--boot${i + 1}`, s.bootOrder![i] ?? 'none'));
  if (s.audio !== undefined) a.push('--audio-enabled', s.audio ? 'on' : 'off');
  if (s.usb) a.push(...usbArgs(s.usb));
  if (s.graphicsController) a.push('--graphicscontroller', s.graphicsController);
  if (s.description !== undefined) a.push('--description', s.description);
  if (s.groups) a.push('--groups', s.groups.map((g) => (g.startsWith('/') ? g : `/${g}`)).join(','));
  if (s.nestedVirtualization !== undefined) a.push('--nested-hw-virt', s.nestedVirtualization ? 'on' : 'off');
  if (s.pae !== undefined) a.push('--pae', s.pae ? 'on' : 'off');
  if (s.ioapic !== undefined) a.push('--ioapic', s.ioapic ? 'on' : 'off');
  if (s.cpuExecutionCap !== undefined) a.push('--cpu-execution-cap', String(s.cpuExecutionCap));
  if (s.osType) a.push('--ostype', s.osType);
  return a;
}

function matches(s: VmSummary, f: VmFilter): boolean {
  if (f.name && s.name.toLowerCase() !== f.name.toLowerCase()) return false;
  if (f.uuid && s.uuid !== f.uuid.toLowerCase()) return false;
  if (f.os && !(s.osType ?? '').toLowerCase().includes(f.os.toLowerCase())) return false;
  if (f.state && s.state !== f.state) return false;
  if (f.group && !s.groups.some((g) => g.replace(/^\//, '').toLowerCase() === f.group!.replace(/^\//, '').toLowerCase())) return false;
  if (f.tag && !s.tags.includes(f.tag)) return false;
  if (f.query) {
    const q = f.query.toLowerCase();
    const hay = [s.name, s.uuid, s.osType ?? '', ...s.groups, ...s.tags].join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}
