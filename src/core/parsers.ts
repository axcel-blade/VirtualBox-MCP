/** Parsers for VBoxManage output. All functions are pure and unit-tested against fixtures. */

export interface VmListEntry {
  name: string;
  uuid: string;
}

/** Parses `VBoxManage list vms` / `list runningvms`: lines of `"name" {uuid}`. */
export function parseVmList(out: string): VmListEntry[] {
  const res: VmListEntry[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^"(.*)"\s+\{([0-9a-fA-F-]{36})\}\s*$/);
    if (m) res.push({ name: m[1]!, uuid: m[2]!.toLowerCase() });
  }
  return res;
}

/** Parses `--machinereadable` output: `key="value"` or `key=value`, with quoted keys allowed. */
export function parseMachineReadable(out: string): Record<string, string> {
  const res: Record<string, string> = {};
  const lines = out.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = line.match(/^("(?:[^"\\]|\\.)*"|[^=]+)=(.*)$/);
    if (!m) continue;
    let key = m[1]!;
    if (key.startsWith('"')) key = key.slice(1, -1);
    let value = m[2]!;
    if (value.startsWith('"')) {
      // Values may span lines (e.g. descriptions). Accumulate until an unescaped closing quote.
      const closed = (v: string) => v.length > 1 && /(^|[^\\])(\\\\)*"$/.test(v.slice(1));
      while (!closed(value) && i + 1 < lines.length) value += '\n' + lines[++i];
      value = value.slice(1, closed(value) ? -1 : undefined).replace(/\\(["\\])/g, '$1');
    }
    res[key] = value;
  }
  return res;
}

/** Parses blocks of `Key:   value` separated by blank lines (list hdds, hostonlyifs, natnets, …). */
export function parseBlocks(out: string): Array<Record<string, string>> {
  const blocks: Array<Record<string, string>> = [];
  let cur: Record<string, string> = {};
  for (const line of out.split(/\r?\n/)) {
    if (line.trim() === '') {
      if (Object.keys(cur).length) blocks.push(cur);
      cur = {};
      continue;
    }
    const m = line.match(/^([^:]+?):\s*(.*)$/);
    if (m) cur[m[1]!.trim()] = m[2]!.trim();
  }
  if (Object.keys(cur).length) blocks.push(cur);
  return blocks;
}

/** Parses `Key: value` lines from a single block (e.g. `list hostinfo`). */
export function parseKeyValueLines(out: string): Record<string, string> {
  return parseBlocks(out).reduce((acc, b) => Object.assign(acc, b), {} as Record<string, string>);
}

export interface SnapshotNode {
  name: string;
  uuid: string;
  description?: string;
  current: boolean;
  path: string;
  children: SnapshotNode[];
}

/**
 * Parses `VBoxManage snapshot <vm> list --machinereadable`. Keys look like `SnapshotName`,
 * `SnapshotName-1`, `SnapshotName-1-1`; the suffix encodes the tree position.
 */
export function parseSnapshotTree(out: string): { roots: SnapshotNode[]; currentUuid?: string; flat: SnapshotNode[] } {
  const kv = parseMachineReadable(out);
  const nodes = new Map<string, SnapshotNode>();
  for (const [k, v] of Object.entries(kv)) {
    const m = k.match(/^Snapshot(Name|UUID|Description)((?:-\d+)*)$/);
    if (!m) continue;
    const suffix = m[2]!;
    const node = nodes.get(suffix) ?? { name: '', uuid: '', current: false, path: suffix, children: [] };
    if (m[1] === 'Name') node.name = v;
    else if (m[1] === 'UUID') node.uuid = v.toLowerCase();
    else node.description = v;
    nodes.set(suffix, node);
  }
  const currentUuid = kv.CurrentSnapshotUUID?.toLowerCase();
  const roots: SnapshotNode[] = [];
  const sorted = [...nodes.values()].sort((a, b) => a.path.split('-').length - b.path.split('-').length);
  for (const node of sorted) {
    node.current = !!currentUuid && node.uuid === currentUuid;
    if (node.path === '') {
      roots.push(node);
      continue;
    }
    const parentPath = node.path.replace(/-\d+$/, '');
    const parent = nodes.get(parentPath);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return { roots, currentUuid, flat: sorted };
}

export type VmState =
  | 'running' | 'poweroff' | 'paused' | 'saved' | 'aborted' | 'starting' | 'stopping' | 'saving' | 'restoring'
  | 'gurumeditation' | 'stuck' | 'teleporting' | 'livesnapshotting' | 'deletingsnapshot' | 'inaccessible' | string;

export interface NicInfo {
  index: number;
  type: string;
  attachment?: string;
  mac?: string;
  cableConnected?: boolean;
  adapterType?: string;
  portForwarding: Array<{ name: string; protocol: string; hostIp: string; hostPort: number; guestIp: string; guestPort: number }>;
}

export interface StorageAttachment {
  controller: string;
  port: number;
  device: number;
  medium: string;
  uuid?: string;
}

export interface VmDetails {
  name: string;
  uuid: string;
  osType?: string;
  state: VmState;
  stateChangedAt?: string;
  memoryMb?: number;
  vramMb?: number;
  cpus?: number;
  firmware?: string;
  chipset?: string;
  groups: string[];
  description?: string;
  configFile?: string;
  directory?: string;
  bootOrder: string[];
  nics: NicInfo[];
  storageControllers: Array<{ name: string; type?: string; portCount?: number; bootable?: boolean }>;
  storageAttachments: StorageAttachment[];
  sharedFolders: Array<{ name: string; hostPath: string }>;
  usb: { ohci?: boolean; ehci?: boolean; xhci?: boolean };
  audio?: { enabled?: boolean; driver?: string; controller?: string };
  clipboardMode?: string;
  dragAndDrop?: string;
  graphicsController?: string;
  vrde?: boolean;
  guestAdditionsRunLevel?: number;
  guestAdditionsVersion?: string;
  snapshotCount: number;
  currentSnapshot?: string;
  raw: Record<string, string>;
}

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function parseVmInfo(out: string): VmDetails {
  const kv = parseMachineReadable(out);
  const nics: NicInfo[] = [];
  for (let i = 1; i <= 36; i++) {
    const t = kv[`nic${i}`];
    if (t === undefined) continue;
    const pf: NicInfo['portForwarding'] = [];
    for (let j = 0; ; j++) {
      const rule = kv[`Forwarding(${j})`];
      if (rule === undefined) break;
      // Forwarding rules are attributed to the NAT adapter; VBoxManage emits them after the nic.
      const [name, protocol, hostIp, hostPort, guestIp, guestPort] = rule.split(',');
      if (t === 'nat') pf.push({ name: name ?? '', protocol: protocol ?? '', hostIp: hostIp ?? '', hostPort: Number(hostPort), guestIp: guestIp ?? '', guestPort: Number(guestPort) });
    }
    nics.push({
      index: i,
      type: t,
      attachment: kv[`bridgeadapter${i}`] ?? kv[`hostonlyadapter${i}`] ?? kv[`intnet${i}`] ?? kv[`nat-network${i}`] ?? kv[`natnet${i}`],
      mac: kv[`macaddress${i}`],
      cableConnected: kv[`cableconnected${i}`] === undefined ? undefined : kv[`cableconnected${i}`] === 'on',
      adapterType: kv[`nictype${i}`],
      portForwarding: pf,
    });
  }
  const controllers: VmDetails['storageControllers'] = [];
  for (let i = 0; i < 32; i++) {
    const name = kv[`storagecontrollername${i}`];
    if (name === undefined) continue;
    controllers.push({
      name,
      type: kv[`storagecontrollertype${i}`],
      portCount: num(kv[`storagecontrollerportcount${i}`]),
      bootable: kv[`storagecontrollerbootable${i}`] === 'on',
    });
  }
  const attachments: StorageAttachment[] = [];
  for (const [k, v] of Object.entries(kv)) {
    const m = k.match(/^(.+)-(\d+)-(\d+)$/);
    if (!m || /-(ImageUUID|IsEjected|hot-pluggable|nonrotational|discard|tempeject)$/.test(m[1]!) || v === 'none') continue;
    if (!controllers.some((c) => c.name === m[1])) continue;
    attachments.push({ controller: m[1]!, port: Number(m[2]), device: Number(m[3]), medium: v, uuid: kv[`${m[1]}-ImageUUID-${m[2]}-${m[3]}`] });
  }
  const shared: VmDetails['sharedFolders'] = [];
  for (const [k, v] of Object.entries(kv)) {
    const m = k.match(/^SharedFolderName(Machine|Transient)Mapping(\d+)$/);
    if (m) shared.push({ name: v, hostPath: kv[`SharedFolderPath${m[1]}Mapping${m[2]}`] ?? '' });
  }
  const boot: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const b = kv[`boot${i}`];
    if (b && b !== 'none') boot.push(b);
  }
  const cfgFile = kv.CfgFile;
  return {
    name: kv.name ?? '',
    uuid: (kv.UUID ?? '').toLowerCase(),
    osType: kv.ostype,
    state: kv.VMState ?? 'unknown',
    stateChangedAt: kv.VMStateChangeTime,
    memoryMb: num(kv.memory),
    vramMb: num(kv.vram),
    cpus: num(kv.cpus),
    firmware: kv.firmware,
    chipset: kv.chipset,
    groups: (kv.groups ?? '/').split(',').filter((g) => g && g !== '/'),
    description: kv.description,
    configFile: cfgFile,
    directory: cfgFile ? cfgFile.replace(/[\\/][^\\/]+$/, '') : undefined,
    bootOrder: boot,
    nics,
    storageControllers: controllers,
    storageAttachments: attachments,
    sharedFolders: shared,
    usb: { ohci: kv.usb === 'on' || kv.usbohci === 'on', ehci: kv.ehci === 'on' || kv.usbehci === 'on', xhci: kv.xhci === 'on' || kv.usbxhci === 'on' },
    audio: { enabled: kv.audio_out === 'on' || (kv.audio !== undefined && kv.audio !== 'none'), driver: kv.audio, controller: kv.audio_controller },
    clipboardMode: kv.clipboard ?? kv.ClipboardMode,
    dragAndDrop: kv.draganddrop ?? kv.DnDMode,
    graphicsController: kv.graphicscontroller,
    vrde: kv.vrde === 'on',
    guestAdditionsRunLevel: num(kv.GuestAdditionsRunLevel),
    guestAdditionsVersion: kv.GuestAdditionsVersion,
    snapshotCount: Object.keys(kv).filter((k) => /^SnapshotUUID(-\d+)*$/.test(k)).length,
    currentSnapshot: kv.CurrentSnapshotName,
    raw: kv,
  };
}

/** Parses `VBoxManage metrics query` output (columns: Object, Metric, Values). */
export function parseMetrics(out: string): Array<{ object: string; metric: string; values: string }> {
  const res: Array<{ object: string; metric: string; values: string }> = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+(\S+)\s+(.+)$/);
    if (!m || m[1] === 'Object' || /^-+$/.test(m[1]!)) continue;
    res.push({ object: m[1]!, metric: m[2]!, values: m[3]!.trim() });
  }
  return res;
}
