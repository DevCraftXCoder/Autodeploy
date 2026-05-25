#!/usr/bin/env node
// task-complete-autodeploy.cjs
// Claude Stop / Codex manual hook that deploys Cloudflare-backed projects touched
// during the completed task. It is intentionally non-blocking: deploys are queued
// as detached processes and this hook exits 0.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const {
  readStdinJson,
  parseToolInput,
  shouldDebounce,
  appendErrorLog,
  spawnDetachedDeploy,
  spawnDetachedPackageScript,
  redactSecrets,
} = require('./hook-utils.cjs');

const DEFAULT_WORKSPACE = process.env.AUTODEPLOY_WORKSPACE || 'C:/Za';
const STATE_DIR = process.env.AUTODEPLOY_STATE_DIR ||
  (process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Autodeploy')
    : path.join(os.homedir(), '.autodeploy'));
const ERROR_LOG = path.join(STATE_DIR, 'task-complete-autodeploy-error.log');
const DEFAULT_DEBOUNCE_MS = Number(process.env.AUTODEPLOY_TASK_DEBOUNCE_MS || 5 * 60 * 1000);
const RECENT_COMMIT_MS = Number(process.env.AUTODEPLOY_RECENT_COMMIT_MS || 2 * 60 * 60 * 1000);

function buildTargets(workspace) {
  return [
    {
      id: 'francois-landing',
      cwd: path.join(workspace, 'francois-landing'),
      patterns: [
        /^francois-landing\//i,
        /^EV Betta\/ev-betta-ui\/src\//i,
        /^EV Betta\/ev_betta_signup\.html$/i,
      ],
      logFile: path.join(workspace, 'francois-landing', '.last-deploy-log'),
      scriptPath: path.join(workspace, 'francois-landing', 'scripts', 'deploy.cjs'),
      debounceMs: DEFAULT_DEBOUNCE_MS,
      skipToken: /\[skip-deploy\]/i,
    },
    {
      id: 'underground-api',
      cwd: path.join(workspace, 'packages', 'underground-api'),
      patterns: [
        /^packages\/underground-api\/src\//i,
        /^packages\/underground-api\/migrations\//i,
        /^packages\/underground-api\/wrangler\.(jsonc|json|toml)$/i,
        /^packages\/underground-api\/package(-lock)?\.json$/i,
      ],
      logFile: path.join(workspace, 'packages', 'underground-api', '.last-deploy-log'),
      scriptPath: path.join(workspace, 'packages', 'underground-api', 'scripts', 'deploy.cjs'),
      packageScript: 'deploy',
      debounceMs: 60 * 1000,
    },
    {
      id: 'cf-memory-worker',
      cwd: path.join(workspace, 'packages', 'cf-memory-worker'),
      patterns: [
        /^packages\/cf-memory-worker\//i,
      ],
      logFile: path.join(workspace, 'packages', 'cf-memory-worker', '.last-deploy-log'),
      packageScript: 'deploy',
      debounceMs: 60 * 1000,
    },
  ];
}

function parseArgs(argv) {
  const args = { all: false, dryRun: false, files: [], workspace: DEFAULT_WORKSPACE };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--all') args.all = true;
    else if (item === '--dry-run') args.dryRun = true;
    else if (item === '--workspace' && argv[i + 1]) args.workspace = argv[++i];
    else if (item === '--file' && argv[i + 1]) args.files.push(argv[++i]);
  }
  return args;
}

function gitLines(cwd, command) {
  try {
    return execSync(command, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeFile(filePath, workspace) {
  if (!filePath) return '';
  let value = String(filePath).replace(/\\/g, '/');
  const root = path.resolve(workspace).replace(/\\/g, '/').replace(/\/$/, '');
  if (value.toLowerCase().startsWith(root.toLowerCase() + '/')) {
    value = value.slice(root.length + 1);
  }
  return value.replace(/^\.\//, '');
}

function readSessionFiles(workspace) {
  const sessionFiles = process.env.AUTODEPLOY_SESSION_FILES ||
    path.join(workspace, '.claude', 'session-files.json');
  try {
    const data = JSON.parse(fs.readFileSync(sessionFiles, 'utf8'));
    return Array.isArray(data.files) ? data.files.map(file => normalizeFile(file, workspace)) : [];
  } catch {
    return [];
  }
}

async function readHookPayload() {
  if (process.stdin.isTTY) return null;
  try {
    return await readStdinJson(750);
  } catch {
    return null;
  }
}

function collectFiles(payload, args) {
  const workspace = args.workspace;
  const files = new Set(args.files.map(file => normalizeFile(file, workspace)).filter(Boolean));
  let hasExplicitFiles = files.size > 0;

  if (payload) {
    const { tool_input } = parseToolInput(payload);
    const payloadFile = normalizeFile(tool_input.file_path ?? tool_input.path ?? '', workspace);
    if (payloadFile) {
      files.add(payloadFile);
      hasExplicitFiles = true;
    }
  }

  if (hasExplicitFiles) return [...files];

  const sessionFiles = readSessionFiles(workspace);
  for (const file of sessionFiles) files.add(file);

  for (const line of gitLines(workspace, 'git diff --name-only HEAD')) files.add(normalizeFile(line, workspace));
  for (const line of gitLines(workspace, 'git diff --cached --name-only')) files.add(normalizeFile(line, workspace));

  if (files.size === 0 && latestCommitIsRecent(workspace)) {
    for (const line of gitLines(workspace, 'git show --name-only --format= HEAD')) files.add(normalizeFile(line, workspace));
  }

  files.delete('');
  return [...files];
}

function latestCommitIsRecent(workspace) {
  try {
    const raw = execSync('git log -1 --format=%ct', { cwd: workspace, encoding: 'utf8', windowsHide: true }).trim();
    const commitMs = Number(raw) * 1000;
    return Number.isFinite(commitMs) && Date.now() - commitMs < RECENT_COMMIT_MS;
  } catch {
    return false;
  }
}

function headMessage(cwd) {
  try {
    return execSync('git log -1 --format=%B', { cwd, encoding: 'utf8', windowsHide: true }).trim();
  } catch {
    return '';
  }
}

function touchedTargets(files, all, targets) {
  if (all) return targets.filter(target => fs.existsSync(target.cwd));
  return targets.filter(target =>
    fs.existsSync(target.cwd) &&
    files.some(file => target.patterns.some(pattern => pattern.test(file)))
  );
}

function deployTarget(target, dryRun) {
  if (target.skipToken && target.skipToken.test(headMessage(target.cwd))) {
    process.stderr.write(`[task-complete-autodeploy] ${target.id}: skip token found in HEAD\n`);
    return false;
  }

  const label = `${target.id} task-complete deploy`;
  if (dryRun) {
    const mode = target.scriptPath && fs.existsSync(target.scriptPath)
      ? `node ${target.scriptPath}`
      : `npm run ${target.packageScript || 'deploy'}`;
    process.stdout.write(`[task-complete-autodeploy] dry-run ${target.id}: ${mode}\n`);
    return true;
  }

  const stamp = path.join(STATE_DIR, `${target.id}.last-task-autodeploy`);
  if (shouldDebounce(stamp, target.debounceMs)) {
    process.stderr.write(`[task-complete-autodeploy] ${target.id}: skipped by debounce\n`);
    return false;
  }

  if (target.scriptPath && fs.existsSync(target.scriptPath)) {
    spawnDetachedDeploy(target.scriptPath, target.cwd, target.logFile, label);
  } else {
    spawnDetachedPackageScript(target.cwd, target.packageScript || 'deploy', target.logFile, label, {
      env: { AUTODEPLOY_TRIGGER: 'task-complete' },
    });
  }

  process.stdout.write(`[task-complete-autodeploy] queued ${target.id}; log: ${target.logFile}\n`);
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const payload = await readHookPayload();
  const files = collectFiles(payload, args);
  const targets = touchedTargets(files, args.all, buildTargets(args.workspace));

  if (targets.length === 0) {
    if (args.dryRun || process.env.AUTODEPLOY_VERBOSE === '1') {
      process.stdout.write('[task-complete-autodeploy] no deploy target touched\n');
    }
    process.exit(0);
  }

  for (const target of targets) deployTarget(target, args.dryRun);
  process.exit(0);
}

main().catch(err => {
  appendErrorLog(ERROR_LOG, 'task-complete-autodeploy uncaught', {
    message: redactSecrets(err && (err.stack || err.message)),
  });
  process.exit(0);
});
