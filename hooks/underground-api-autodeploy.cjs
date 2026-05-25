// underground-api-autodeploy.cjs
// PostToolUse (Write|Edit) — auto-deploys underground-api to Cloudflare Workers when
// source files change.
//
// Concurrency: this hook runs `wrangler deploy`, which does not touch any git repo,
// so it never conflicts with ev-betta-autodeploy or francois-landing-autodeploy.
// Multiple sibling deploys can run in parallel across different projects.
//
// Self-exclusion: a 60s debounce prevents a burst of src edits from triggering
// overlapping wrangler calls against the same Worker.

'use strict';

const path = require('path');
const fs = require('fs');
const {
  readStdinJson,
  parseToolInput,
  shouldDebounce,
  appendErrorLog,
  spawnDetachedDeploy,
  spawnDetachedPackageScript,
} = require('./hook-utils.cjs');

const SRC_PATTERN = /packages[\\/]underground-api[\\/]src[\\/]/i;
const API_DIR = 'C:/Za/packages/underground-api';
const DEBOUNCE_FILE = path.join(API_DIR, '.last-autodeploy');
const ERROR_LOG = path.join(API_DIR, '.last-autodeploy-error.log');
const DEPLOY_LOG = path.join(API_DIR, '.last-deploy-log');
const DEPLOY_SCRIPT = path.join(API_DIR, 'scripts', 'deploy.cjs');
const DEBOUNCE_MS = 60_000;

async function main() {
  let payload;
  try { payload = await readStdinJson(); } catch { process.exit(0); }

  const { tool_input } = parseToolInput(payload);
  const filePath = (tool_input.file_path ?? tool_input.path ?? '').replace(/\\/g, '/');

  if (!SRC_PATTERN.test(filePath)) process.exit(0);

  if (shouldDebounce(DEBOUNCE_FILE, DEBOUNCE_MS)) {
    console.log('[underground-api-autodeploy] Skipped — deployed <60s ago');
    process.exit(0);
  }

  console.log(`[underground-api-autodeploy] ${path.basename(filePath)} changed — deploying...`);

  if (fs.existsSync(DEPLOY_SCRIPT)) {
    spawnDetachedDeploy(DEPLOY_SCRIPT, API_DIR, DEPLOY_LOG, 'underground-api deploy');
  } else {
    spawnDetachedPackageScript(API_DIR, 'deploy', DEPLOY_LOG, 'underground-api deploy');
  }
  console.log('[underground-api-autodeploy] Deploy spawned in background — Worker updating');
  console.log(`[underground-api-autodeploy] Log: ${DEPLOY_LOG}`);
}

main().catch(err => {
  try {
    fs.appendFileSync(
      ERROR_LOG,
      `[${new Date().toISOString()}] UNCAUGHT: ${err && (err.stack || err.message)}\n---\n`
    );
  } catch { /* non-fatal */ }
  process.exit(0);
});
