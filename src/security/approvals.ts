import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface ApprovalRecord {
  id: string;
  fingerprint: string;
  tool: string;
  vm?: string;
  description: string;
  reasons: string[];
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'approved' | 'denied' | 'consumed';
  decidedAt?: string;
  decidedBy?: string;
}

/**
 * Stores approval requests on disk so a human can approve them out-of-band
 * (`virtualbox-mcp approve <id>` or the authenticated HTTP admin endpoint). The AI client
 * cannot approve its own requests through MCP tools.
 */
export class ApprovalStore {
  private readonly dir: string;

  constructor(stateDir: string, private readonly ttlMs: number) {
    this.dir = join(stateDir, 'approvals');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  static fingerprint(tool: string, vm: string | undefined, payload: unknown): string {
    return createHash('sha256').update(JSON.stringify([tool, vm ?? '', payload])).digest('hex');
  }

  private file(id: string): string {
    if (!/^[a-f0-9]{16,64}$/.test(id)) throw new Error('Invalid approval id');
    return join(this.dir, `${id}.json`);
  }

  create(input: Omit<ApprovalRecord, 'id' | 'createdAt' | 'expiresAt' | 'status'>): ApprovalRecord {
    // Reuse an existing pending request for the same operation rather than piling up duplicates.
    const existing = this.list().find((r) => r.fingerprint === input.fingerprint && (r.status === 'pending' || r.status === 'approved'));
    if (existing) return existing;
    const now = Date.now();
    const rec: ApprovalRecord = {
      ...input,
      id: randomBytes(12).toString('hex'),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      status: 'pending',
    };
    this.save(rec);
    return rec;
  }

  get(id: string): ApprovalRecord | undefined {
    const f = this.file(id);
    if (!existsSync(f)) return undefined;
    const rec = JSON.parse(readFileSync(f, 'utf8')) as ApprovalRecord;
    if (Date.parse(rec.expiresAt) < Date.now() && rec.status !== 'consumed') {
      unlinkSync(f);
      return undefined;
    }
    return rec;
  }

  list(): ApprovalRecord[] {
    const out: ApprovalRecord[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const rec = this.get(name.slice(0, -5));
        if (rec) out.push(rec);
      } catch {
        // ignore malformed entries
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  decide(id: string, approved: boolean, by: string): ApprovalRecord {
    const rec = this.get(id);
    if (!rec) throw new Error(`Approval ${id} not found or expired`);
    if (rec.status !== 'pending') throw new Error(`Approval ${id} is already ${rec.status}`);
    rec.status = approved ? 'approved' : 'denied';
    rec.decidedAt = new Date().toISOString();
    rec.decidedBy = by;
    this.save(rec);
    return rec;
  }

  /** Atomically consumes an approved request whose fingerprint matches. Single use. */
  consume(id: string, fingerprint: string): boolean {
    const rec = this.get(id);
    if (!rec || rec.status !== 'approved' || rec.fingerprint !== fingerprint) return false;
    rec.status = 'consumed';
    this.save(rec);
    return true;
  }

  private save(rec: ApprovalRecord): void {
    writeFileSync(this.file(rec.id), JSON.stringify(rec, null, 2), { mode: 0o600 });
  }
}
