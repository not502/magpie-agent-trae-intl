// Test-only filesystem helpers. Every directory lives under os.tmpdir() with a
// random name and is removed by the test's `after` hook. No fixture in this
// folder may contain a real token, key, account id, device id or absolute path.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PREFIX = 'magpie-trae-intl-test-';

/**
 * Create a random temporary directory owned by the test.
 * @param {import('node:test').TestContext} t
 * @param {string} [name] Optional readable suffix (never a path).
 * @returns {string}
 */
export function createTempDir(t, name = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${PREFIX}${name ? `${name}-` : ''}`));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Best effort: a failed cleanup must not fail the test result. */
    }
  });
  return dir;
}

/** @param {string} file @param {unknown} value */
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** @param {string} file @returns {any} */
export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** @param {string} file @returns {boolean} */
export function exists(file) {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} file @returns {string} */
export function readText(file) {
  return fs.readFileSync(file, 'utf8');
}
