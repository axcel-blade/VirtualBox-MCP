# Guest Setup

When `backend` is `auto`, the server picks a backend in this order: Guest Control if Guest Additions are running, then WinRM (Windows, if configured), then SSH.

## Guest Additions (Guest Control)

1. Start the VM, then choose **Devices → Insert Guest Additions CD image**.
2. Linux: install build tools and kernel headers, then run `sudo sh /media/$USER/VBox_GAs_*/VBoxLinuxAdditions.run` and reboot.
3. Windows: run `VBoxWindowsAdditions.exe` from the CD and reboot.
4. Check the version from the host:

```bash
VBoxManage guestproperty get "<vm>" /VirtualBox/GuestAdd/Version
```

Guest Control needs a real guest account. On Windows the account must have a password.

## SSH (Linux guests)

1. Install and start an SSH server, for example `sudo apt install openssh-server`.
2. Make the guest reachable: a host-only or bridged adapter, or a NAT port-forward such as `VBoxManage modifyvm "<vm>" --natpf1 "ssh,tcp,127.0.0.1,2222,,22"`. The server finds NAT forwards automatically.
3. Get the host key fingerprint **from inside the guest** and put it in `ssh.hostKeyFingerprint`:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

4. Prefer key authentication (`ssh.privateKeyPath`).

## WinRM (Windows guests)

The WinRM backend uses Basic authentication. Use HTTPS outside isolated labs. In an elevated PowerShell inside the guest:

```powershell
Enable-PSRemoting -Force
Set-Item WSMan:\localhost\Service\Auth\Basic $true
```

For HTTPS, create a certificate and an HTTPS listener on port 5986, then set `winrm.https: true`. Only for a lab using HTTP on an isolated network, also run:

```powershell
Set-Item WSMan:\localhost\Service\AllowUnencrypted $true
```

Basic auth works with local accounts only. NTLM and Kerberos aren't supported yet.

## Shells

| Shell | Guest | Path probed |
|---|---|---|
| Bash | Linux | `/bin/bash`, `/usr/bin/bash`, `/usr/local/bin/bash` |
| POSIX sh | Linux | `/bin/sh`, `/usr/bin/sh` |
| Windows PowerShell | Windows | `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` |
| PowerShell 7 | Windows | `C:\Program Files\PowerShell\7\pwsh.exe` |
| CMD | Windows | `C:\Windows\System32\cmd.exe` |

If you request a shell explicitly and it isn't found, you get `SHELL_NOT_AVAILABLE`. The server never silently switches to another shell.

## Known limitations

- Guest Control has no PTY, so interactive programs that need a TTY should use SSH sessions.
- Guest Control terminals depend on `guestcontrol run` forwarding stdin, which can vary between VirtualBox versions.
