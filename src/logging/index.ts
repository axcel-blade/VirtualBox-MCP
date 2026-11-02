import pino, { type Logger } from 'pino';
import { appendFileSync, existsSync, readFileSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from '../security/redact.js';

/** Logs always go to stderr: stdout is reserved for the STDIO MCP transport. */
export function createLogger(level: string): Logger {
  return pino(
    {
      level,
      base: { service: 'virtualbox-mcp' },
      redact: { paths: ['*.password', '*.token', '*.privateKey', '*.passphrase', 'password', 'token'], censor: '[REDACTED]' },
    },
    pino.destination(2),
  );
}

export interface AuditEntry {
  timestamp: string;
  tool: string;
  category: 'read' | 'modify' | 'destructive';
  vm?: string;
  outcome: 'success' | 'error' | 'denied' | 'approval_required';
  durationMs?: number;
  args?: unknown;
  error?: string;
  client?: string;
}

const MAX_AUDIT_BYTES = 20 * 1024 * 1024;

/** Append-only JSONL audit log with redaction and simple size-based rotation. */
export class AuditLog {
  readonly path: string;
  private recent: AuditEntry[] = [];

  constructor(stateDir: string, private readonly keepInMemory = 500) {
    this.path = join(stateDir, 'audit.jsonl');
  }

  record(entry: Omit<AuditEntry, 'timestamp'>): void {
    const full: AuditEntry = redact({ timestamp: new Date().toISOString(), ...entry });
    this.recent.push(full);
    if (this.recent.length > this.keepInMemory) this.recent.shift();
    try {
      if (existsSync(this.path) && statSync(this.path).size > MAX_AUDIT_BYTES) renameSync(this.path, `${this.path}.1`);
      appendFileSync(this.path, JSON.stringify(full) + '\n', { mode: 0o600 });
    } catch {
      // Audit persistence failures must not break tool execution; entries remain in memory.
    }
  }

  list(limit = 100): AuditEntry[] {
    if (this.recent.length >= limit || !existsSync(this.path)) return this.recent.slice(-limit);
    try {
      const lines = readFileSync(this.path, 'utf8').trim().split('\n').slice(-limit);
      return lines.filter(Boolean).map((l) => JSON.parse(l) as AuditEntry);
    } catch {
      return this.recent.slice(-limit);
    }
  }
}
