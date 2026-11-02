# Contributing to VirtualBox MCP

Thank you for helping improve VirtualBox MCP.

## Branching model (Git Flow)

| Branch | Purpose |
|---|---|
| `main` | Released, production-ready code. Every merge is tagged (`vX.Y.Z`). |
| `develop` | Integration branch for the next release. |
| `feature/*` | New work, branched from `develop` and merged back into `develop`. |
| `release/*` | Release preparation, branched from `develop` and merged into `main` and `develop`. |
| `hotfix/*` | Urgent fixes, branched from `main` and merged into `main` and `develop`. |

Start a feature from an up-to-date `develop`:

```bash
git checkout -b feature/short-description develop
```

## Workflow

1. Open or claim an issue before starting large changes.
2. Branch from `develop` (or from `main` for a hotfix).
3. Keep changes focused, and add tests alongside the code.
4. Run `npm run lint`, `npm run typecheck` and `npm test` before opening a pull request.
5. Open the pull request against `develop` (hotfixes target `main`) and fill in the template.

## Coding standards

- Use strict TypeScript, and avoid `any` unless you can justify it.
- Never run host processes through a shell; always pass argument arrays.
- Every new MCP tool must declare its permission category (read, modify or destructive).
- Never commit credentials, private keys or real host-key fingerprints.
- Logs go to stderr only, because stdout is reserved for the STDIO transport.

## Tests

- Unit tests use mocked `VBoxManage` output in `tests/fixtures/`.
- Integration tests must only use disposable VMs created for the test run. Never run destructive tests against existing machines.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/), for example `feat(terminal): add resize support` or `fix(ssh): handle host key mismatch`.
