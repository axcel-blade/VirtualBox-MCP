# VirtualBox MCP

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI applications and agents manage Oracle VirtualBox virtual machines. It can also run commands inside Linux and Windows guests through Bash, POSIX sh, PowerShell and CMD.

> **Status: early development (0.1.0, unreleased).** The core modules are written, but the MCP tool layer, transports and tests are still being built. See [CHANGELOG.md](CHANGELOG.md).

## Features

| Area | Status |
|---|---|
| VirtualBox detection (Windows, Linux, macOS) | Implemented |
| VM discovery, lifecycle, creation, clone, import/export | Manager implemented |
| Guest execution: Guest Control, SSH, WinRM | Backends implemented |
| Bash, POSIX sh, PowerShell (5.1 / 7), CMD | Implemented |
| Persistent interactive terminals | Manager implemented |
| File management and transfers | Manager implemented |
| Permission engine, approvals, redaction, audit log | Implemented |
| Packages, administration, snapshots, networking, storage, devices, monitoring, orchestration | Planned |
| MCP tools (core VM, execution and file tools) | Implemented |
| MCP resources, prompts, remaining tools | Planned |
| STDIO transport and CLI (`serve`, `health`, `stop`, `resume`) | Implemented |
| Authenticated Streamable HTTP transport | Planned |

## Requirements

- Node.js 20 or newer
- VirtualBox 6.0 or newer (7.x recommended)
- For guest execution: Guest Additions, an SSH server (Linux), or WinRM (Windows)

## Quick start (development)

```bash
npm install
```

```bash
npm run build
```

Configuration is described in [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Installation](docs/INSTALLATION.md)
- [Configuration](docs/CONFIGURATION.md)
- [Tools reference](docs/TOOLS-REFERENCE.md)
- [Security model](docs/SECURITY-MODEL.md)
- [Guest setup](docs/GUEST-SETUP.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Examples](docs/EXAMPLES.md)
- [Development and Git Flow](docs/DEVELOPMENT.md)

## Community

- [Contributing](CONTRIBUTING.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md)
- [Support](SUPPORT.md)

## License

MIT. See [LICENSE.md](LICENSE.md).
