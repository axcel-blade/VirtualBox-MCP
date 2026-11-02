import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config, GuestConnection, ShellKind } from '../config/schema.js';
import type { VBoxClient } from '../core/vbox-client.js';
import { VBoxMcpError } from '../core/errors.js';
import type { CredentialStore } from '../security/credentials.js';
import { registerSecret } from '../security/redact.js';
import type { VmRef } from '../security/security-manager.js';
import type { VmManager } from './vm-manager.js';
import type { BackendName, GuestBackend, GuestCredentials, GuestOsFamily } from '../backends/types.js';
import { GuestControlBackend } from '../backends/guest-control/index.js';
import { SshBackend } from '../backends/ssh/index.js';
import { WinRmBackend } from '../backends/winrm/index.js';
import { SHELLS, shellsForOs, defaultShellFor } from '../core/shells.js';

export interface ResolvedConnection {
  backend: GuestBackend;
  os: GuestOsFamily;
  vm: VmRef;
}

export interface ShellAvailability {
  shell: ShellKind;
  available: boolean;
  path?: string;
  label: string;
}

/** Selects, authenticates and caches guest execution backends for each VM. */
export class ConnectionManager {
  private cache = new Map<string, GuestBackend>();
  private shellCache = new Map<string, ShellAvailability[]>();
  private readonly knownHostsPath: string;

  constructor(
    private readonly cfg: Config,
    private readonly vbox: VBoxClient,
    private readonly vms: VmManager,
    private readonly creds: CredentialStore,
    stateDir: string,
  ) {
    this.knownHostsPath = join(stateDir, 'known_hosts.json');
  }

  connectionConfig(vm: VmRef): GuestConnection {
    const c = (this.cfg.vms[vm.uuid] ?? this.cfg.vms[vm.name])?.connection;
    return c ?? { backend: 'auto', os: 'auto' };
  }

  async detectOs(vm: VmRef): Promise<{ os: GuestOsFamily; source: string; osType?: string; detail?: string }> {
    const conf = this.connectionConfig(vm);
    if (conf.os !== 'auto') return { os: conf.os, source: 'configuration' };
    const info = await this.vms.info(vm);
    const gaOs = await this.guestProperty(vm, '/VirtualBox/GuestInfo/OS/Product');
    if (gaOs) return { os: /windows/i.test(gaOs) ? 'windows' : 'linux', source: 'guest-additions', osType: info.osType, detail: gaOs };
    const t = info.osType ?? '';
    return { os: /windows/i.test(t) ? 'windows' : 'linux', source: 'vm-os-type', osType: t };
  }

  async guestProperty(vm: VmRef, key: string): Promise<string | undefined> {
    const r = await this.vbox.run(['guestproperty', 'get', vm.uuid, key], { allowFailure: true });
    const m = r.stdout.match(/^Value:\s*(.*)$/m);
    return m ? m[1]!.trim() : undefined;
  }

  async guestAdditionsStatus(vm: VmRef): Promise<{ installed: boolean; version?: string; runLevel?: number; guestControlUsable: boolean; detail: string }> {
    const info = await this.vms.info(vm);
    const version = info.guestAdditionsVersion ?? (await this.guestProperty(vm, '/VirtualBox/GuestAdd/Version'));
    const runLevel = info.guestAdditionsRunLevel;
    const running = info.state === 'running';
    const usable = running && (runLevel ?? 0) >= 1;
    return {
      installed: !!version || (runLevel ?? 0) > 0,
      version,
      runLevel,
      guestControlUsable: usable,
      detail: !running ? `VM is ${info.state}; Guest Additions status is only reported while running.` : usable ? 'Guest Additions are running.' : 'Guest Additions are not running or not installed in this guest.',
    };
  }

  private async credentials(vm: VmRef, conf: GuestConnection): Promise<GuestCredentials> {
    let c: GuestCredentials | undefined;
    if (conf.credentialRef) {
      const stored = this.creds.get(conf.credentialRef);
      if (!stored) throw new VBoxMcpError('GUEST_AUTHENTICATION_FAILED', `Credential "${conf.credentialRef}" not found in the credential store.`);
      c = { username: stored.username ?? conf.username ?? '', password: stored.password, privateKey: stored.privateKey, passphrase: stored.passphrase, domain: stored.domain ?? conf.domain };
    }
    c ??= { username: conf.username ?? '', domain: conf.domain };
    if (!c.password && conf.passwordEnv) c.password = process.env[conf.passwordEnv];
    if (!c.privateKey && conf.ssh?.privateKeyPath) {
      if (!existsSync(conf.ssh.privateKeyPath)) throw new VBoxMcpError('INVALID_CONFIGURATION', `SSH private key not found: ${conf.ssh.privateKeyPath}`);
      c.privateKey = readFileSync(conf.ssh.privateKeyPath, 'utf8');
      if (conf.ssh.passphraseEnv) c.passphrase = process.env[conf.ssh.passphraseEnv];
    }
    if (!c.username) {
      // Fall back to a credential stored under the VM's name or UUID.
      const stored = this.creds.available ? (this.creds.get(vm.uuid) ?? this.creds.get(vm.name)) : undefined;
      if (stored?.username) c = { ...stored, username: stored.username };
    }
    if (!c.username) {
      throw new VBoxMcpError('GUEST_AUTHENTICATION_FAILED', `No guest credentials configured for VM "${vm.name}". Configure vms["${vm.name}"].connection or store credentials with set_guest_credentials.`);
    }
    registerSecret(c.password);
    registerSecret(c.passphrase);
    return c;
  }

  knownHostFingerprint(host: string, port: number): string | undefined {
    if (!existsSync(this.knownHostsPath)) return undefined;
    try {
      return (JSON.parse(readFileSync(this.knownHostsPath, 'utf8')) as Record<string, string>)[`${host}:${port}`];
    } catch {
      return undefined;
    }
  }

  trustHostKey(host: string, port: number, fingerprint: string): void {
    const all: Record<string, string> = existsSync(this.knownHostsPath) ? JSON.parse(readFileSync(this.knownHostsPath, 'utf8')) : {};
    all[`${host}:${port}`] = fingerprint;
    writeFileSync(this.knownHostsPath, JSON.stringify(all, null, 2), { mode: 0o600 });
    for (const [k, b] of this.cache) if (k.endsWith(':ssh')) void b.close().then(() => this.cache.delete(k));
  }

  async guestIp(vm: VmRef, adapter = 0): Promise<string | undefined> {
    const ip = await this.guestProperty(vm, `/VirtualBox/GuestInfo/Net/${adapter}/V4/IP`);
    return ip && ip !== 'No value set!' ? ip : undefined;
  }

  /** SSH endpoint: configured host, else NAT port-forward to guest port 22, else guest IP from Guest Additions. */
  async sshEndpoint(vm: VmRef, conf: GuestConnection): Promise<{ host: string; port: number }> {
    if (conf.ssh?.host) return { host: conf.ssh.host, port: conf.ssh.port ?? 22 };
    const info = await this.vms.info(vm);
    const guestPort = conf.ssh?.port ?? 22;
    for (const nic of info.nics) {
      const rule = nic.portForwarding.find((r) => r.protocol === 'tcp' && r.guestPort === guestPort);
      if (rule) return { host: rule.hostIp || '127.0.0.1', port: rule.hostPort };
    }
    const ip = await this.guestIp(vm);
    if (ip) return { host: ip, port: guestPort };
    throw new VBoxMcpError('GUEST_UNREACHABLE', `Cannot determine an SSH address for "${vm.name}": configure connection.ssh.host, add a NAT port-forward to guest port ${guestPort}, or install Guest Additions so the guest IP is reported.`);
  }

  async winrmEndpoint(vm: VmRef, conf: GuestConnection): Promise<{ host: string; port: number }> {
    const https = conf.winrm?.https ?? false;
    const guestPort = conf.winrm?.port ?? (https ? 5986 : 5985);
    if (conf.winrm?.host) return { host: conf.winrm.host, port: guestPort };
    const info = await this.vms.info(vm);
    for (const nic of info.nics) {
      const rule = nic.portForwarding.find((r) => r.protocol === 'tcp' && r.guestPort === guestPort);
      if (rule) return { host: rule.hostIp || '127.0.0.1', port: rule.hostPort };
    }
    const ip = await this.guestIp(vm);
    if (ip) return { host: ip, port: guestPort };
    throw new VBoxMcpError('GUEST_UNREACHABLE', `Cannot determine a WinRM address for "${vm.name}": configure connection.winrm.host or a NAT port-forward to guest port ${guestPort}.`);
  }

  async chooseBackend(vm: VmRef, os: GuestOsFamily, requested?: BackendName | 'auto'): Promise<BackendName> {
    const conf = this.connectionConfig(vm);
    const explicit = requested && requested !== 'auto' ? requested : conf.backend !== 'auto' ? conf.backend : this.cfg.execution.defaultBackend !== 'auto' ? this.cfg.execution.defaultBackend : undefined;
    if (explicit) {
      if (explicit === 'winrm' && os !== 'windows') throw new VBoxMcpError('INVALID_ARGUMENT', 'The WinRM backend only supports Windows guests.');
      return explicit;
    }
    const ga = await this.guestAdditionsStatus(vm);
    if (ga.guestControlUsable) return 'guestcontrol';
    if (os === 'windows' && conf.winrm) return 'winrm';
    if (conf.ssh || os === 'linux') return 'ssh';
    if (os === 'windows') return 'winrm';
    throw new VBoxMcpError('GUEST_UNREACHABLE', `No usable execution backend for "${vm.name}".`);
  }

  async connect(vm: VmRef, requested?: BackendName | 'auto'): Promise<ResolvedConnection> {
    const state = await this.vms.state(vm);
    if (state !== 'running') throw new VBoxMcpError('VM_NOT_RUNNING', `VM "${vm.name}" is not running (state: ${state}). Start it before executing guest operations.`);
    const { os } = await this.detectOs(vm);
    const name = await this.chooseBackend(vm, os, requested);
    const key = `${vm.uuid}:${name}`;
    const cached = this.cache.get(key);
    if (cached) return { backend: cached, os, vm };
    const conf = this.connectionConfig(vm);
    const creds = await this.credentials(vm, conf);
    let backend: GuestBackend;
    if (name === 'guestcontrol') {
      const ga = await this.guestAdditionsStatus(vm);
      if (!ga.guestControlUsable) throw new VBoxMcpError('GUEST_ADDITIONS_NOT_INSTALLED', `Guest Control is not available for "${vm.name}": ${ga.detail}`);
      backend = new GuestControlBackend(this.vbox, vm.uuid, os, creds);
    } else if (name === 'ssh') {
      const ep = await this.sshEndpoint(vm, conf);
      backend = new SshBackend({ ...ep, hostKeyFingerprint: conf.ssh?.hostKeyFingerprint ?? this.knownHostFingerprint(ep.host, ep.port) }, os, creds);
    } else {
      const ep = await this.winrmEndpoint(vm, conf);
      backend = new WinRmBackend({ ...ep, https: conf.winrm?.https ?? false, path: conf.winrm?.path ?? '/wsman', rejectUnauthorized: conf.winrm?.rejectUnauthorized ?? true }, creds);
    }
    this.cache.set(key, backend);
    return { backend, os, vm };
  }

  async invalidate(vm: VmRef): Promise<void> {
    for (const [k, b] of this.cache) {
      if (k.startsWith(vm.uuid)) {
        await b.close().catch(() => undefined);
        this.cache.delete(k);
      }
    }
    this.shellCache.delete(vm.uuid);
  }

  async detectShells(conn: ResolvedConnection, refresh = false): Promise<ShellAvailability[]> {
    const cached = this.shellCache.get(conn.vm.uuid);
    if (cached && !refresh) return cached;
    const kinds = shellsForOs(conn.os);
    const paths = kinds.flatMap((k) => SHELLS[k].paths);
    let found: Set<string>;
    if (conn.os === 'linux') {
      const script = paths.map((p) => `[ -x '${p}' ] && echo '${p}'`).join('; ') + '; exit 0';
      const r = await conn.backend.exec({ exe: '/bin/sh', args: ['-c', script], timeoutMs: 20000, maxOutputBytes: 65536 });
      found = new Set(r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    } else {
      const line = paths.map((p) => `if exist "${p}" echo ${p}`).join(' & ');
      const r = await conn.backend.exec({ exe: SHELLS.cmd.paths[0]!, args: ['/d', '/s', '/c', `"${line}"`], timeoutMs: 30000, maxOutputBytes: 65536, verbatimArgs: true });
      found = new Set(r.stdout.split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean));
    }
    const res = kinds.map((k) => {
      const p = SHELLS[k].paths.find((x) => found.has(conn.os === 'windows' ? x.toLowerCase() : x));
      return { shell: k, available: !!p, path: p, label: SHELLS[k].label };
    });
    this.shellCache.set(conn.vm.uuid, res);
    return res;
  }

  defaultShell(vm: VmRef, os: GuestOsFamily): ShellKind {
    return this.connectionConfig(vm).defaultShell ?? defaultShellFor(os);
  }

  /** Resolves the shell to use. An explicitly requested shell is never silently substituted. */
  async resolveShell(conn: ResolvedConnection, requested?: ShellKind): Promise<{ shell: ShellKind; path: string }> {
    const shells = await this.detectShells(conn);
    if (requested) {
      if (SHELLS[requested].os !== conn.os) {
        throw new VBoxMcpError('SHELL_NOT_AVAILABLE', `Shell "${requested}" is not supported on ${conn.os} guests. Available: ${shells.filter((s) => s.available).map((s) => s.shell).join(', ') || 'none'}.`);
      }
      const s = shells.find((x) => x.shell === requested);
      if (!s?.available || !s.path) {
        throw new VBoxMcpError('SHELL_NOT_AVAILABLE', `Shell "${requested}" was not found in guest "${conn.vm.name}". Available: ${shells.filter((x) => x.available).map((x) => x.shell).join(', ') || 'none'}.`);
      }
      return { shell: requested, path: s.path };
    }
    const preferred = this.defaultShell(conn.vm, conn.os);
    const order: ShellKind[] = [preferred, ...shellsForOs(conn.os).filter((k) => k !== preferred)];
    for (const k of order) {
      const s = shells.find((x) => x.shell === k);
      if (s?.available && s.path) return { shell: k, path: s.path };
    }
    throw new VBoxMcpError('SHELL_NOT_AVAILABLE', `No supported shell was found in guest "${conn.vm.name}".`);
  }

  async closeAll(): Promise<void> {
    for (const b of this.cache.values()) await b.close().catch(() => undefined);
    this.cache.clear();
  }
}
