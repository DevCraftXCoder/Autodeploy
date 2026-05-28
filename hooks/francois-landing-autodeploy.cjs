// francois-landing-autodeploy.cjs
// PostToolUse (Bash) — auto-deploys francois-landing to CF Workers when a git push
// to that repo is detected.
//
// Why: GitHub Actions is disabled; CI is done locally via `node scripts/deploy.cjs`
// (metadata injection + opennextjs build + wrangler deploy). This hook is the
// replacement pipeline.
//
// Guards (in order):
//   1. Push detection  — command or output references "francois-landing" (case-insensitive)
//   2. Push success    — tool_response.isError check
//   3. mid-operation   — repoIsMidOperation() blocks deploys during merge/rebase
//   4. [skip-deploy]   — HEAD commit token prevents deploy.cjs re-deploy loop
//   5. Debounce (60s)  — stamp file prevents cascade deploys from ev-betta bundle pushes
//   6. In-flight       — PID + timestamp check prevents overlapping wrangler processes
//
// Concurrency: deploy runs detached + unref'd so it never blocks Claude.
// Since wrangler does not touch .git/, it does not contend with ev-betta-autodeploy's
// git commits — the two can run in parallel.

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const {
  readStdinJson,
  parseToolInput,
  spawnDetachedDeploy,
  shouldDebounce,
  repoIsMidOperation,
} = require('./hook-utils.cjs');

const FRANCOIS_LANDING_DIR = 'C:/Za/francois-landing';
const LOG_FILE = path.join(FRANCOIS_LANDING_DIR, '.last-deploy-log');
const DEPLOY_SCRIPT = path.join(FRANCOIS_LANDING_DIR, 'scripts', 'deploy.cjs');

const STATE_DIR = process.env.AUTODEPLOY_STATE_DIR ||
  (process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Autodeploy')
    : path.join(os.homedir(), '.autodeploy'));

const DEBOUNCE_FILE   = path.join(STATE_DIR, 'francois-landing.last-autodeploy');
const INFLIGHT_FILE   = path.join(STATE_DIR, 'francois-landing.deploy-inflight.json');
const DEBOUNCE_MS     = 60_000;
const INFLIGHT_MAX_MS = 10 * 60 * 1000; // 10 minutes — max wrangler build window

// Returns true if a deploy spawned by this hook is still running.
// Checks PID liveness + age; stale entries (>10 min) are treated as gone.
function isDeployInFlight() {
  try {
    const { pid, startTime } = JSON.parse(fs.readFileSync(INFLIGHT_FILE, 'utf8'));
    if (Date.now() - startTime > INFLIGHT_MAX_MS) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  } catch { return false; }
}

function writeInflightFile(pid) {
  try {
    fs.mkdirSync(path.dirname(INFLIGHT_FILE), { recursive: true });
    fs.writeFileSync(INFLIGHT_FILE, JSON.stringify({ pid, startTime: Date.now() }));
  } catch { /* non-fatal */ }
}

async function main() {
  let payload;
  try { payload = await readStdinJson(); } catch { process.exit(0); }

  const { tool_input, tool_response } = parseToolInput(payload);
  const cmd    = String((tool_input && tool_input.command) ?? '');
  const output = String((tool_response && (tool_response.output ?? tool_response)) ?? '');

  // Must be a git push
  if (!cmd.includes('git') || !cmd.includes('push')) process.exit(0);

  // Detect francois-landing pushes — case-insensitive on both cmd path and push output URL.
  // Catches: explicit path in cmd, `To https://...francois-landing.git` in output.
  const isFrancoisLanding =
    /francois-landing/i.test(cmd) ||
    /francois-landing/i.test(output);
  if (!isFrancoisLanding) process.exit(0);

  // Guard: push failed
  if (tool_response && tool_response.isError) {
    console.log('[francois-landing-autodeploy] Push failed — skipping deploy');
    process.exit(0);
  }

  // Guard: repo mid-merge/rebase/cherry-pick — deploying incomplete HEAD is wrong
  const midOp = repoIsMidOperation(FRANCOIS_LANDING_DIR);
  if (midOp) {
    console.log(`[francois-landing-autodeploy] Repo mid-${midOp} — skipping deploy`);
    process.exit(0);
  }

  // Guard: [skip-deploy] token in HEAD commit (used by deploy.cjs when it auto-pushes
  // the regenerated build-meta.ts — re-deploying that commit would re-write the same
  // SHA and dirty the tree again).
  try {
    const lastMsg = execSync('git log -1 --format=%B', {
      cwd: FRANCOIS_LANDING_DIR, encoding: 'utf8', windowsHide: true,
    }).trim();
    if (/\[skip-deploy\]/i.test(lastMsg)) {
      console.log('[francois-landing-autodeploy] [skip-deploy] token in HEAD — skipping');
      process.exit(0);
    }
  } catch { /* fall through and deploy */ }

  // Guard: debounce (60s) — prevents cascade deploys when ev-betta-autodeploy pushes
  // a bundle commit to francois-landing shortly after a manual push
  if (shouldDebounce(DEBOUNCE_FILE, DEBOUNCE_MS)) {
    console.log('[francois-landing-autodeploy] Skipped — deployed <60s ago');
    process.exit(0);
  }

  // Guard: previous deploy still in-flight (PID alive + <10 min old)
  if (isDeployInFlight()) {
    console.log('[francois-landing-autodeploy] Skipped — previous deploy still in flight');
    process.exit(0);
  }

  console.log('[francois-landing-autodeploy] Push to francois-landing detected — deploying to CF Workers in background');
  console.log(`[francois-landing-autodeploy] Log: ${LOG_FILE}`);

  const pid = spawnDetachedDeploy(DEPLOY_SCRIPT, FRANCOIS_LANDING_DIR, LOG_FILE, 'francois-landing deploy (git push trigger)');
  if (pid) writeInflightFile(pid);
}

main().catch(() => process.exit(0));
