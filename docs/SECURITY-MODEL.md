# Security Model

To report a vulnerability, see [SECURITY.md](../SECURITY.md). This page describes how the server's controls work.

## Operation categories

| Category | Examples | Behaviour |
|---|---|---|
| Read-only | listing VMs, reading files, inspecting logs | Allowed when the VM policy grants `read` |
| Ordinary modification | installing packages, writing files, running scripts | Allowed autonomously when the VM policy grants `modify` and `allowOrdinaryGuestModifications` is on |
| Destructive / high-impact | deleting VMs or disks, restoring or deleting snapshots, forced power-off, deleting protected paths, flagged commands | Requires `full` access **and** explicit human approval |

## Approvals

When a destructive operation is requested, the server:

1. Asks the human through MCP elicitation, if the client supports it.
2. Otherwise, returns `APPROVAL_REQUIRED` with an `approvalId`. A human operator approves it out-of-band (with the CLI or the authenticated admin endpoint, both planned), and the client then repeats the *identical* call with that `approvalId`.

Approvals are single-use, expire (15 minutes by default), and are bound to a fingerprint of the tool, the VM and the arguments, so they can't be replayed for a different operation. MCP tools can't approve requests.

## Command screening

Commands are screened per shell for high-impact patterns, for example recursive deletion of system directories, `mkfs`, raw `dd` to block devices, `Format-Volume`, `diskpart`, disabling firewalls or Defender, and changing credentials. A match escalates the command to the destructive category. This is defence in depth, not a sandbox: per-VM policy is the primary control.

## Other controls

- **Argument-safe execution:** no host shell is ever used.
- **SSH host-key verification is mandatory.** Unknown keys are refused and the observed fingerprint is reported. Trusting a key is itself an approval-gated operation.
- **Credential store:** AES-256-GCM, with the key derived from `VBOX_MCP_MASTER_KEY` using scrypt. Guest Control passwords are passed in temporary files, never on a command line.
- **Redaction:** registered secrets, private keys, `--password` arguments and `Authorization` headers are scrubbed from output, errors and audit logs.
- **Host filesystem:** access is limited to the configured staging directories, with symlinks resolved. Guest paths must be absolute and free of `..`.
- **Limits:** command timeouts, output caps, concurrency semaphore, rate limiting, terminal session caps and idle timeouts.
- **Emergency stop:** blocks every non-read operation until a human operator clears it.
- **Audit log:** JSONL in the state directory, redacted and rotated at 20 MB.

A guest VM is never treated as automatically safe just because it is virtualised.
