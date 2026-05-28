// hook-utils.cjs
// SHARED UTILITY — required by all hooks
// Provides:
//   - readStdinJson() / parseToolInput()  (stdin parsing, used by every hook)
//   - runGit()                             (execSync wrapper)
//   - shouldDebounce()                     (stamp-file debounce)
//   - withGitLock()                        (per-repo advisory lock outside .git/
//                                          — never fights git's own index.lock;
//                                          waits-with-retry so concurrent deploys
//                                          serialize instead of dropping)
//   - sweepStaleGitLock()                  (removes stale .git/index.lock)
//   - appendErrorLog()                     (standard error format with PAT redaction)
//   - spawnDetachedDeploy()                (correct fd handling for background wrangler)
//   - repoIsMidOperation()                 (detects merge/rebase/cherry-pick state)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');

const STATE_DIR = process.env.AUTODEPLOY_STATE_DIR ||
  (process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Autodeploy')
    : path.join(os.homedir(), '.autodeploy'));
const LOCK_DIR = process.env.AUTODEPLOY_LOCK_DIR || path.join(STATE_DIR, 'locks');

function ensureLockDir() {
  try { fs.mkdirSync(LOCK_DIR, { recursive: true }); } catch { /* exists */ }
}

function lockFileFor(repoDir) {
  const key = repoDir.replace(/[\\/:]+/g, '_').replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(LOCK_DIR, `${key}.gitlock`);
}

function readStdinJson(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    const timer = setTimeout(() => reject(new Error('stdin timeout')), timeoutMs);

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { raw += chunk; });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error(`stdin parse error: ${e.message}`));
      }
    });
    process.stdin.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function parseToolInput(payload) {
  return {
    tool_name: payload.tool_name ?? '',
    tool_input: payload.tool_input ?? {},
    tool_response: payload.tool_response,
  };
}

function runGit(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8', windowsHide: true });
}

// Returns true if we should skip (last stamp within ttlMs). Writes stamp if NOT skipping.
function shouldDebounce(debounceFile, ttlMs) {
  try {
    const last = parseInt(fs.readFileSync(debounceFile, 'utf8').trim(), 10);
    if (!isNaN(last) && Date.now() - last < ttlMs) return true;
  } catch { /* no file yet */ }
  try { fs.writeFileSync(debounceFile, String(Date.now())); } catch { /* non-fatal */ }
  return false;
}

// Remove .git/index.lock if it is older than ttlMs — handles crashed git processes.
function sweepStaleGitLock(repoDir, ttlMs = 60_000) {
  const idx = path.join(repoDir, '.git', 'index.lock');
  try {
    const st = fs.statSync(idx);
    if (Date.now() - st.mtimeMs > ttlMs) {
      fs.unlinkSync(idx);
      return true;
    }
  } catch { /* absent — nothing to sweep */ }
  return false;
}

// Advisory per-repo lock. Lives outside .git/ so it never collides with git's own
// index.lock. Multiple hooks calling withGitLock(sameRepo, ...) serialize; hooks
// calling withGitLock(differentRepo, ...) run in parallel.
//
// On contention, waits up to maxWaitMs (default 3 min) polling at pollMs. Stale
// locks older than staleMs (default 2 min) are reclaimed.
async function withGitLock(repoDir, fn, opts = {}) {
  const {
    staleMs = 120_000,
    maxWaitMs = 180_000,
    pollMs = 500,
    label = 'hook',
  } = opts;

  ensureLockDir();
  const lockFile = lockFileFor(repoDir);
  const myToken = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const start = Date.now();

  // Acquire
  while (true) {
    try {
      const fd = fs.openSync(lockFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
      fs.writeSync(fd, myToken);
      fs.closeSync(fd);
      break;
    } catch {
      try {
        const st = fs.statSync(lockFile);
        if (Date.now() - st.mtimeMs > staleMs) {
          try { fs.unlinkSync(lockFile); } catch { /* race with another reclaim */ }
          continue;
        }
      } catch { continue; /* lock vanished between attempts */ }

      if (Date.now() - start > maxWaitMs) {
        throw new Error(`withGitLock: ${repoDir} still held after ${maxWaitMs}ms (label: ${label})`);
      }
      await new Promise(r => setTimeout(r, pollMs));
    }
  }

  sweepStaleGitLock(repoDir);

  try {
    return await fn();
  } finally {
    try {
      const contents = fs.readFileSync(lockFile, 'utf8');
      if (contents === myToken) fs.unlinkSync(lockFile);
    } catch { /* already gone */ }
  }
}

// Redact HTTPS PATs and common token patterns before persisting error output.
function redactSecrets(text) {
  if (text == null) return '';
  return String(text)
    .replace(/https:\/\/[^@\s]+@github\.com/g, 'https://***@github.com')
    .replace(/ghp_[A-Za-z0-9]{20,}/g, 'ghp_***')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_***');
}

function appendErrorLog(logFile, context, err) {
  const body =
    `[${new Date().toISOString()}] ${context}\n` +
    `cmd: ${err && err.cmd ? err.cmd : '(unknown)'}\n` +
    `stderr:\n${redactSecrets(err && err.stderr)}\n` +
    `stdout:\n${redactSecrets(err && err.stdout)}\n` +
    `message: ${redactSecrets(err && err.message)}\n` +
    '---\n';
  ensureLogParent(logFile);
  try { fs.appendFileSync(logFile, body); } catch { /* non-fatal */ }
}

function ensureLogParent(logFile) {
  try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); } catch { /* non-fatal */ }
}

// Trim a log file to at most maxLines by keeping the tail.
// Called before appending to prevent unbounded growth (e.g. last-deploy-log).
const LOG_MAX_LINES = 500;
function trimLogFile(logFile, maxLines) {
  const limit = maxLines || LOG_MAX_LINES;
  try {
    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.split('\n');
    if (lines.length <= limit) return;
    fs.writeFileSync(logFile, lines.slice(-limit).join('\n'), 'utf8');
  } catch { /* non-fatal — if file doesn't exist yet, no-op */ }
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function quoteArg(arg) {
  const text = String(arg);
  return /[\s"']/g.test(text) ? JSON.stringify(text) : text;
}

function commandPreview(command, args) {
  return redactSecrets([command, ...(args || [])].map(quoteArg).join(' '));
}

// Spawn a detached command without a shell. Use this for npm/wrangler wrappers
// so hook payloads never become executable command strings.
function spawnDetachedCommand(command, args, cwd, logFile, label = 'deploy', opts = {}) {
  ensureLogParent(logFile);
  trimLogFile(logFile);
  const stamp =
    `\n=== ${label} at ${new Date().toISOString()} ===\n` +
    `cwd: ${cwd}\n` +
    `cmd: ${commandPreview(command, args)}\n`;
  try { fs.appendFileSync(logFile, stamp); } catch { /* non-fatal */ }

  let fd;
  try {
    fd = fs.openSync(logFile, 'a');
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      shell: false,
      env: Object.assign({}, process.env, opts.env || {}),
    });
    child.unref();
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

function spawnDetachedPackageScript(cwd, scriptName, logFile, label = 'deploy', opts = {}) {
  spawnDetachedCommand(npmCommand(), ['run', scriptName], cwd, logFile, label, opts);
}

// Spawn a detached Node script (e.g. wrangler deploy). Returns immediately; child
// continues after hook exit. Returns the child PID so callers can track in-flight state.
// Parent fd is closed so we don't leak — child inherits its own copy via stdio.
function spawnDetachedDeploy(scriptPath, cwd, logFile, label = 'deploy') {
  ensureLogParent(logFile);
  trimLogFile(logFile);
  const stamp =
    `\n=== ${label} at ${new Date().toISOString()} ===\n` +
    `cwd: ${cwd}\n` +
    `cmd: ${commandPreview(process.execPath, [scriptPath])}\n`;
  try { fs.appendFileSync(logFile, stamp); } catch { /* non-fatal */ }
  let fd;
  let childPid = null;
  try {
    fd = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, [scriptPath], {
      cwd,
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    });
    childPid = child.pid;
    child.unref();
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
  return childPid;
}

// Returns a marker name if an in-progress git op is detected, else null.
function repoIsMidOperation(repoDir) {
  const gitDir = path.join(repoDir, '.git');
  const markers = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'rebase-merge', 'rebase-apply'];
  for (const m of markers) {
    try {
      fs.accessSync(path.join(gitDir, m));
      return m;
    } catch { /* absent */ }
  }
  return null;
}

module.exports = {
  readStdinJson,
  parseToolInput,
  runGit,
  shouldDebounce,
  sweepStaleGitLock,
  withGitLock,
  redactSecrets,
  appendErrorLog,
  trimLogFile,
  spawnDetachedCommand,
  spawnDetachedPackageScript,
  spawnDetachedDeploy,
  repoIsMidOperation,
};
