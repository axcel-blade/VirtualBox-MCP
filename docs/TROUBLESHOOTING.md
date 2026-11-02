# Troubleshooting

| Error code | Likely cause | Fix |
|---|---|---|
| `VBOX_NOT_INSTALLED` | `VBoxManage` not found | Install VirtualBox or set `VBOX_MCP_VBOXMANAGE_PATH` |
| `VBOX_VERSION_UNSUPPORTED` | VirtualBox older than 6.0 | Upgrade VirtualBox |
| `VM_NOT_FOUND` | Wrong name/UUID, or the VM policy is `access: none` | Run `list_vms`; check the policy |
| `VM_NOT_RUNNING` | Guest operation on a stopped VM | Start the VM first |
| `GUEST_ADDITIONS_NOT_INSTALLED` | Guest Additions missing or not started | See [GUEST-SETUP.md](GUEST-SETUP.md), or use SSH/WinRM |
| `GUEST_AUTHENTICATION_FAILED` | Wrong or missing credentials | Check `connection.username`, `passwordEnv` or `credentialRef` |
| `GUEST_UNREACHABLE` | No address for SSH/WinRM | Configure a host, a NAT port-forward, or install Guest Additions |
| `SSH_CONNECTION_FAILED` | Untrusted host key or a network problem | Verify the reported fingerprint inside the guest and configure it |
| `WINRM_CONNECTION_FAILED` | Listener, firewall or Basic auth disabled | See the WinRM section of [GUEST-SETUP.md](GUEST-SETUP.md) |
| `SHELL_NOT_AVAILABLE` | The requested shell isn't installed | Use `list_available_shells` |
| `COMMAND_TIMEOUT` | Exceeded the timeout | Pass a larger `timeoutMs` (capped by `maximumTimeout`) or use async execution |
| `APPROVAL_REQUIRED` | Destructive operation | A human operator approves it out-of-band, then the call is repeated with `approvalId` |
| `PERMISSION_DENIED` | VM policy, capability or staging directory restriction | Adjust the configuration |
| `EMERGENCY_STOP_ACTIVE` | Emergency stop is engaged | A human operator must clear it |
| `INVALID_CONFIGURATION` | Schema validation failed | Read the listed issues; HTTP also requires a token |

## Logs

Logs go to stderr (set the level with `VBOX_MCP_LOG_LEVEL=debug`). The audit trail is in `~/.virtualbox-mcp/audit.jsonl`.
