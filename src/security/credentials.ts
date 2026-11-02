import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VBoxMcpError } from '../core/errors.js';
import { registerSecret } from './redact.js';

export interface StoredCredential {
  username?: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  domain?: string;
}

interface EncryptedFile {
  version: 1;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

/** AES-256-GCM encrypted credential store; the key is derived (scrypt) from VBOX_MCP_MASTER_KEY. */
export class CredentialStore {
  readonly path: string;

  constructor(stateDir: string, private readonly masterKey: string | undefined) {
    this.path = join(stateDir, 'credentials.enc.json');
  }

  get available(): boolean {
    return !!this.masterKey && this.masterKey.length >= 16;
  }

  private requireKey(): string {
    if (!this.available) {
      throw new VBoxMcpError('INVALID_CONFIGURATION', 'Credential store requires VBOX_MCP_MASTER_KEY (at least 16 characters).');
    }
    return this.masterKey!;
  }

  private readAll(): Record<string, StoredCredential> {
    if (!existsSync(this.path)) return {};
    const key = this.requireKey();
    const file = JSON.parse(readFileSync(this.path, 'utf8')) as EncryptedFile;
    const k = scryptSync(key, Buffer.from(file.salt, 'base64'), 32);
    const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(file.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
    try {
      const plain = Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]);
      return JSON.parse(plain.toString('utf8'));
    } catch {
      throw new VBoxMcpError('INVALID_CONFIGURATION', 'Could not decrypt credential store (wrong VBOX_MCP_MASTER_KEY?).');
    }
  }

  private writeAll(all: Record<string, StoredCredential>): void {
    const key = this.requireKey();
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const k = scryptSync(key, salt, 32);
    const cipher = createCipheriv('aes-256-gcm', k, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(all), 'utf8'), cipher.final()]);
    const file: EncryptedFile = {
      version: 1,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
    writeFileSync(this.path, JSON.stringify(file), { mode: 0o600 });
  }

  get(ref: string): StoredCredential | undefined {
    const cred = this.readAll()[ref];
    if (cred) {
      registerSecret(cred.password);
      registerSecret(cred.passphrase);
    }
    return cred;
  }

  set(ref: string, cred: StoredCredential): void {
    const all = this.readAll();
    all[ref] = cred;
    registerSecret(cred.password);
    registerSecret(cred.passphrase);
    this.writeAll(all);
  }

  delete(ref: string): boolean {
    const all = this.readAll();
    if (!(ref in all)) return false;
    delete all[ref];
    this.writeAll(all);
    return true;
  }

  list(): Array<{ ref: string; username?: string; hasPassword: boolean; hasPrivateKey: boolean }> {
    if (!this.available || !existsSync(this.path)) return [];
    return Object.entries(this.readAll()).map(([ref, c]) => ({
      ref,
      username: c.username,
      hasPassword: !!c.password,
      hasPrivateKey: !!c.privateKey,
    }));
  }
}
