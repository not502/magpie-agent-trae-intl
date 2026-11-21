#!/usr/bin/env node
// Publish-surface gate. Verifies that `npm pack` ships runtime files only.
//
// Two layers: (1) the package.json `files` whitelist itself, (2) the real
// `npm pack --dry-run --json` output, invoked through child_process with a shell
// exactly as a maintainer would run it. Reference material, docs, tests, scripts,
// backups and local state must never appear in either.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const REQUIRED_FILES = ['trae.agent.js', 'index.mjs', 'cli.mjs', 'restore.mjs', 'src', 'assets'];
const REQUIRED_PACKED = [
  'package.json',
  'index.mjs',
  'trae.agent.js',
  'cli.mjs',
  'restore.mjs',
  'src/constants.mjs',
  'src/refresh-notifier.cjs',
  'assets/trae.svg',
  'LICENSE',
  'README.md',
];
const FORBIDDEN_SEGMENTS = new Set([
  '.reference', '.zcode', '.git', 'node_modules', 'docs', 'test', 'tests', 'fixtures', 'testdata',
  'scripts', 'coverage', 'dist', 'client-backups', 'backups', 'backup',
]);
const FORBIDDEN_EXACT = new Set([
  '.gitignore', '.npmignore', 'package-lock.json', 'bun.lock', 'pnpm-lock.yaml',
  'connection.json', 'managed-models.json', 'sync-status.json',
  'client-refresh-status.json', 'local-credential.json', 'model-sync.lock',
  '.env', '.env.local', '.env.development', '.env.production',
]);
const FORBIDDEN_NAME = /(?:\.(?:bak|backup|orig|original|tmp|temp|log|tgz|pem|key|p12|pfx)$|\.local\.json$|\.original\.[^/]+$|\.tmp\.|(?:^|\/)\.env(?:\.|$))/i;

const problems = [];

if (pkg.name !== 'magpie-agent-trae-intl' || pkg.version !== '0.1.0') {
  problems.push(`unexpected package identity ${pkg.name}@${pkg.version}`);
}
if (pkg.private === true) problems.push('package.json must stay publishable (private !== true)');
if (!Array.isArray(pkg.files)) problems.push('package.json has no files whitelist');

const declared = Array.isArray(pkg.files) ? pkg.files.map(entry => entry.replace(/\\/g, '/').replace(/\/+$/, '')) : [];
for (const required of REQUIRED_FILES) {
  if (!declared.includes(required)) problems.push(`files whitelist is missing "${required}"`);
}
for (const entry of declared) {
  const segments = entry.split('/').map(segment => segment.toLowerCase());
  const base = segments.at(-1) ?? '';
  if (segments.some(segment => FORBIDDEN_SEGMENTS.has(segment))
    || FORBIDDEN_EXACT.has(entry) || FORBIDDEN_EXACT.has(base)
    || FORBIDDEN_NAME.test(entry)) {
    problems.push(`files whitelist contains forbidden entry "${entry}"`);
  }
  if (!existsSync(path.join(ROOT, entry))) problems.push(`files whitelist entry does not exist: "${entry}"`);
}

/** A packed path is allowed when package.json always ships it or `files` covers it. */
function allowedByWhitelist(name) {
  if (name === 'package.json') return true;
  return declared.some(entry => name === entry || name.startsWith(`${entry}/`));
}

function forbiddenReason(name) {
  const segments = name.split('/');
  const base = segments.at(-1) ?? name;
  if (FORBIDDEN_EXACT.has(name) || FORBIDDEN_EXACT.has(base)) return 'local state file';
  if (FORBIDDEN_NAME.test(name)) return 'backup/temporary/log archive';
  for (const segment of segments) {
    if (FORBIDDEN_SEGMENTS.has(segment.toLowerCase())) return `forbidden directory "${segment}"`;
  }
  return null;
}

// The ask requires a shell invocation of npm itself, not a resolved npm-cli.js.
const command = 'npm pack --dry-run --json --ignore-scripts';
const packed = spawnSync(command, {
  cwd: ROOT,
  encoding: 'utf8',
  shell: true,
  windowsHide: true,
  timeout: 120000,
});

if (packed.error || packed.status !== 0) {
  const detail = (packed.error?.message || packed.stderr || '').trim().split(/\r?\n/)[0] || `exit ${packed.status}`;
  problems.push(`"${command}" failed: ${detail}`);
} else {
  const start = packed.stdout.search(/[[{]/);
  let report;
  try {
    report = JSON.parse(packed.stdout.slice(start));
  } catch {
    problems.push('could not parse npm pack --dry-run --json output');
  }
  if (report) {
    const files = (Array.isArray(report) ? report[0]?.files : report.files) || [];
    const names = files.map(file => String(file.path).replace(/\\/g, '/'));

    for (const name of names) {
      const reason = forbiddenReason(name);
      if (reason) problems.push(`npm pack would publish ${reason}: "${name}"`);
      else if (!allowedByWhitelist(name)) problems.push(`npm pack would publish a file outside the runtime whitelist: "${name}"`);
    }
    for (const required of REQUIRED_PACKED) {
      if (!names.includes(required)) problems.push(`npm pack is missing required runtime path "${required}"`);
    }
    console.log(`pack-check: ${command} lists ${names.length} file(s)`);
    console.log(`pack-check: ${names.join(', ')}`);
  }
}

for (const problem of problems) console.error(`pack-check: ${problem}`);
if (problems.length) {
  console.error(`pack-check: ${problems.length} problem(s)`);
  process.exitCode = 1;
} else {
  console.log('pack-check: ok (runtime files only; no docs, tests, scripts, backups or local state)');
}
