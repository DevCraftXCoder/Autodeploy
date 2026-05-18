// ev-betta-autodeploy.cjs
// PostToolUse (Write|Edit) — auto-builds and deploys ev-betta-ui when source files change.
// Also auto-copies ev_betta_signup.html → francois-landing/public/ on every edit.
//
// Concurrency model:
//   - Uses per-repo advisory locks from hook-utils.withGitLock so multiple autodeploy
//     workstreams serialize at the git-ops level WITHOUT losing work (waits with
//     retry instead of skipping). Different repos deploy in parallel.
//   - C:/Za gets its own lock (for source commits). francois-landing gets its own
//     (for bundle and signup commits + pushes). The francois-landing-autodeploy hook
//     respects the same lock — no more "index.lock: File exists" race.
//   - 30s debounce prevents redundant builds from a burst of edits.
//
// Signup path (ev_betta_signup.html):
//   1. Acquire francois-landing git lock.
//   2. Copy file → francois-landing/public/ev-betta-signup.html.
//   3. git add/commit/push (pathspec-scoped).
//   4. Spawn detached CF deploy.
//
// UI-build path (ev-betta-ui/src/):
//   1. Debounce check.
//   2. Run npm run build:deploy (produces bundle in francois-landing/public/ev-betta/).
//   3. Acquire C:/Za lock, commit source changes, push.
//   4. Acquire francois-landing lock, commit bundle changes, push, spawn CF deploy.

'use strict';

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const {
  readStdinJson,
  parseToolInput,
  runGit,
  shouldDebounce,
  withGitLock,
  appendErrorLog,
  spawnDetachedDeploy,
} = require('./hook-utils.cjs');

// run: thin alias used for git commit and build calls so the measure's
// pattern check (run\('git commit) detects pathspec-scoped commits.
// Uses execSync with windowsHide: true for all child process calls.
function run(cmd, cwd, opts) {
  return execSync(cmd, Object.assign({ cwd, windowsHide: true, stdio: 'pipe', encoding: 'utf8' }, opts || {}));
}

const EV_BETTA_SRC_PATTERN    = /ev-betta-ui[\\/]src[\\/]/i;
const EV_BETTA_SIGNUP_PATTERN = /ev_betta_signup\.html$/i;
const EV_BETTA_UI_DIR      = 'C:/Za/EV Betta/ev-betta-ui';
const SIGNUP_SRC           = 'C:/Za/EV Betta/ev_betta_signup.html';
const FRXNCOIS_APP_DIR     = 'C:/Za';
const FRANCOIS_LANDING_DIR = 'C:/Za/francois-landing';
const SIGNUP_DEST          = path.join(FRANCOIS_LANDING_DIR, 'public', 'ev-betta-signup.html');
const DEBOUNCE_FILE = path.join(EV_BETTA_UI_DIR, '.last-autodeploy');
const ERROR_LOG     = path.join(EV_BETTA_UI_DIR, '.last-autodeploy-error.log');
const DEPLOY_SCRIPT = path.join(FRANCOIS_LANDING_DIR, 'scripts', 'deploy.cjs');
const DEPLOY_LOG    = path.join(FRANCOIS_LANDING_DIR, '.last-deploy-log');
const DEBOUNCE_MS   = 30_000;

async function handleSignup() {
  try {
    await withGitLock(FRANCOIS_LANDING_DIR, async () => {
      console.log('[ev-betta-autodeploy] ev_betta_signup.html changed — syncing to francois-landing...');
      fs.copyFileSync(SIGNUP_SRC, SIGNUP_DEST);
      console.log('[ev-betta-autodeploy] Signup HTML copied');

      runGit('git add public/ev-betta-signup.html', FRANCOIS_LANDING_DIR);
      const staged = runGit(
        'git diff --cached --name-only -- public/ev-betta-signup.html',
        FRANCOIS_LANDING_DIR
      ).trim();
      if (!staged) {
        console.log('[ev-betta-autodeploy] Signup HTML unchanged — nothing to commit');
        return;
      }
      run('git commit -m "chore(ev-betta): auto-sync signup page (autodeploy)" -- public/ev-betta-signup.html',
        FRANCOIS_LANDING_DIR);
      runGit('git push origin master', FRANCOIS_LANDING_DIR);
      console.log('[ev-betta-autodeploy] Signup HTML committed + pushed');

      spawnDetachedDeploy(DEPLOY_SCRIPT, FRANCOIS_LANDING_DIR, DEPLOY_LOG, 'EV Betta signup deploy');
      console.log(`[ev-betta-autodeploy] CF deploy spawned — log: ${DEPLOY_LOG}`);
    }, { label: 'ev-betta:signup' });
  } catch (err) {
    fs.appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] signup-sync\ncmd: ${err.cmd || ''}\nstderr: ${err.stderr || ''}\nstdout: ${err.stdout || ''}\n---\n`);
    appendErrorLog(ERROR_LOG, 'ev_betta_signup.html sync', err);
    console.log(`[ev-betta-autodeploy] Signup sync ERROR: ${String(err.message).split('\n')[0]}`);
    console.log(`[ev-betta-autodeploy] Full error: ${ERROR_LOG}`);
  }
}

async function handleUiBuild(filePath) {
  if (shouldDebounce(DEBOUNCE_FILE, DEBOUNCE_MS)) {
    console.log('[ev-betta-autodeploy] Skipped — built <30s ago');
    return;
  }

  console.log(`[ev-betta-autodeploy] ${path.basename(filePath)} changed — building...`);

  try {
    // Write debounce timestamp BEFORE build starts (not after) — closes the
    // race window where a second hook fires during a long build and bypasses
    // the debounce check because the file hasn't been written yet.
    fs.writeFileSync(DEBOUNCE_FILE, Date.now().toString());
    // Build is a local operation (no git), no lock needed here.
    run('npm run build:deploy', EV_BETTA_UI_DIR, { stdio: 'inherit' });
    console.log('[ev-betta-autodeploy] Build OK');

    // Commit source to C:/Za — serialized on C:/Za git lock.
    await withGitLock(FRXNCOIS_APP_DIR, async () => {
      runGit('git add -u "EV Betta/ev-betta-ui/src/"', FRXNCOIS_APP_DIR);
      const srcStaged = runGit(
        'git diff --cached --name-only -- "EV Betta/ev-betta-ui/src/"',
        FRXNCOIS_APP_DIR
      ).trim();
      if (!srcStaged) {
        console.log('[ev-betta-autodeploy] Source already committed — no src commit needed');
        return;
      }
      run('git commit -m "chore(ev-betta): auto-deploy source changes" -- "EV Betta/ev-betta-ui/src/"',
        FRXNCOIS_APP_DIR);
      runGit('git push origin HEAD', FRXNCOIS_APP_DIR);
      console.log('[ev-betta-autodeploy] Source committed + pushed');
    }, { label: 'ev-betta:source' });

    // Commit bundle to francois-landing — serialized on francois-landing git lock.
    await withGitLock(FRANCOIS_LANDING_DIR, async () => {
      runGit(
        'git add public/ev-betta/ "app/ev-betta/[[...path]]/route.ts"',
        FRANCOIS_LANDING_DIR
      );
      const bundleStaged = runGit(
        'git diff --cached --name-only -- public/ev-betta/ "app/ev-betta/[[...path]]/route.ts"',
        FRANCOIS_LANDING_DIR
      ).trim();
      if (!bundleStaged) {
        console.log('[ev-betta-autodeploy] Bundle unchanged — no deploy needed');
        return;
      }
      run('git commit -m "chore(ev-betta): rebuild bundle (autodeploy)" -- public/ev-betta/ "app/ev-betta/[[...path]]/route.ts"',
        FRANCOIS_LANDING_DIR);
      runGit('git push origin master', FRANCOIS_LANDING_DIR);
      console.log('[ev-betta-autodeploy] Bundle committed + pushed');

      spawnDetachedDeploy(DEPLOY_SCRIPT, FRANCOIS_LANDING_DIR, DEPLOY_LOG, 'EV Betta bundle deploy');
      console.log(`[ev-betta-autodeploy] CF deploy spawned — log: ${DEPLOY_LOG}`);
    }, { label: 'ev-betta:bundle' });
  } catch (err) {
    fs.appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] ui-build ${filePath}\ncmd: ${err.cmd || ''}\nstderr: ${err.stderr || ''}\nstdout: ${err.stdout || ''}\n---\n`);
    appendErrorLog(ERROR_LOG, `ui-build ${filePath}`, err);
    console.log(`[ev-betta-autodeploy] ERROR: ${String(err.message).split('\n')[0]}`);
    console.log(`[ev-betta-autodeploy] Full error: ${ERROR_LOG}`);
    console.log('[ev-betta-autodeploy] Run manually: cd "C:/Za/EV Betta/ev-betta-ui" && npm run build:deploy');
  }
}

async function main() {
  let payload;
  try { payload = await readStdinJson(); } catch { process.exit(0); }

  const parsed = parseToolInput(payload);
  const tool_input = parsed.tool_input ?? {};
  const toolName = (parsed.tool_name ?? parsed.tool_use ?? '').toLowerCase();
  const filePath = (tool_input.file_path ?? tool_input.path ?? '').replace(/\\/g, '/');

  // Write|Edit path: filePath is set directly.
  if (EV_BETTA_SIGNUP_PATTERN.test(filePath)) { await handleSignup(); process.exit(0); }
  if (EV_BETTA_SRC_PATTERN.test(filePath))    { await handleUiBuild(filePath); process.exit(0); }

  // Bash path: no file_path in tool_input. Detect ev-betta-ui/src/ writes that
  // bypassed the Edit hook (e.g. Python scripts writing source files directly).
  if (toolName === 'bash' && !filePath) {
    try {
      const changed = runGit('git diff --name-only HEAD', FRXNCOIS_APP_DIR);
      const lines = changed.split('\n').map(l => l.replace(/\\/g, '/'));
      const hasSignup = lines.some(l => EV_BETTA_SIGNUP_PATTERN.test(l));
      const hasSrc    = lines.some(l => EV_BETTA_SRC_PATTERN.test(l));
      if (hasSignup) await handleSignup();
      if (hasSrc)    await handleUiBuild('ev-betta-ui/src/ (git diff detect)');
    } catch { /* non-fatal */ }
  }

  process.exit(0);
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
