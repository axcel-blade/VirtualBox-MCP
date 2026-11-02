# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Project foundation: TypeScript, Vitest, ESLint, and a Zod-validated configuration with environment overrides.
- VirtualBox detection across Windows, Linux and macOS, plus host resource inspection.
- A safe `VBoxManage` client (argument arrays, timeouts, output limits, structured errors).
- Parsers for machine-readable VM info, VM lists, snapshot trees, block listings and metrics.
- Guest execution backends: VirtualBox Guest Control, SSH (with mandatory host-key verification) and WinRM (Basic auth).
- Shell support for Bash, POSIX sh, Windows PowerShell, PowerShell 7 and CMD.
- Managers for VMs, connections, execution, persistent terminals and guest files/transfers.
- Security layer: permission categories, per-VM policies, out-of-band approvals, an encrypted credential store, secret redaction, path traversal protection, rate limiting, an audit log and an emergency stop.
- Community files: contributing guide, code of conduct, security policy, support guide, and issue, pull request and discussion templates.

### Changed
- Renamed `LICENSE` to `LICENSE.md`.
