#!/usr/bin/env node
// scripts/deploy.cjs
// Full local deploy: injects build metadata then runs opennextjs-cloudflare build + deploy.
// Replaces the old GitHub Actions workflow.

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOCK_FILE = path.join(ROOT, '.deploy.lock');
const LOCK_TTL_MS = 15 * 60 * 1000; // 15 min — abandon stale lock from crashed build

// ── Deploy lock — prevents concurrent builds from corrupting .open-next/ ─────
//
// Both this script (manual) and francois-landing-autodeploy.cjs (hook on git push)
// call node scripts/deploy.cjs. When both run at the same time, opennextjs-cloudflare
// writes next-env.mjs from two processes simultaneously → duplicate `export const`
// blocks → wrangler bundler error: "The symbol X has already been declared".
//
// Fix: advisory lockfile acquired before wipeBuildDirs, released on exit.
// Second invocation detects the lock, logs, and exits 0 (the first deploy wins).
(function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    let stale = true;
    try {
      const { pid, ts } = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      const age = Date.now() - ts;
      if (age < LOCK_TTL_MS) {
        stale = false;
        console.log(`[deploy] Concurrent deploy already running (pid ${pid}, ${Math.round(age / 1000)}s ago) — skipping this invocation.`);
        process.exit(0);
      }
    } catch { /* corrupt lock — treat as stale */ }
    if (stale) console.log('[deploy] Stale lock detected (>15 min) — proceeding with clean build.');
  }
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, ts: Date.now() }), 'utf8');
  function releaseLock() { try { fs.unlinkSync(LOCK_FILE); } catch { /* already removed */ } }
  process.on('exit', releaseLock);
  process.on('SIGINT',  () => { releaseLock(); process.exit(130); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(143); });
  process.on('uncaughtException', (err) => { releaseLock(); console.error('[deploy] Uncaught:', err); process.exit(1); });
})();

function git(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim();
}

// ── Async entry — everything below the lock acquisition runs in an async IIFE ─
// Required because the pre-check phase uses Promise.all (tsc ∥ audit).
(async () => {

// ── 1. Inject build metadata ──────────────────────────────────────────────────
const sha = git('git rev-parse --short HEAD');
const branch = git('git rev-parse --abbrev-ref HEAD');
const time = new Date().toISOString();
const message = git('git log -1 --format=%s');
const commitUrl = `https://github.com/DevCraftXCoder/francois-landing/commit/${git('git rev-parse HEAD')}`;

const META_PATH = path.join(ROOT, 'lib', 'build-meta.ts');
const meta = `/** Auto-replaced at deploy time. Do not import in client components. */
export const BUILD_META = {
  sha: ${JSON.stringify(sha)},
  branch: ${JSON.stringify(branch)},
  time: ${JSON.stringify(time)},
  message: ${JSON.stringify(message)},
  workflowUrl: ${JSON.stringify(commitUrl)},
};
`;

// Skip overwrite when the file already pins this commit — keeps `time` stable
// across redeploys of the same SHA so audit.js doesn't see a dirty tree.
let metaChanged = true;
try {
  const existing = fs.readFileSync(META_PATH, 'utf8');
  if (existing.includes(`sha: ${JSON.stringify(sha)}`)) metaChanged = false;
} catch { /* file missing — treat as changed */ }

if (metaChanged) {
  fs.writeFileSync(META_PATH, meta, 'utf8');
  console.log(`[deploy] Metadata injected: ${sha} (${branch}) — ${message}`);
} else {
  console.log(`[deploy] Metadata already at ${sha} — skipping rewrite`);
}

// ── 2. Pre-checks: tsc + security-gate + CVE audit (parallel where possible) ─
//
// tsc and the security-gate→audit chain are independent — run them in parallel.
// Saves 15–30s per deploy. Fail fast: if either branch fails, abort before build.
// SKIP_AUDIT=1 skips the CVE audit for emergency redeploys or slow registry days.
console.log('[deploy] Running pre-checks (tsc' + (process.env.SKIP_AUDIT === '1' ? '' : ' + CVE audit') + ') in parallel...');

function runAsync(cmd, args, label, opts = {}) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const chunks = [];
    const child = spawn(cmd, args, {
      cwd: ROOT, windowsHide: true, shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'], ...opts,
    });
    child.stdout.on('data', d => chunks.push(d));
    child.stderr.on('data', d => chunks.push(d));
    child.on('close', code => {
      if (code === 0) { console.log(`[deploy] ${label} OK`); resolve(); }
      else { process.stdout.write(Buffer.concat(chunks)); reject(new Error(`${label} failed (exit ${code})`)); }
    });
    child.on('error', reject);
  });
}

// Branch A: TypeScript check
const tscCheck = runAsync('npx', ['tsc', '--noEmit'], 'TypeScript');

// Branch B: security gate → CVE audit (sequential within branch, parallel to tsc)
const auditBranch = (async () => {
  await runAsync('node', ['scripts/security-gate.cjs'], 'security-gate');
  if (process.env.SKIP_AUDIT === '1') {
    console.log('[deploy] CVE audit skipped (SKIP_AUDIT=1)');
    return;
  }
  await runAsync('npm', ['audit', '--omit=dev', '--audit-level=high'], 'CVE gate');
})();

try {
  await Promise.all([tscCheck, auditBranch]);
} catch (err) {
  console.error(`[deploy] Pre-check failed: ${err.message.split('\n')[0]}`);
  process.exit(1);
}

// ── 3. Create GitHub Deployment (pending) ────────────────────────────────────
const fullSha = git('git rev-parse HEAD');
let deploymentId = null;
try {
  const payload = JSON.stringify({
    ref: fullSha,
    environment: 'production',
    description: 'CF Workers deploy',
    auto_merge: false,
    required_contexts: [],
  });
  const result = execSync(
    `gh api repos/DevCraftXCoder/francois-landing/deployments --input -`,
    { cwd: ROOT, encoding: 'utf8', input: payload, windowsHide: true }
  );
  deploymentId = JSON.parse(result).id ?? null;
  if (deploymentId) {
    execSync(
      `gh api repos/DevCraftXCoder/francois-landing/deployments/${deploymentId}/statuses -f state=in_progress -f environment=production -f description="Building..."`,
      { cwd: ROOT, encoding: 'utf8', windowsHide: true }
    );
    console.log(`[deploy] GitHub Deployment created: ${deploymentId}`);
  }
} catch (e) {
  console.log(`[deploy] GitHub Deployment create failed (non-fatal): ${e.message.split('\n')[0]}`);
}

// ── 3. Build + deploy ─────────────────────────────────────────────────────────
//
// Strategy: split build and deploy into discrete verified steps instead of
// running the opaque `npm run cf:deploy` chain.
//
// Failure modes guarded against:
//   a) .next/lock from crashed prior build  → wipeBuildDirs always runs first
//   b) .next/cache/webpack/ partial state   → wipeBuildDirs removes it
//   c) .open-next/ EPERM from crashed wrangler → wipeBuildDirs removes it
//   d) opennextjs exits 0 but no .open-next/assets (Windows silent fail)
//      → verified by assetsExist(); retry once from clean state
//   e) Stale build output is removed with fs.rmSync after verifying each target
//      is inside ROOT. No shell delete command is constructed.

function wipeBuildDirs(label) {
  console.log(`[deploy] ${label}: wiping .next and .open-next...`);
  for (const dir of ['.next', '.open-next']) {
    const target = path.join(ROOT, dir);
    const resolved = path.resolve(target);
    if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
      throw new Error(`Refusing to remove build dir outside ROOT: ${resolved}`);
    }
    try {
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
    } catch { /* non-fatal */ }
  }
}

function assetsExist() {
  const assetsDir = path.join(ROOT, '.open-next', 'assets');
  const workerJs  = path.join(ROOT, '.open-next', 'worker.js');
  return fs.existsSync(assetsDir) && fs.existsSync(workerJs);
}

// Use npx so node_modules/.bin/ is resolved even in subprocess shell environments
// where the bare binary (opennextjs-cloudflare, wrangler) isn't on PATH (Windows).
// Split into discrete verified steps so each can be retried independently.

function runCfDeploy() {
  // Step 1: OpenNext build (security-gate + tsc + CVE audit already passed in parallel pre-checks above)
  execSync('npx opennextjs-cloudflare build', { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  // Step 3: remove large audio assets that shouldn't ship
  try { execSync('npx rimraf ".open-next/assets/audio/*.wav"', { cwd: ROOT, stdio: 'pipe', windowsHide: true }); } catch { /* non-fatal */ }
  // Verify build actually produced assets — guards against silent Windows failure
  if (!assetsExist()) throw new Error('opennextjs exited 0 but .open-next/assets is missing (silent Windows failure)');
  // Step 4: wrangler deploy
  execSync('npx wrangler deploy --config wrangler.jsonc', { cwd: ROOT, stdio: 'inherit', windowsHide: true });
}

let deployOk = false;

// Attempt 1: always start from clean dirs
wipeBuildDirs('pre-build');
try {
  console.log('[deploy] Running cf:deploy (attempt 1)...');
  runCfDeploy();
  deployOk = true;
} catch (err) {
  console.error(`[deploy] Attempt 1 failed: ${err.message.split('\n')[0]}`);

  // Attempt 2: full wipe + retry the same chain
  wipeBuildDirs('retry-wipe');
  try {
    console.log('[deploy] Running cf:deploy (attempt 2)...');
    runCfDeploy();
    deployOk = true;
    console.log('[deploy] Retry succeeded.');
  } catch (err2) {
    console.error(`[deploy] Attempt 2 failed: ${err2.message.split('\n')[0]}`);
  }
}

// ── 4. Post final deployment status to GitHub ─────────────────────────────────
if (deploymentId) {
  try {
    const state = deployOk ? 'success' : 'failure';
    const desc = deployOk ? 'Deployed to CF Workers' : 'Deploy failed';
    const envUrl = deployOk ? 'https://frxncois.com' : '';
    const statusPayload = JSON.stringify({
      state,
      environment: 'production',
      description: desc,
      ...(envUrl ? { environment_url: envUrl } : {}),
    });
    execSync(
      `gh api repos/DevCraftXCoder/francois-landing/deployments/${deploymentId}/statuses --input -`,
      { cwd: ROOT, encoding: 'utf8', input: statusPayload, windowsHide: true }
    );
    console.log(`[deploy] GitHub status → ${state}`);
  } catch (e) {
    console.log(`[deploy] GitHub status post failed (non-fatal): ${e.message.split('\n')[0]}`);
  }
}

if (!deployOk) process.exit(1);

// ── 5. Auto-commit regenerated build-meta so audit.js sees a clean tree ──────
//
// Each new code commit invalidates lib/build-meta.ts (it pins HEAD's short
// SHA). Without this step, the working tree is dirty after every deploy and
// audit.js raises a recurring "uncommitted changes" WARN. The [skip-deploy]
// token tells francois-landing-autodeploy.cjs not to re-deploy this commit.
if (metaChanged) {
  try {
    const dirty = git('git status --porcelain lib/build-meta.ts');
    if (dirty) {
      execSync('git add lib/build-meta.ts', { cwd: ROOT, stdio: 'inherit', windowsHide: true });
      execSync('git commit -m "chore: sync build-meta after deploy [skip-deploy]"', { cwd: ROOT, stdio: 'inherit', windowsHide: true });
      execSync('git push', { cwd: ROOT, stdio: 'inherit', windowsHide: true });
      console.log('[deploy] build-meta synced + pushed with [skip-deploy]');
    }
  } catch (e) {
    console.log(`[deploy] build-meta auto-commit failed (non-fatal): ${e.message.split('\n')[0]}`);
  }
}

console.log('[deploy] Done.');

})().catch(err => {
  console.error('[deploy] Fatal:', err.message);
  process.exit(1);
});
