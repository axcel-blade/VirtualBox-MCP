const SENSITIVE_KEYS = /pass(word|phrase)?|secret|token|private.?key|api.?key|credential|authorization/i;

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(--password[= ])(\S+)/gi,
  /(Authorization:\s*(?:Basic|Bearer)\s+)(\S+)/gi,
  /((?:password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
  /(-AsPlainText\s+-Force\s*)|(ConvertTo-SecureString\s+)("[^"]*"|'[^']*')/gi,
];

/** Known secret values (passwords, tokens) registered at runtime so they are scrubbed everywhere. */
const knownSecrets = new Set<string>();

export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 4) knownSecrets.add(value);
}

export function redactString(input: string): string {
  let out = input;
  for (const secret of knownSecrets) {
    if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
  }
  out = out.replace(PATTERNS[0]!, '[REDACTED PRIVATE KEY]');
  out = out.replace(PATTERNS[1]!, '$1[REDACTED]');
  out = out.replace(PATTERNS[2]!, '$1[REDACTED]');
  out = out.replace(PATTERNS[3]!, '$1[REDACTED]');
  out = out.replace(/(ConvertTo-SecureString\s+)("[^"]*"|'[^']*')/gi, '$1"[REDACTED]"');
  return out;
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > 12) return value;
  if (typeof value === 'string') return redactString(value) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) && typeof v === 'string' && v.length > 0 ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
