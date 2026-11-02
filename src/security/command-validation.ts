import type { ShellKind } from '../config/schema.js';

export interface CommandAssessment {
  destructive: boolean;
  reasons: string[];
}

interface Rule {
  pattern: RegExp;
  reason: string;
  shells?: ShellKind[];
}

const POSIX: ShellKind[] = ['bash', 'sh'];
const WIN: ShellKind[] = ['powershell', 'pwsh', 'cmd'];

const RULES: Rule[] = [
  { pattern: /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+)*(-[a-zA-Z]*\s+)*(\/|\/\*|~|\$HOME|\/(bin|boot|etc|home|lib|lib64|opt|root|sbin|srv|usr|var)\/?)(\s|$|;|&|\|)/, reason: 'Recursive deletion of a system or home directory', shells: POSIX },
  { pattern: /--no-preserve-root/, reason: 'rm --no-preserve-root', shells: POSIX },
  { pattern: /\bmkfs(\.[a-z0-9]+)?\b/, reason: 'Filesystem formatting (mkfs)', shells: POSIX },
  { pattern: /\b(wipefs|shred|blkdiscard|sgdisk\s+(-Z|--zap-all)|fdisk|parted|sfdisk)\b/, reason: 'Disk partitioning or wiping', shells: POSIX },
  { pattern: /\bdd\b[^|;&]*\bof=\/dev\/(sd|hd|vd|nvme|xvd|mmcblk|disk)/, reason: 'Raw write to a block device (dd)', shells: POSIX },
  { pattern: />\s*\/dev\/(sd|hd|vd|nvme|xvd)[a-z0-9]*/, reason: 'Redirecting output to a block device', shells: POSIX },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/, reason: 'Fork bomb', shells: POSIX },
  { pattern: /\b(passwd|chpasswd|usermod\s+[^;]*-p)\b/, reason: 'Changing account credentials', shells: POSIX },
  { pattern: /\b(setenforce\s+0|ufw\s+disable|systemctl\s+(stop|disable|mask)\s+(firewalld|ufw|apparmor|auditd|sshd?)\b|iptables\s+-F)/, reason: 'Disabling a security control', shells: POSIX },
  { pattern: /\bchmod\s+(-R\s+)?[0-7]*777\s+\/(\s|$)/, reason: 'World-writable permissions on /', shells: POSIX },
  { pattern: /\bchown\s+-R\s+\S+\s+\/(\s|$)/, reason: 'Recursive ownership change on /', shells: POSIX },
  { pattern: /\b(Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition)\b/i, reason: 'Disk formatting or partition removal', shells: WIN },
  { pattern: /\bformat(\.com)?\s+[a-z]:/i, reason: 'Formatting a volume', shells: WIN },
  { pattern: /\bdiskpart\b/i, reason: 'diskpart', shells: WIN },
  { pattern: /\b(Remove-Item|rm|del|erase|rd|rmdir)\b[^;\n]*\s[a-z]:\\(windows|users|program files[^\\]*)?\\?["']?(\s|$|;)/i, reason: 'Deleting a system directory or drive root', shells: WIN },
  { pattern: /\b(rd|rmdir)\s+\/s\b[^;\n]*[a-z]:\\(\s|$)/i, reason: 'Recursive deletion of a drive root', shells: WIN },
  { pattern: /Set-MpPreference\s+[^;\n]*-Disable\w+\s+\$?true/i, reason: 'Disabling Microsoft Defender', shells: WIN },
  { pattern: /\b(Set-NetFirewallProfile\s+[^;\n]*-Enabled\s+(False|\$false|0)|netsh\s+advfirewall\s+set\s+\w+\s+state\s+off)/i, reason: 'Disabling the Windows firewall', shells: WIN },
  { pattern: /\b(net\s+user\s+\S+\s+\S+|Set-LocalUser\s+[^;\n]*-Password)/i, reason: 'Changing account credentials', shells: WIN },
  { pattern: /\b(bcdedit|vssadmin\s+delete|wbadmin\s+delete|cipher\s+\/w)/i, reason: 'Boot configuration or backup deletion', shells: WIN },
];

/**
 * Heuristic classification of guest commands. A match escalates the command to the destructive
 * category (explicit approval). This is defence in depth, not a sandbox: per-VM policy remains the
 * primary control.
 */
export function assessCommand(command: string, shell: ShellKind): CommandAssessment {
  const reasons = RULES.filter((r) => (!r.shells || r.shells.includes(shell)) && r.pattern.test(command)).map((r) => r.reason);
  return { destructive: reasons.length > 0, reasons };
}

export function executableBasename(exe: string): string {
  const base = exe.split(/[\\/]/).pop() ?? exe;
  return base.toLowerCase().replace(/\.(exe|com|bat|cmd)$/, '');
}

/** Rough extraction of invoked program names, used for executable deny-lists. */
export function invokedExecutables(command: string): string[] {
  return command
    .split(/[|;&\n]+|\$\(|`/)
    .map((seg) => seg.trim().replace(/^(sudo|exec|nohup|time|env(\s+\w+=\S+)*)\s+/, ''))
    .map((seg) => seg.split(/\s+/)[0] ?? '')
    .filter(Boolean)
    .map(executableBasename);
}
