# Security Policy

VirtualBox MCP can execute commands inside virtual machines and change VirtualBox configuration, so security reports are taken seriously.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x (pre-release) | Yes |

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report vulnerabilities privately through GitHub's **Security → Report a vulnerability** (private security advisories) on this repository. Please include:

- the affected version or commit,
- steps to reproduce,
- the impact (for example a permission bypass, command injection, credential exposure or path traversal).

You can expect an acknowledgement within 7 days and a fix or mitigation plan within 30 days for confirmed issues.

## Scope

In scope:

- bypassing the permission engine or the approval requirement for destructive operations,
- command or argument injection on the host,
- escaping the configured host staging directories,
- leaking credentials, private keys or tokens in output, logs or errors,
- authentication bypass on the HTTP transport.

Out of scope: vulnerabilities in VirtualBox itself or in guest operating systems.

See [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md) for how the server's security controls work.
