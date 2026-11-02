# Configuration

The server looks for configuration in this order (first match wins):

1. An explicit path passed by the CLI
2. `VBOX_MCP_CONFIG`
3. `./virtualbox-mcp.config.json`
4. `~/.virtualbox-mcp/config.json`

Environment variables then override file values. The result is validated with Zod; invalid settings fail with `INVALID_CONFIGURATION`.

## Example

```json
{
  "virtualbox": { "executablePath": "auto", "defaultVmDirectory": "auto" },
  "transport": { "stdio": true, "http": false, "httpPort": 3000 },
  "execution": {
    "defaultBackend": "auto",
    "defaultTimeout": 60000,
    "maximumTimeout": 600000,
    "maximumConcurrentCommands": 5,
    "maximumOutputBytes": 1048576
  },
  "security": {
    "readOnlyAutoApproval": true,
    "allowOrdinaryGuestModifications": true,
    "requireApprovalForDestructiveOperations": true,
    "allowHostExecution": false
  },
  "terminal": { "persistentSessions": true, "sessionTimeout": 3600000, "maximumSessions": 10 },
  "files": { "stagingDirectories": ["/home/me/vbox-staging"] },
  "vms": {
    "Ubuntu-Dev": {
      "tags": ["linux", "dev"],
      "policy": { "access": "modify" },
      "connection": {
        "backend": "ssh",
        "username": "dev",
        "ssh": { "privateKeyPath": "/home/me/.ssh/id_ed25519", "hostKeyFingerprint": "SHA256:..." }
      }
    },
    "Win11": {
      "policy": { "access": "read" },
      "connection": { "backend": "winrm", "username": "Administrator", "passwordEnv": "WIN11_PASSWORD", "winrm": { "https": true } }
    }
  }
}
```

`allowHostExecution` can only be `false`. The server never exposes host command execution.

## Environment variables

| Variable | Setting |
|---|---|
| `VBOX_MCP_VBOXMANAGE_PATH` | `virtualbox.executablePath` |
| `VBOX_MCP_VM_DIRECTORY` | `virtualbox.defaultVmDirectory` |
| `VBOX_MCP_STDIO` / `VBOX_MCP_HTTP` | Enable or disable each transport |
| `VBOX_MCP_HTTP_PORT` / `VBOX_MCP_HTTP_HOST` | HTTP bind settings |
| `VBOX_MCP_HTTP_TOKEN` | Bearer token, required when HTTP is enabled (16+ characters) |
| `VBOX_MCP_TLS_CERT` / `VBOX_MCP_TLS_KEY` | TLS for HTTP |
| `VBOX_MCP_DEFAULT_TIMEOUT` / `VBOX_MCP_MAX_TIMEOUT` | Command timeouts (ms) |
| `VBOX_MCP_MAX_CONCURRENT` | Concurrent guest commands |
| `VBOX_MCP_MAX_OUTPUT_BYTES` | Output cap per stream |
| `VBOX_MCP_REQUIRE_APPROVAL` | Require approval for destructive operations |
| `VBOX_MCP_ALLOW_GUEST_MODIFICATIONS` | Allow ordinary guest modifications |
| `VBOX_MCP_MAX_SESSIONS` | Maximum terminal sessions |
| `VBOX_MCP_STAGING_DIRS` | Host staging directories (`;` or `,` separated) |
| `VBOX_MCP_STATE_DIR` | Approvals, credentials, audit log (default `~/.virtualbox-mcp`) |
| `VBOX_MCP_MASTER_KEY` | Key for the encrypted credential store |
| `VBOX_MCP_LOG_LEVEL` | Pino log level |

## Per-VM policy

| Field | Meaning |
|---|---|
| `access` | `none` (hidden), `read`, `modify`, `full` (destructive operations allowed, still subject to approval) |
| `allowExecution` / `allowLifecycle` / `allowFileWrite` | Capability switches |
| `allowedShells` | Restrict to a subset of `bash`, `sh`, `powershell`, `pwsh`, `cmd` |
| `deniedExecutables` | Guest program names that may never be invoked |

## Credentials

Guest credentials can come from (in order) `credentialRef` (the encrypted store), `passwordEnv`, `ssh.privateKeyPath`, or a stored credential named after the VM. Never put plaintext passwords in the config file.
