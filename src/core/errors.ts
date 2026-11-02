export const ErrorCodes = [
  'VBOX_NOT_INSTALLED',
  'VBOX_VERSION_UNSUPPORTED',
  'VM_NOT_FOUND',
  'VM_NOT_RUNNING',
  'VM_ALREADY_RUNNING',
  'VM_OPERATION_FAILED',
  'GUEST_ADDITIONS_NOT_INSTALLED',
  'GUEST_AUTHENTICATION_FAILED',
  'GUEST_UNREACHABLE',
  'SSH_CONNECTION_FAILED',
  'WINRM_CONNECTION_FAILED',
  'SHELL_NOT_AVAILABLE',
  'COMMAND_TIMEOUT',
  'COMMAND_CANCELLED',
  'COMMAND_EXECUTION_FAILED',
  'PERMISSION_DENIED',
  'APPROVAL_REQUIRED',
  'FILE_TRANSFER_FAILED',
  'DISK_SPACE_INSUFFICIENT',
  'NETWORK_CONFIGURATION_FAILED',
  'SNAPSHOT_OPERATION_FAILED',
  'SESSION_NOT_FOUND',
  'INVALID_CONFIGURATION',
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'EMERGENCY_STOP_ACTIVE',
  'RATE_LIMITED',
  'BUDGET_EXCEEDED',
] as const;

export type ErrorCode = (typeof ErrorCodes)[number];

export class VBoxMcpError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'VBoxMcpError';
    this.code = code;
    this.details = details;
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}

export function isVBoxMcpError(err: unknown): err is VBoxMcpError {
  return err instanceof VBoxMcpError;
}

export function toVBoxMcpError(err: unknown, fallback: ErrorCode = 'VM_OPERATION_FAILED'): VBoxMcpError {
  if (err instanceof VBoxMcpError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new VBoxMcpError(fallback, message);
}
