# Development Guide

## Git Flow

```
main ────●────────────────●──────────●──── (tagged releases)
          \              / \        /
hotfix/*   \            /   ●──────●        (from main → main + develop)
            \          /
release/*    \    ●───●                     (from develop → main + develop)
              \  /
develop ───●───●───●───●───●────────────────
            \     /   \   /
feature/*    ●───●     ●─●                  (from develop → develop)
```

| Branch | Created from | Merged into | Naming |
|---|---|---|---|
| `main` | — | — | Release tags `vX.Y.Z` |
| `develop` | `main` | — | — |
| `feature/*` | `develop` | `develop` | `feature/terminal-resize` |
| `release/*` | `develop` | `main` and `develop` | `release/0.2.0` |
| `hotfix/*` | `main` | `main` and `develop` | `hotfix/0.1.1` |

Release steps: create `release/X.Y.Z`, bump `package.json`, move the `[Unreleased]` entries in `CHANGELOG.md` under the new version, merge into `main`, tag it, then merge back into `develop`.

## Scripts

| Script | Purpose |
|---|---|
| `npm run build` | Compile to `dist/` |
| `npm run dev` | Run from source with `tsx` |
| `npm test` | Unit tests (Vitest) |
| `npm run test:integration` | Integration tests (disposable VMs only) |
| `npm run lint` | ESLint |
| `npm run typecheck` | Type check only |

## Markdown file naming

All Markdown files use uppercase names, for example `README.md`, `docs/ARCHITECTURE.md` and `.github/ISSUE_TEMPLATE/BUG_REPORT.md`.
