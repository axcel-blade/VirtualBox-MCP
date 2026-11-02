# Architecture

VirtualBox MCP is a layered TypeScript service. AI reasoning and planning stay in the connected MCP client. The server provides reliable tools and enforces permissions on its own.

```
MCP client (ForgePilot, X.A.N.A, …)
        │  STDIO / Streamable HTTP
        ▼
Tools · Resources · Prompts          (planned: src/tools, src/resources, src/prompts)
        │
SecurityManager ── ApprovalStore · CredentialStore · AuditLog · RateLimiter
        │
Managers: VM · Connection · Execution · Terminal · File  (+ planned: package, snapshot,
          network, storage, device, monitoring, group, orchestration)
        │
Backends: Guest Control · SSH · WinRM          VBoxClient (VBoxManage CLI)
```

## Source layout

| Path | Responsibility |
|---|---|
| `src/config/` | Zod schema, defaults, environment overrides, validation |
| `src/core/errors.ts` | Structured error codes (`VM_NOT_FOUND`, `APPROVAL_REQUIRED`, …) |
| `src/core/vbox-client.ts` | Runs `VBoxManage` with argument arrays, timeouts and error mapping |
| `src/core/parsers.ts` | Pure parsers for `--machinereadable` and list output |
| `src/core/shells.ts` | Shell definitions, quoting, and invocation builders for the four shells |
| `src/platforms/detect.ts` | Host and VirtualBox installation detection |
| `src/backends/` | `GuestBackend` implementations: `guest-control`, `ssh`, `winrm` |
| `src/managers/` | Feature logic used by tools |
| `src/security/` | Policy engine, approvals, credentials, redaction, path guards |
| `src/logging/` | Pino logger (stderr) and JSONL audit log |
| `src/utils/process.ts` | Shell-free process runner with bounded output |

## Key design decisions

- **No host shell.** Every host process is spawned with `shell: false` and an argument array.
- **Guest commands are shell source code.** They are passed as a single argument to the chosen shell (`bash -c`, `powershell -EncodedCommand`, `cmd /d /s /c`) and are never re-parsed on the host.
- **Backend abstraction.** All three backends implement `exec`, file I/O, transfers and `openShell`, so the managers don't depend on a particular backend.
- **Genuine persistent terminals.** Each session is one long-lived guest shell process (an SSH channel with an optional PTY, a WinRM command, or a `guestcontrol run` process). The terminal manager never simulates a session with one-off commands.
- **Permissions are enforced by the server**, independently of the model's instructions (see [SECURITY-MODEL.md](SECURITY-MODEL.md)).
