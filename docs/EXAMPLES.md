# Examples

These examples show intended usage once the tool layer is available. Tool names follow [TOOLS-REFERENCE.md](TOOLS-REFERENCE.md).

## Install Docker on an Ubuntu VM

1. `get_vm_state { "vm": "Ubuntu-Dev" }`. If the VM is powered off, call `start_vm_headless`, then `wait_for_vm_state` until it is `running`.
2. `detect_guest_os`, then `list_available_shells`. Expect `bash` to be available.
3. `open_terminal_session { "vm": "Ubuntu-Dev", "shell": "bash" }`
4. `send_terminal_input` with `sudo apt-get update && sudo apt-get install -y docker.io` (waiting for completion).
5. Check the exit code, then verify with `systemctl is-active docker`.

## Run a PowerShell query on Windows

```json
{ "vm": "Win11", "command": "Get-Service | Where-Object Status -eq 'Running' | Select-Object -First 10 Name" }
```

Send this to `execute_powershell`.

## Run CMD explicitly

```json
{ "vm": "Win11", "command": "ipconfig /all" }
```

Send this to `execute_cmd`. It always uses `cmd.exe`, never PowerShell.

## Destructive operation with approval

1. `delete_vm { "vm": "old-test", "deleteFiles": true }` returns `APPROVAL_REQUIRED` with an `approvalId`.
2. A human operator approves the request out-of-band.
3. Repeat the identical call with `"approvalId": "<id>"`.
