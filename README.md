<div align="center">

# Autodeploy

### Non-Blocking CI/CD Hook System for Cloudflare Workers Projects

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-brightgreen.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Cloudflare%20Workers-orange.svg)](https://workers.cloudflare.com/)
[![Hooks](https://img.shields.io/badge/Hook%20System-Codex%20%2B%20Claude-purple.svg)](https://claude.ai/code)
[![Deploy](https://img.shields.io/badge/Deploy-Non--Blocking-blue.svg)](#architecture)

**Autodeploy is a Codex- and Claude-friendly hook system that fires non-blocking Cloudflare Workers deploys after edits, pushes, or completed tasks. Parallel pre-checks, agent-neutral locks, and detached deploy processes keep your editor responsive while CI runs in the background.**

[Architecture](#architecture) | [Hooks](#hooks) | [Deploy Script](#deploy-script) | [Configuration](#configuration) | [Usage](#usage)

</div>

---

## Overview

Autodeploy replaces manual deploy commands and slow sequential CI pipelines with event-driven, non-blocking deploys triggered from Claude Code hooks or Codex/manual after-task runs.

Every hook follows the same contract:
- **Non-blocking** — deploys spawn detached child processes; the hook returns immediately
- **Debounced** — a stamp file prevents concurrent deploys from racing
- **Advisory-locked** — per-repo `.gitlock` files live in an agent-neutral state directory and serialize concurrent git operations without fighting git's own `index.lock`
- **Parallel pre-checks** — TypeScript, security gate, and CVE audit run in parallel before the build

---

## Architecture

```
Claude Code (PostToolUse / Stop) or Codex after-task command
  │
  ▼
Hook fires (ev-betta-autodeploy | underground-api-autodeploy | francois-landing-autodeploy | task-complete-autodeploy)
  │
  ├─ Debounce check (stamp file — skips if last deploy < 30s ago)
  ├─ Git advisory lock acquired (per-repo, outside .git/)
  ├─ Source committed + pushed to GitHub
  │
  ▼
deploy.cjs (async, Cloudflare Workers)
  │
  ├─ Advisory lockfile (prevents concurrent builds — stale after 15 min)
  ├─ Inject build metadata (SHA, branch, time, commit URL)
  │
  ├─ Pre-checks (parallel):
  │    ├─ Branch A: tsc --noEmit (TypeScript)
  │    └─ Branch B: security-gate.cjs → npm audit --omit=dev (CVE gate)
  │                 (skipped if SKIP_AUDIT=1)
  │
  ├─ GitHub Deployment API (pending status)
  │
  ├─ Build:
  │    ├─ wipe .next + .open-next (wipeBuildDirs)
  │    ├─ opennextjs-cloudflare build
  │    ├─ rimraf large audio assets
  │    ├─ verify .open-next/assets exists (guards silent Windows failure)
  │    └─ wrangler deploy --config wrangler.jsonc
  │
  ├─ Retry once on failure (full wipe → rebuild → redeploy)
  ├─ GitHub Deployment API (success/failure status)
  └─ Auto-commit build-meta [skip-deploy] if SHA changed
```

---

## Hooks

Four hooks cover the full Cloudflare Workers stack. All deploy hooks use `spawnDetachedDeploy` or `spawnDetachedPackageScript` from `hook-utils.cjs` so the deploy process is fully detached and the hook returns in milliseconds.

### Hook Comparison

| Hook | Trigger | Debounce | Git Ops | Deploy Path |
|------|---------|----------|---------|-------------|
| `ev-betta-autodeploy.cjs` | `ev-betta-ui/src/**` edits | 30s | commit + push source + bundle | `spawnDetachedDeploy` → `deploy.cjs` |
| `underground-api-autodeploy.cjs` | `packages/underground-api/src/**` edits | 60s | none (wrangler-only) | `spawnDetachedDeploy` → `npm run deploy` |
| `francois-landing-autodeploy.cjs` | `git push` to francois-landing | 60s + in-flight PID | already pushed | `spawnDetachedDeploy` → `deploy.cjs` |
| `task-complete-autodeploy.cjs` | Claude `Stop`, Codex/manual after-task | 60s-5m per target | none | touched target → `deploy.cjs` or `npm run deploy` |

### After-Task Deploy

Use `task-complete-autodeploy.cjs` when you want deploys at task completion instead of only on individual file saves. It collects touched files from hook stdin, Claude's session file tracker, dirty/staged git files, and the latest commit, then queues the matching Cloudflare deploy target.

Manual Codex-friendly run:

```bash
node hooks/task-complete-autodeploy.cjs --workspace C:/Za
```

Force every configured target:

```bash
node hooks/task-complete-autodeploy.cjs --workspace C:/Za --all
```

Dry-run target detection:

```bash
node hooks/task-complete-autodeploy.cjs --workspace C:/Za --dry-run
```

### `hook-utils.cjs` — Shared Utilities

The shared library used by all hooks:

| Export | Purpose |
|--------|---------|
| `readStdinJson()` | Parse Claude Code's stdin JSON payload (non-blocking on failure) |
| `runGit(cmd, cwd)` | `execSync` wrapper with `windowsHide: true` |
| `shouldDebounce(file, ms)` | Stamp-file debounce — returns `true` if last stamp < `ms` ago |
| `withGitLock(repoDir, fn)` | Advisory per-repo lock — waits with retry, never fights `index.lock` |
| `sweepStaleGitLock(repoDir)` | Removes stale `index.lock` files |
| `appendErrorLog(file, entry)` | Structured error logging with PAT redaction |
| `trimLogFile(file, maxLines?)` | Trims log to last N lines (default 500) before appending — prevents unbounded growth |
| `detectPackageManager(cwd)` | Returns `'pnpm'` if `pnpm-lock.yaml` or `pnpm-workspace.yaml` exists, else `'npm'` |
| `spawnDetachedDeploy(script, cwd, logFile, label)` | Detached deploy process — returns child PID for in-flight tracking |
| `spawnDetachedPackageScript(cwd, script, logFile, label)` | Detached `npm run <script>` |
| `spawnDetachedPnpmScript(cwd, script, logFile, label)` | Detached `pnpm run <script>` for pnpm monorepos |
| `spawnDetachedAutoScript(cwd, script, logFile, label)` | Auto-detects npm vs pnpm via lockfile, then spawns |
| `repoIsMidOperation(repoDir)` | Detects merge/rebase/cherry-pick in progress |

---

## Deploy Script

`scripts/deploy.cjs` is the main deploy entry point for Next.js on Cloudflare Workers (via `@opennextjs/cloudflare`).

### Performance Optimizations

```
Sequential (before):          Parallel (after):
──────────────────           ───────────────────────────────
tsc --noEmit          ~15s   ┌── tsc --noEmit          ~15s ──┐
security-gate.cjs      ~3s   │                               │  both finish
npm audit             ~15s   └── security-gate → npm audit  ~18s ─┘ ~18s total
──────────────────           ───────────────────────────────
Total: ~33s                  Total: ~18s  (saves ~15s per deploy)
```

### SKIP_AUDIT flag

For emergency redeploys or slow registry days, skip the CVE audit:

```bash
SKIP_AUDIT=1 node scripts/deploy.cjs
```

### Retry Logic

The deploy script retries once on failure with a full build directory wipe:

```
Attempt 1: wipeBuildDirs → build → verify → deploy
  └─ fails? →
Attempt 2: wipeBuildDirs → build → verify → deploy
```

Guarded failure modes: stale `.next/lock`, partial `.open-next/assets`, EPERM from wrangler, silent Windows opennextjs exit-0.

---

## Configuration

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `SKIP_AUDIT` | `undefined` | Set to `1` to skip npm CVE audit in deploy |
| `DEBOUNCE_MS` | `30000` | Milliseconds between autodeploy triggers |
| `AUTODEPLOY_WORKSPACE` | `C:/Za` | Workspace root for after-task target detection |
| `AUTODEPLOY_STATE_DIR` | `%LOCALAPPDATA%/Autodeploy` or `~/.autodeploy` | Shared Codex/Claude state, logs, and lock base |
| `AUTODEPLOY_LOCK_DIR` | `<state>/locks` | Override for shared advisory lock files |
| `AUTODEPLOY_SESSION_FILES` | `<workspace>/.claude/session-files.json` | Optional Claude session-file tracker path |
| `AUTODEPLOY_TASK_DEBOUNCE_MS` | `300000` | Default after-task deploy debounce |
| `AUTODEPLOY_RECENT_COMMIT_MS` | `7200000` | Latest-commit detection window when no session or dirty files exist |

### Debounce Tuning

Edit the `DEBOUNCE_MS` constant in each hook file. Recommended values:

| Hook | Min | Recommended | Notes |
|------|-----|-------------|-------|
| ev-betta-autodeploy | 20000ms | 30000ms | React source — fast builds |
| underground-api-autodeploy | 30000ms | 60000ms | wrangler deploy only |
| francois-landing-autodeploy | 60000ms | 60000ms | fires on push; debounce prevents cascade from ev-betta bundle commits |

---

## Usage

### Drop-in with Claude Code

Copy the hooks to `.claude/hooks/` in your project and register them in `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          { "type": "command", "command": "node .claude/hooks/ev-betta-autodeploy.cjs" }
        ]
      }
    ]
  }
}
```

To deploy after completed Claude tasks, register the after-task hook in `Stop`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node .claude/hooks/task-complete-autodeploy.cjs --workspace C:/Za" }
        ]
      }
    ]
  }
}
```

### Standalone Deploy

Run the deploy script directly from your Next.js + Cloudflare Workers project root:

```bash
node scripts/deploy.cjs

# Skip CVE audit (emergency / slow registry):
SKIP_AUDIT=1 node scripts/deploy.cjs
```

### Prerequisites

```bash
npm install -g wrangler                      # Cloudflare Workers CLI
npm install --save-dev @opennextjs/cloudflare # Next.js CF adapter
npx wrangler login                           # Authenticate
```

Cloudflare's current Wrangler docs support either direct `wrangler deploy` or package-manager scripts such as `npm run deploy`; Autodeploy uses the package script path for generic Workers and the project deploy script path for OpenNext projects.

---

## File Structure

```
Autodeploy/
├── hooks/
│   ├── hook-utils.cjs                  # Shared utility library (all hooks import this)
│   ├── ev-betta-autodeploy.cjs         # React SPA autodeploy hook
│   ├── underground-api-autodeploy.cjs  # Hono CF Worker autodeploy hook
│   ├── francois-landing-autodeploy.cjs # Next.js CF Workers autodeploy hook
│   └── task-complete-autodeploy.cjs    # Codex/Claude after-task deploy hook
├── scripts/
│   └── deploy.cjs                      # Full CF Workers deploy (build + deploy + retry)
├── LICENSE
└── README.md
```

---

## License

MIT — see [LICENSE](LICENSE).
