// francois-landing-autodeploy.cjs
// PostToolUse (Bash) — auto-deploys francois-landing to CF Workers when a git push
// to that repo is detected.
//
// Why: GitHub Actions is disabled; CI is done locally via `node scripts/deploy.cjs`
// (metadata injection + opennextjs build + wrangler deploy). This hook is the
// replacement pipeline.
//
// Concurrency: uses the shared spawnDetachedDeploy helper. The deploy itself runs
// OUT of the hook process lifecycle (detached + unref) so it never blocks Claude.
// Since wrangler does not touch .git/, it does not contend with ev-betta-autodeploy's
// git commits — the two can run in parallel.
//
// Detection: bash output or command must reference "francois-landing" (cwd or
// remote URL in `git push` output).

'use strict';

const path = require('path');
const { readStdinJson, parseToolInput, spawnDetachedDeploy } = require('./hook-utils.cjs');

const FRANCOIS_LANDING_DIR = 'C:/Za/francois-landing';
const LOG_FILE = path.join(FRANCOIS_LANDING_DIR, '.last-deploy-log');
const DEPLOY_SCRIPT = path.join(FRANCOIS_LANDING_DIR, 'scripts', 'deploy.cjs');

async function main() {
  let payload;
  try { payload = await readStdinJson(); } catch { process.exit(0); }

  const { tool_input, tool_response } = parseToolInput(payload);
  const cmd = (tool_input && tool_input.command) ?? '';
  const output = (tool_response && (tool_response.output ?? tool_response)) ?? '';

  if (!cmd.includes('git') || !cmd.includes('push')) process.exit(0);

  // Detect francois-landing pushes via command path (primary) or output URL (fallback).
  const isFrancoisLanding =
    cmd.includes('francois-landing') ||
    String(output).includes('francois-landing.git');
  if (!isFrancoisLanding) process.exit(0);

  if (tool_response && tool_response.isError) {
    console.log('[francois-landing-autodeploy] Push failed — skipping deploy');
    process.exit(0);
  }

  // Honor [skip-deploy] token (used by deploy.cjs when it auto-pushes the
  // regenerated build-meta.ts — re-deploying that commit would just re-write
  // the same SHA and dirty the tree again).
  try {
    const { execSync } = require('child_process');
    const lastMsg = execSync('git log -1 --format=%B', {
      cwd: FRANCOIS_LANDING_DIR, encoding: 'utf8', windowsHide: true,
    }).trim();
    if (/\[skip-deploy\]/i.test(lastMsg)) {
      console.log('[francois-landing-autodeploy] [skip-deploy] token in HEAD — skipping');
      process.exit(0);
    }
  } catch { /* fall through and deploy */ }

  console.log('[francois-landing-autodeploy] Push to francois-landing detected — deploying to CF Workers in background');
  console.log(`[francois-landing-autodeploy] Log: ${LOG_FILE}`);

  spawnDetachedDeploy(DEPLOY_SCRIPT, FRANCOIS_LANDING_DIR, LOG_FILE, 'francois-landing deploy (git push trigger)');
}

main().catch(() => process.exit(0));
