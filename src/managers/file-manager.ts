import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from '../config/schema.js';
import { VBoxMcpError } from '../core/errors.js';
import { quotePosix, quotePwsh } from '../core/shells.js';
import { assertHostPathAllowed, normalizeGuestPath, isProtectedGuestPath } from '../security/paths.js';
import type { VmRef } from '../security/security-manager.js';
import { GuestOps, asArray } from './guest-ops.js';

export interface GuestFileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  mode?: string;
  owner?: string;
  modified?: string;
}

export interface TransferRecord {
  id: string;
  vmName: string;
  direction: 'upload' | 'download';
  hostPath: string;
  guestPath: string;
  recursive: boolean;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  bytesTransferred: number;
  totalBytes?: number;
  attempts: number;
  checksum?: { algorithm: 'sha256'; host?: string; guest?: string; verified?: boolean };
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export function sha256File(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('end', () => res(h.digest('hex')))
      .on('error', rej);
  });
}

function typeFromFind(t: string): GuestFileEntry['type'] {
  return t === 'f' ? 'file' : t === 'd' ? 'directory' : t === 'l' ? 'symlink' : 'other';
}

/** Guest filesystem operations and host↔guest transfers. */
export class FileManager {
  private transfers = new Map<string, TransferRecord & { ctl: AbortController }>();

  constructor(private readonly cfg: Config, private readonly ops: GuestOps) {}

  async guestPath(vm: VmRef, p: string): Promise<{ path: string; os: 'linux' | 'windows' }> {
    const os = await this.ops.os(vm);
    return { path: normalizeGuestPath(p, os), os };
  }

  isProtected(path: string, os: 'linux' | 'windows'): boolean {
    return isProtectedGuestPath(path, os, this.cfg.files.protectedGuestPaths);
  }

  async list(vm: VmRef, p: string, opts: { showHidden?: boolean } = {}): Promise<GuestFileEntry[]> {
    const { path } = await this.guestPath(vm, p);
    const linux = `find ${quotePosix(path)} -mindepth 1 -maxdepth 1 ${opts.showHidden ? '' : "! -name '.*'"} -printf '%y\\t%s\\t%m\\t%u\\t%TY-%Tm-%TdT%TH:%TM:%TS\\t%p\\n' 2>/dev/null || ls -la ${quotePosix(path)}`;
    const win = `Get-ChildItem -LiteralPath ${quotePwsh(path)} ${opts.showHidden ? '-Force' : ''} | Select-Object Name, FullName, Length, @{n='Dir';e={$_.PSIsContainer}}, @{n='Modified';e={$_.LastWriteTimeUtc.ToString('o')}}, @{n='Mode';e={$_.Mode}}`;
    const os = await this.ops.os(vm);
    if (os === 'windows') {
      const items = asArray(await this.ops.json<any>(vm, win, { label: 'list_guest_files' }));
      return items.map((i) => ({ name: i.Name, path: i.FullName, type: i.Dir ? 'directory' : 'file', size: Number(i.Length ?? 0), mode: i.Mode, modified: i.Modified }));
    }
    const out = await this.ops.output(vm, linux, null, { label: 'list_guest_files' });
    const lines = out.split('\n').filter(Boolean);
    if (lines.length && !lines[0]!.includes('\t')) {
      // Fallback (non-GNU find): return raw ls output parsed loosely.
      return lines.filter((l) => !l.startsWith('total')).map((l) => {
        const parts = l.trim().split(/\s+/);
        const name = parts.slice(8).join(' ');
        return { name, path: `${path.replace(/\/$/, '')}/${name}`, type: l[0] === 'd' ? 'directory' : l[0] === 'l' ? 'symlink' : 'file', size: Number(parts[4] ?? 0), mode: parts[0], owner: parts[2] };
      });
    }
    return lines.map((l) => {
      const [t, size, mode, owner, mtime, full] = l.split('\t');
      return { name: (full ?? '').split('/').pop() ?? '', path: full ?? '', type: typeFromFind(t ?? ''), size: Number(size), mode, owner, modified: mtime?.replace(/\.\d+$/, '') };
    });
  }

  async info(vm: VmRef, p: string): Promise<Record<string, unknown>> {
    const { path, os } = await this.guestPath(vm, p);
    if (os === 'windows') {
      const i = await this.ops.json<any>(vm, `Get-Item -LiteralPath ${quotePwsh(path)} -Force | Select-Object Name, FullName, Length, Mode, Attributes, @{n='IsDirectory';e={$_.PSIsContainer}}, @{n='Created';e={$_.CreationTimeUtc.ToString('o')}}, @{n='Modified';e={$_.LastWriteTimeUtc.ToString('o')}}, @{n='Owner';e={(Get-Acl -LiteralPath $_.FullName).Owner}}`);
      return { ...i, Attributes: String(i.Attributes) };
    }
    const out = await this.ops.output(vm, `stat -c '%F|%s|%a|%A|%U|%G|%Y|%X|%i|%h|%N' -- ${quotePosix(path)}`, null);
    const [type, size, octal, perms, user, group, mtime, atime, inode, links, ...name] = out.trim().split('|');
    return { path, type, size: Number(size), mode: octal, permissions: perms, owner: user, group, modified: new Date(Number(mtime) * 1000).toISOString(), accessed: new Date(Number(atime) * 1000).toISOString(), inode, links: Number(links), name: name.join('|') };
  }

  async read(vm: VmRef, p: string, opts: { maxBytes?: number; encoding?: 'utf8' | 'base64' } = {}): Promise<{ path: string; size: number; content: string; encoding: string }> {
    const { path } = await this.guestPath(vm, p);
    const conn = await this.ops.connections.connect(vm);
    const buf = await conn.backend.readFile(path, Math.min(opts.maxBytes ?? this.cfg.files.maxInlineReadBytes, this.cfg.files.maxInlineReadBytes));
    const binary = buf.includes(0);
    const encoding = opts.encoding ?? (binary ? 'base64' : 'utf8');
    return { path, size: buf.length, content: buf.toString(encoding), encoding };
  }

  async exists(vm: VmRef, path: string): Promise<boolean> {
    const r = await this.ops.run(vm, `test -e ${quotePosix(path)}`, `if (Test-Path -LiteralPath ${quotePwsh(path)}) { exit 0 } else { exit 1 }`);
    return r.exitCode === 0;
  }

  async write(vm: VmRef, p: string, content: string, opts: { encoding?: 'utf8' | 'base64'; append?: boolean; createParents?: boolean } = {}): Promise<{ path: string; bytes: number }> {
    const { path, os } = await this.guestPath(vm, p);
    const data = Buffer.from(content, opts.encoding ?? 'utf8');
    if (opts.createParents) await this.mkdir(vm, path.replace(os === 'windows' ? /\\[^\\]+$/ : /\/[^/]+$/, '') || '/', true);
    const conn = await this.ops.connections.connect(vm);
    if (opts.append) {
      let existing: Buffer = Buffer.alloc(0);
      if (await this.exists(vm, path)) existing = await conn.backend.readFile(path, this.cfg.files.maxInlineReadBytes);
      await conn.backend.writeFile(path, Buffer.concat([existing, data]));
    } else await conn.backend.writeFile(path, data);
    return { path, bytes: data.length };
  }

  async mkdir(vm: VmRef, p: string, parents = true): Promise<string> {
    const { path } = await this.guestPath(vm, p);
    await this.ops.output(vm, `mkdir ${parents ? '-p ' : ''}-- ${quotePosix(path)}`, `New-Item -ItemType Directory ${parents ? '-Force ' : ''}-Path ${quotePwsh(path)} | Out-Null`);
    return path;
  }

  async remove(vm: VmRef, p: string, opts: { recursive?: boolean; directory?: boolean } = {}): Promise<string> {
    const { path } = await this.guestPath(vm, p);
    const linux = opts.directory ? (opts.recursive ? `rm -rf -- ${quotePosix(path)}` : `rmdir -- ${quotePosix(path)}`) : `rm -f -- ${quotePosix(path)}`;
    const win = opts.directory
      ? `Remove-Item -LiteralPath ${quotePwsh(path)} ${opts.recursive ? '-Recurse ' : ''}-Force -ErrorAction Stop`
      : `if ((Get-Item -LiteralPath ${quotePwsh(path)} -Force).PSIsContainer) { throw 'Path is a directory' }; Remove-Item -LiteralPath ${quotePwsh(path)} -Force -ErrorAction Stop`;
    await this.ops.output(vm, linux, win);
    return path;
  }

  async move(vm: VmRef, from: string, to: string, overwrite: boolean): Promise<{ from: string; to: string }> {
    const a = (await this.guestPath(vm, from)).path;
    const b = (await this.guestPath(vm, to)).path;
    await this.ops.output(vm, `mv ${overwrite ? '-f' : '-n'} -- ${quotePosix(a)} ${quotePosix(b)}`, `Move-Item -LiteralPath ${quotePwsh(a)} -Destination ${quotePwsh(b)} ${overwrite ? '-Force' : ''} -ErrorAction Stop`);
    return { from: a, to: b };
  }

  async copy(vm: VmRef, from: string, to: string, opts: { recursive?: boolean; overwrite?: boolean }): Promise<{ from: string; to: string }> {
    const a = (await this.guestPath(vm, from)).path;
    const b = (await this.guestPath(vm, to)).path;
    await this.ops.output(
      vm,
      `cp ${opts.recursive ? '-R ' : ''}${opts.overwrite ? '-f' : '-n'} -- ${quotePosix(a)} ${quotePosix(b)}`,
      `Copy-Item -LiteralPath ${quotePwsh(a)} -Destination ${quotePwsh(b)} ${opts.recursive ? '-Recurse ' : ''}${opts.overwrite ? '-Force ' : ''}-ErrorAction Stop`,
    );
    return { from: a, to: b };
  }

  async search(vm: VmRef, root: string, opts: { pattern: string; contentPattern?: string; maxResults?: number; type?: 'file' | 'directory' }): Promise<string[]> {
    const { path } = await this.guestPath(vm, root);
    const max = Math.min(opts.maxResults ?? 200, 5000);
    const t = opts.type === 'directory' ? '-type d' : opts.type === 'file' ? '-type f' : '';
    const linux = opts.contentPattern
      ? `grep -rlI --include=${quotePosix(opts.pattern)} -e ${quotePosix(opts.contentPattern)} -- ${quotePosix(path)} 2>/dev/null | head -n ${max}`
      : `find ${quotePosix(path)} ${t} -name ${quotePosix(opts.pattern)} 2>/dev/null | head -n ${max}`;
    const win = opts.contentPattern
      ? `Get-ChildItem -LiteralPath ${quotePwsh(path)} -Recurse -File -Filter ${quotePwsh(opts.pattern)} -ErrorAction SilentlyContinue | Select-String -Pattern ${quotePwsh(opts.contentPattern)} -List -ErrorAction SilentlyContinue | Select-Object -First ${max} -ExpandProperty Path`
      : `Get-ChildItem -LiteralPath ${quotePwsh(path)} -Recurse ${opts.type === 'directory' ? '-Directory' : opts.type === 'file' ? '-File' : ''} -Filter ${quotePwsh(opts.pattern)} -ErrorAction SilentlyContinue | Select-Object -First ${max} -ExpandProperty FullName`;
    const out = await this.ops.output(vm, linux, win, { allowExit: [1], timeoutMs: 300000 });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }

  async checksum(vm: VmRef, p: string, algorithm: 'sha256' | 'sha1' | 'md5' = 'sha256'): Promise<{ path: string; algorithm: string; hash: string }> {
    const { path } = await this.guestPath(vm, p);
    const out = await this.ops.output(vm, `${algorithm}sum -- ${quotePosix(path)}`, `(Get-FileHash -LiteralPath ${quotePwsh(path)} -Algorithm ${algorithm.toUpperCase()}).Hash`, { timeoutMs: 600000 });
    const hash = out.trim().split(/\s+/)[0]!.toLowerCase();
    if (!/^[0-9a-f]{32,64}$/.test(hash)) throw new VBoxMcpError('COMMAND_EXECUTION_FAILED', `Unexpected checksum output: ${out.slice(0, 200)}`);
    return { path, algorithm, hash };
  }

  // ---------------- transfers ----------------

  listTransfers(): TransferRecord[] {
    return [...this.transfers.values()].map(({ ctl: _c, ...t }) => t);
  }

  getTransfer(id: string): TransferRecord {
    const t = this.transfers.get(id);
    if (!t) throw new VBoxMcpError('NOT_FOUND', `Unknown transfer ${id}.`);
    const { ctl: _c, ...rest } = t;
    return rest;
  }

  cancelTransfer(id: string): boolean {
    const t = this.transfers.get(id);
    if (!t || t.status !== 'running') return false;
    t.ctl.abort();
    return true;
  }

  async transfer(vm: VmRef, req: { direction: 'upload' | 'download'; hostPath: string; guestPath: string; recursive: boolean; verify?: boolean; retries?: number; overwrite?: boolean; wait?: boolean }): Promise<TransferRecord> {
    const hostPath = assertHostPathAllowed(req.hostPath, this.cfg.files.stagingDirectories);
    const { path: guestPath, os } = await this.guestPath(vm, req.guestPath);
    if (req.direction === 'upload') {
      if (!existsSync(hostPath)) throw new VBoxMcpError('INVALID_ARGUMENT', `Host source not found: ${req.hostPath}`);
      const st = statSync(hostPath);
      if (st.isDirectory() !== req.recursive) throw new VBoxMcpError('INVALID_ARGUMENT', st.isDirectory() ? 'Source is a directory; use upload_directory_to_vm.' : 'Source is a file; use upload_file_to_vm.');
      if (!st.isDirectory() && st.size > this.cfg.files.maxTransferBytes) throw new VBoxMcpError('FILE_TRANSFER_FAILED', `File exceeds files.maxTransferBytes (${this.cfg.files.maxTransferBytes}).`);
      if (!req.overwrite && (await this.exists(vm, guestPath))) throw new VBoxMcpError('FILE_TRANSFER_FAILED', `Guest destination exists: ${guestPath}. Pass overwrite=true to replace it.`);
    } else {
      if (existsSync(hostPath) && !req.overwrite) throw new VBoxMcpError('FILE_TRANSFER_FAILED', `Host destination exists: ${req.hostPath}. Pass overwrite=true to replace it.`);
      mkdirSync(dirname(hostPath), { recursive: true });
    }
    const ctl = new AbortController();
    const rec: TransferRecord & { ctl: AbortController } = {
      id: randomUUID(),
      vmName: vm.name,
      direction: req.direction,
      hostPath,
      guestPath,
      recursive: req.recursive,
      status: 'running',
      bytesTransferred: 0,
      totalBytes: req.direction === 'upload' && !req.recursive ? statSync(hostPath).size : undefined,
      attempts: 0,
      startedAt: new Date().toISOString(),
      ctl,
    };
    this.transfers.set(rec.id, rec);
    const job = this.runTransfer(vm, rec, os, req.verify ?? !req.recursive, req.retries ?? 2);
    if (req.wait === false) {
      void job.catch(() => undefined);
      return this.getTransfer(rec.id);
    }
    await job.catch(() => undefined);
    return this.getTransfer(rec.id);
  }

  private async runTransfer(vm: VmRef, rec: TransferRecord & { ctl: AbortController }, _os: string, verify: boolean, retries: number): Promise<void> {
    const conn = await this.ops.connections.connect(vm);
    for (;;) {
      rec.attempts++;
      try {
        const opts = { recursive: rec.recursive, signal: rec.ctl.signal, onProgress: (n: number) => (rec.bytesTransferred = n) };
        if (rec.direction === 'upload') await conn.backend.upload(rec.hostPath, rec.guestPath, opts);
        else await conn.backend.download(rec.guestPath, rec.hostPath, opts);
        if (verify && !rec.recursive) {
          const host = await sha256File(rec.hostPath);
          const guest = (await this.checksum(vm, rec.guestPath)).hash;
          rec.checksum = { algorithm: 'sha256', host, guest, verified: host === guest };
          if (host !== guest) throw new VBoxMcpError('FILE_TRANSFER_FAILED', 'Checksum mismatch after transfer.');
        }
        if (rec.direction === 'download' && !rec.recursive) rec.bytesTransferred = statSync(rec.hostPath).size;
        rec.status = 'completed';
        rec.completedAt = new Date().toISOString();
        return;
      } catch (e) {
        if (rec.ctl.signal.aborted) {
          rec.status = 'cancelled';
          rec.completedAt = new Date().toISOString();
          return;
        }
        if (rec.attempts > retries) {
          rec.status = 'failed';
          rec.error = (e as Error).message;
          rec.completedAt = new Date().toISOString();
          throw e;
        }
        await new Promise((r) => setTimeout(r, 1000 * rec.attempts));
      }
    }
  }
}
