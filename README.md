<div align="center">

# Autodeploy

### Non-Blocking CI/CD Hook System for Cloudflare Workers Projects

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-brightgreen.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Cloudflare%20Workers-orange.svg)](https://workers.cloudflare.com/)
[![Hooks](https://img.shields.io/badge/Hook%20System-Claude%20Code-purple.svg)](https://claude.ai/code)
[![Deploy](https://img.shields.io/badge/Deploy-Non--Blocking-blue.svg)](#architecture)

**Autodeploy is a Claude Code hook system that fires non-blocking Cloudflare Workers deploys after edits, pushes, or completed tasks. Parallel pre-checks, PID-aware locks, automatic build recovery, and detached deploy processes keep your editor responsive while CI runs in the background.**

[Architecture](#architecture) | [Hooks](#hooks) | [Deploy Script](#deploy-script) | [Configuration](#configuration) | [Usage](#usage)

</div>

---

## Overview

Autodeploy replaces manual deploy commands and slow sequential CI pipelines with event-driven, non-blocking deploys triggered from Claude Code hook events or manual runs.

Every hook follows the same contract:

- **Non-blocking** — deploys spawn detached child processes; the hook returns immediately
- **PID-aware locks** — lock files track the process ID of the running deploy; if the process dies, the lock is treated as stale instantly — no waiting for a timeout
- **Debounced** — a stamp file prevents redundant deploys from rapid successive changes
- **Advisory-locked** — per-repo lock files live in an agent-neutral state directory and serialize concurrent git operations without fighting git's own index lock
- **Parallel pre-checks** — TypeScript, security gate, and CVE audit run in parallel before the build
- **Dependency-guarded** — the deploy script verifies that installed packages match the declared version before building; a mismatch is auto-corrected rather than producing a broken deploy

---

## Architecture

```
Claude Code (PostToolUse / Stop) or manual run
  │
  ▼
Hook fires
  │
  ├─ Guard: in-flight check (PID alive — skip if deploy is running)
  ├─ Guard: debounce (stamp file — skip if last deploy < 30s ago)
  ├─ Guard: skip-deploy token in HEAD commit
  ├─ Git advisory lock acquired (per-repo, outside .git/)
  ├─ Source committed + pushed to GitHub
  │
  ▼
deploy.cjs (async, Cloudflare Workers)
  │
  ├─ Dependency version guard (auto-reinstall if mismatch before anything else)
  ├─ PID-aware lock (dead process = stale immediately; shows time-to-expire if blocked)
  ├─ Inject build metadata (SHA, branch, time, commit URL)
  │
  ├─ Pre-checks (parallel):
  │    ├─ Branch A: TypeScript check
  │    └─ Branch B: security gate → CVE audit (skipped if SKIP_AUDIT=1)
  │
  ├─ GitHub Deployment API (pending status)
  │
  ├─ Build integrity pre-flight (detect corrupt .next OR leftover .tmp rename artifacts)
  │
  ├─ Build:
  │    ├─ kill stale wrangler dev (releases .next file handles before wipe)
  │    ├─ wipe build artifacts (retries rmdir 3× on EBUSY + 1.5s settle delay)
  │    ├─ opennextjs-cloudflare build
  │    ├─ strip large static assets from server bundle
  │    ├─ verify assets exist (guards silent Windows failure)
  │    └─ wrangler deploy
  │
  ├─ Retry once on failure:
  │    ├─ EPERM/rename failure → extra 5s backoff before wipe (Windows handle release)
  │    └─ full wipe → rebuild → redeploy
  ├─ Smoke test (graduated waits: 2s / 5s / 10s — fast propagation, no wasted time)
  ├─ Auto-rollback to prior version if smoke test fails
  ├─ GitHub Deployment API (success/failure status)
  └─ Auto-commit build-meta [skip-deploy] if SHA changed
```

---

## What's New

### Deploy Script Improvements

| Improvement | Before | After |
|-------------|--------|-------|
| Dependency version guard | After 2–3 min of pre-checks | **First thing** — mismatch fixed before pre-checks run |
| Stale lock detection | 15-min TTL regardless | **Instant** — dead process = stale lock immediately |
| Blocked lock message | "Concurrent deploy running" | Shows time-to-expire + `DEPLOY_IGNORE_LOCK=1` hint |
| Build artifact pre-flight | Corrupt `.next` fails attempt 1 silently | Detected upfront — wipe before attempt 1; also catches leftover `.tmp` rename artifacts |
| Deploy progress | Silent | Step-by-step with elapsed time (e.g. `[+47s] Build + upload complete`) |
| Smoke test waits | 3 × 3s flat (9s minimum) | 2s → 5s → 10s graduated (passes on fast propagation in 2s) |
| Windows rename failure | Retry wipe ran immediately, hit same locked files | EPERM/EBUSY detected → 5s backoff before retry wipe |
| rmdir on busy directory | Silent fail, `.next` left partially intact | Retries rmdir 3× with 2s delay + 1.5s settle before build |
| Stale wrangler dev handles | Not cleared — caused EPERM on `.next` files | `wrangler dev` processes terminated before every wipe |

### Hook Improvements (francois-landing)

| Improvement | Before | After |
|-------------|--------|-------|
| Version block | Hard-blocked if wrong dependency version installed | Removed — deploy script auto-corrects and handles this |
| Guard order | Debounce → in-flight check | **In-flight first** — immediate short-circuit if deploy is running |
| Debounce window | 60s | **30s** — in-flight detection handles true concurrency; debounce guards rapid back-to-back pushes |

---

## Hooks

Four hooks cover the full Cloudflare Workers stack. All deploy hooks use `spawnDetachedDeploy` or `spawnDetachedPackageScript` from `hook-utils.cjs` so the deploy process is fully detached and the hook returns in milliseconds.

### Hook Comparison

| Hook | Trigger | Debounce | Git Ops | Deploy Path |
|------|---------|----------|---------|-------------|
| `react-autodeploy.cjs` | React SPA source edits | 30s | commit + push source + bundle | detached → deploy script |
| `api-autodeploy.cjs` | Hono CF Worker source edits | 60s | wrangler deploy only | detached wrangler |
| `landing-autodeploy.cjs` | git push to Next.js repo | 30s | detected from push output | detached → deploy script |
| `task-complete-autodeploy.cjs` | Claude Stop event | 5 min | detects changed services | multi-target detached |

### Guard Order (francois-landing)

```
push detected
  → in-flight? skip (no point checking debounce if deploy is already running)
  → [skip-deploy] in HEAD? skip (prevents redeploy loop from build-meta commits)
  → deployed < 30s ago? skip (prevents cascade from bundle commits)
  → spawn detached deploy
```

---

## Deploy Script

`scripts/deploy.cjs` is the main deploy entry point for Next.js on Cloudflare Workers (via `@opennextjs/cloudflare`).

### Execution Order

```
1. Dependency version guard     ← NEW: runs first, before pre-checks
2. PID-aware lock acquired      ← dead process = stale immediately
3. Pre-checks (parallel)        TypeScript + security gate + CVE audit
4. GitHub Deployment created    pending status
5. Build artifact pre-flight    ← NEW: detect corrupt .next before attempt 1
6. Build + deploy               attempt 1
7. Retry on failure             full wipe → rebuild (attempt 2)
8. Smoke test                   ← NEW: graduated waits 2s/5s/10s
9. Auto-rollback                if smoke fails, restores prior CF version
10. Done                        ← NEW: prints total elapsed time
```

### Performance

```
Sequential (before):          Parallel (after):
──────────────────           ──────────────────────────────
TypeScript check      ~15s   ┌── TypeScript check      ~15s ──┐
security-gate          ~3s   │                               │  both finish ~18s
CVE audit             ~15s   └── security gate + CVE audit ~18s ┘
──────────────────           ──────────────────────────────
Total: ~33s                  Total: ~18s  (saves ~15s per deploy)
```

Smoke test timing improvement:

```
Before: 3 attempts × 3s wait = 9s minimum before first result
After:  attempt 1 → 2s wait, attempt 2 → 5s wait, attempt 3 → 10s wait
        → passes on fast propagation in 2s instead of 9s
```

### Windows Build Reliability (Rename Failure Fixes)

On Windows, `next build` uses atomic writes: it writes a temp file (`.js.tmp`) then renames it to the final path. If any process holds that file open — a prior build, `wrangler dev`, or an editor — the rename fails with `EPERM: operation not permitted`. The deploy script handles this at every layer:

| Layer | Problem | Fix |
|-------|---------|-----|
| Pre-flight | Leftover `.tmp` files from a failed atomic rename prevent the next build | Detected as corruption signal alongside missing `pages-manifest.json`; wipe triggered before attempt 1 |
| Before wipe | `wrangler dev` holds handles on `.next` files | Dev server terminated before `rmdir` runs |
| During wipe | `rmdir /s /q` fails silently on locked files | Retried 3× with 2s delay between attempts |
| After wipe | Windows retains file handles briefly after process exit | 1.5s settle delay before the build starts |
| On retry | Attempt 1 EPERM → attempt 2 wipe runs immediately, hits same locks | EPERM/EBUSY detected → 5s backoff before retry wipe |

### Emergency Flags

```bash
# Skip CVE audit (emergency / slow registry):
SKIP_AUDIT=1 node scripts/deploy.cjs

# Ignore lock (if a lock is genuinely stuck):
DEPLOY_IGNORE_LOCK=1 node scripts/deploy.cjs

# Skip pre-checks entirely:
DEPLOY_SKIP_PRECHECKS=1 node scripts/deploy.cjs
```

### Retry Logic

```
Attempt 1: pre-flight check → wipe stale artifacts → build → deploy
  └─ fails? → full wipe (including webpack cache) → retry →
Attempt 2: build → deploy
```

Guarded failure modes: stale `.next` lock, partial `.open-next/assets`, corrupt JSON build manifests, EPERM from wrangler, silent Windows opennextjs exit-0, mismatched dependency versions.

---

## Configuration

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `SKIP_AUDIT` | `undefined` | Set to `1` to skip CVE audit in deploy |
| `DEPLOY_IGNORE_LOCK` | `undefined` | Set to `1` to bypass the deploy lock |
| `DEPLOY_SKIP_PRECHECKS` | `undefined` | Set to `1` to skip TypeScript + audit checks |
| `AUTODEPLOY_WORKSPACE` | Workspace root | After-task target detection root |
| `AUTODEPLOY_STATE_DIR` | `%LOCALAPPDATA%/Autodeploy` or `~/.autodeploy` | Shared state, logs, and lock base |
| `AUTODEPLOY_LOCK_DIR` | `<state>/locks` | Override for advisory lock files |
| `AUTODEPLOY_TASK_DEBOUNCE_MS` | `300000` | After-task deploy debounce (5 min) |

### Debounce Tuning

| Hook | Current | Notes |
|------|---------|-------|
| 30s | React source — fast builds |
| 60s | wrangler deploy only — no build |
| 30s | in-flight check handles concurrency; debounce guards rapid back-to-back pushes |
| 5 min | after-task; conservative to prevent task-end storm |

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
          { "type": "command", "command": "node .claude/hooks/autodeploy.cjs" }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node .claude/hooks/task-complete-autodeploy.cjs" }
        ]
      }
    ]
  }
}
```

### Standalone Deploy

```bash
node scripts/deploy.cjs

# Skip CVE audit:
SKIP_AUDIT=1 node scripts/deploy.cjs

# Force past a stale lock:
DEPLOY_IGNORE_LOCK=1 node scripts/deploy.cjs
```

### Prerequisites

```bash
npm install -g wrangler                      # Cloudflare Workers CLI
npm install -D @opennextjs/cloudflare        # Next.js CF adapter
npx wrangler login                           # Authenticate
```

---

## File Structure

```
Autodeploy/
├── hooks/
│   ├── hook-utils.cjs                  # Shared utility library (all hooks import this)
│   ├── reactautodeploy.cjs         # React SPA autodeploy hook
│   ├── api-autodeploy.cjs  # Hono CF Worker autodeploy hook
│   ├── landing-autodeploy.cjs # Next.js CF Workers autodeploy hook
│   └── task-complete-autodeploy.cjs    # Claude after-task deploy hook
├── scripts/
│   └── deploy.cjs                      # Full CF Workers deploy (build + deploy + retry)
├── LICENSE
└── README.md
```

---

## License

MIT — see [LICENSE](LICENSE).
