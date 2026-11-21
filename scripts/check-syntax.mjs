#!/usr/bin/env node
// Syntax gate for every JavaScript file in the repository.
//
// Deliberately self-contained: no dependency on a linter, a build step or the
// host. Skips dependency, tool and reference directories (.git, node_modules,
// .zcode, .reference, build output), then runs `node --check` once per file.

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SKIP = new Set(['node_modules', '.git', '.zcode', '.reference', 'coverage', 'dist', '.cache', '.vite', 'artifacts']);
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

function walk(directory, found = []) {
  for (const name of readdirSync(directory, { withFileTypes: true })) {
    if (SKIP.has(name.name)) continue;
    const absolute = path.join(directory, name.name);
    if (name.isDirectory()) walk(absolute, found);
    else if (name.isFile() && EXTENSIONS.has(path.extname(name.name).toLowerCase())) found.push(absolute);
  }
  return found;
}

const files = walk(ROOT).sort();
const failures = [];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
  if (result.error) {
    failures.push({ file, message: result.error.message });
    continue;
  }
  if (result.status !== 0) {
    const output = `${result.stderr || ''}${result.stdout || ''}`.trim().split(/\r?\n/).slice(0, 12).join('\n');
    failures.push({ file, message: output || `node --check exited ${result.status}` });
  }
}

for (const failure of failures) {
  console.error(`check-syntax: FAIL ${path.relative(ROOT, failure.file)}`);
  console.error(failure.message.replace(/^/gm, '  '));
}

if (failures.length) {
  console.error(`check-syntax: ${failures.length} of ${files.length} file(s) failed`);
  process.exitCode = 1;
} else {
  console.log(`check-syntax: ok (${files.length} file(s), node --check)`);
}
