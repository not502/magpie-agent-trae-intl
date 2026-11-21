// Optional, reversible Trae client refresh hook. Owner: implementer A.
//
// Contract: docs/design/interfaces.md §9.
// This module edits `<install>/resources/app/out/main.js` and drops a CJS helper
// beside it. It is OFF by default (see architecture.md §9, decision D7): the
// 3.6.20 append was only syntax-checked, never run inside the real client.
//
// Every write is gated by the SHA-256 of the untouched entry point. A build that
// is not in the allowlist is refused before the first write; the original file is
// backed up once per version and can always be restored.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CONFIG_DIR_NAME, MAIN_SHA256_TABLE } from './constants.mjs';
import { readProduct, resolveAppDir, resolvePaths } from './paths.mjs';

/**
 * Allowlist: Trae `appVersion` -> SHA-256 of the untouched `out/main.js`.
 * A build absent from this table is refused before any write.
 * @type {Readonly<Record<string, string>>}
 */
export const MAIN_SHA256 = MAIN_SHA256_TABLE;

/**
 * @typedef {object} ClientRefreshOptions
 * @property {string} [appDir]      `<install>/resources/app`; discovered when omitted.
 * @property {string} [home]        Home for `client-backups/`.
 * @property {string} [expectedHash] Test-only override; production uses MAIN_SHA256.
 * @property {boolean} [restore]    Write the original back and remove the helper.
 * @property {boolean} [dryRun]     Report what would change without touching the client.
 */

/**
 * @typedef {object} ClientRefreshResult
 * @property {'installed'|'restored'|'absent'|'unchanged'} state
 * @property {string} version
 * @property {boolean} changed
 * @property {string} [backup]      Path under the plugin config dir.
 * @property {string} updatedAt
 */

const HEX64 = /^[a-f0-9]{64}$/;
const HELPER_NAME = 'magpie-model-refresh.cjs';
const SOURCE_MAP_MARKER = '//# sourceMappingURL';

function machineError(code) {
  return Object.assign(new Error(code), { code });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Loader appended to (or inserted into) `out/main.js`. Kept deterministic so a
 * second install is byte-identical and restore can strip it exactly.
 * @param {string} version
 */
function loaderFor(version) {
  return [
    `// Magpie model catalog refresh (reversible, Trae (International) ${version}).`,
    'import("./magpie-model-refresh.cjs").then(m => (m.default ?? m).startNotifier()).catch(() => {});',
    '',
  ].join('\n');
}

function insertLoader(original, version) {
  const loader = loaderFor(version);
  const marker = original.lastIndexOf(SOURCE_MAP_MARKER);
  if (marker === -1) return original + loader;
  return original.slice(0, marker) + loader + original.slice(marker);
}

function findLoader(current) {
  for (const version of Object.keys(MAIN_SHA256)) {
    const loader = loaderFor(version);
    const at = current.indexOf(loader);
    if (at !== -1) return { version, loader, at };
  }
  return null;
}

function stripLoader(current, found) {
  return current.slice(0, found.at) + current.slice(found.at + found.loader.length);
}

function ensureDir(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch {
    throw machineError('trae_client_refresh_write_failed');
  }
}

function atomicWrite(file, content) {
  ensureDir(path.dirname(file));
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch {
    throw machineError('trae_client_refresh_write_failed');
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /* Best effort; the unique temp name cannot collide. */
    }
  }
}

function writeOnce(file, content) {
  ensureDir(path.dirname(file));
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    fs.copyFileSync(temporary, file, fs.constants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw machineError('trae_client_refresh_write_failed');
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /* Best effort; the unique temp name cannot collide. */
    }
  }
}

function backupRoot(home) {
  try {
    return resolvePaths({ HOME: home, USERPROFILE: home }).clientBackups;
  } catch {
    return path.join(home, '.config', CONFIG_DIR_NAME, 'client-backups');
  }
}

function locateApp(options) {
  if (typeof options.appDir === 'string' && options.appDir.length > 0) return options.appDir;
  try {
    return resolveAppDir().appDir;
  } catch {
    throw machineError('trae_client_not_installed');
  }
}

function readVersion(appDir) {
  try {
    const product = readProduct(appDir);
    if (product && typeof product.appVersion === 'string' && product.appVersion.length > 0) {
      return product.appVersion;
    }
  } catch {
    /* Fall back to the raw field; the SHA-256 gate remains authoritative. */
  }
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(appDir, 'product.json'), 'utf8'));
    if (raw && typeof raw.appVersion === 'string' && raw.appVersion.length > 0) return raw.appVersion;
  } catch {
    /* Not an installed client. */
  }
  throw machineError('trae_client_not_installed');
}

function notifierSource() {
  return fs.readFileSync(new URL('./refresh-notifier.cjs', import.meta.url));
}

/**
 * Install (or restore) the loader.
 * Steps: require allowlisted appVersion -> strip a known loader suffix if present
 * -> verify SHA-256 of the remainder against the allowlist -> back up the original
 * once per version with `wx` and re-verify its hash -> copy the notifier helper
 * when its hash differs -> append/replace the loader atomically -> write
 * `manifest.json`. Every rejection happens before the first write.
 * @param {ClientRefreshOptions} [options]
 * @returns {ClientRefreshResult}
 * @throws {Error} `trae_client_not_installed` | `trae_client_refresh_build_unsupported` |
 *   `trae_client_refresh_backup_invalid` | `trae_client_refresh_write_failed`.
 */
export function installClientRefresh(options = {}) {
  const restore = options.restore === true;
  const dryRun = options.dryRun === true;
  const home = typeof options.home === 'string' && options.home.length > 0 ? options.home : os.homedir();
  const appDir = locateApp(options);
  const version = readVersion(appDir);

  const expected = options.expectedHash ?? MAIN_SHA256[version];
  if (!Object.hasOwn(MAIN_SHA256, version)) {
    if (restore) {
      return { state: 'absent', version, changed: false, updatedAt: new Date().toISOString() };
    }
    throw machineError('trae_client_refresh_build_unsupported');
  }
  if (typeof expected !== 'string' || !HEX64.test(expected)) {
    throw machineError('trae_client_refresh_build_unsupported');
  }

  const main = path.join(appDir, 'out', 'main.js');
  const helper = path.join(appDir, 'out', HELPER_NAME);
  let current;
  try {
    current = fs.readFileSync(main, 'utf8');
  } catch {
    throw machineError('trae_client_not_installed');
  }

  const directory = path.join(backupRoot(home), version);
  const backup = path.join(directory, 'main.original.js');
  const manifest = path.join(directory, 'manifest.json');
  const now = () => new Date().toISOString();

  if (restore) {
    const known = findLoader(current);
    const stripped = known ? stripLoader(current, known) : current;
    let stored = null;
    try {
      stored = fs.readFileSync(backup, 'utf8');
      if (sha256(stored) !== expected) throw machineError('trae_client_refresh_backup_invalid');
    } catch (error) {
      if (error?.code === 'trae_client_refresh_backup_invalid') throw error;
      stored = null; // No backup; the hash-verified strip below stands in.
    }
    if (stored === null && !known) {
      // No backup and no trace of our loader: nothing of ours to restore.
      return { state: 'absent', version, changed: false, updatedAt: now() };
    }
    if (sha256(stripped) !== expected) {
      // Foreign edits around our loader must never be discarded silently.
      throw machineError('trae_client_refresh_build_unsupported');
    }
    const target = stored ?? stripped;
    const changed = current !== target;
    if (!dryRun && changed) atomicWrite(main, target);
    if (!dryRun) {
      try {
        fs.rmSync(helper, { force: true });
      } catch {
        throw machineError('trae_client_refresh_write_failed');
      }
    }
    const result = {
      state: changed ? 'restored' : 'unchanged',
      version,
      changed,
      backup,
      updatedAt: now(),
    };
    if (!dryRun) {
      atomicWrite(
        manifest,
        `${JSON.stringify({ state: 'restored', version, changed, backup, updatedAt: result.updatedAt }, null, 2)}\n`,
      );
    }
    return result;
  }

  const known = findLoader(current);
  let original = known ? stripLoader(current, known) : current;
  if (sha256(original) !== expected) {
    // A previous install may have left a separator we no longer know about.
    // Only an already verified backup may stand in for the original.
    let recovered;
    try {
      recovered = fs.readFileSync(backup, 'utf8');
    } catch {
      recovered = null;
    }
    if (recovered !== null && sha256(recovered) === expected) original = recovered;
    else throw machineError('trae_client_refresh_build_unsupported');
  }

  let helperChanged = true;
  let source = null;
  try {
    source = notifierSource();
    const existing = fs.readFileSync(helper);
    helperChanged = !existing.equals(source);
  } catch {
    helperChanged = true;
  }

  const target = insertLoader(original, version);
  const mainChanged = target !== current;

  if (dryRun) {
    return {
      state: mainChanged || helperChanged ? 'installed' : 'unchanged',
      version,
      changed: mainChanged,
      backup,
      updatedAt: now(),
    };
  }

  ensureDir(directory);
  writeOnce(backup, original);
  let stored;
  try {
    stored = fs.readFileSync(backup, 'utf8');
  } catch {
    throw machineError('trae_client_refresh_backup_invalid');
  }
  if (sha256(stored) !== expected) throw machineError('trae_client_refresh_backup_invalid');

  if (helperChanged) {
    try {
      source = source ?? notifierSource();
    } catch {
      throw machineError('trae_client_refresh_write_failed');
    }
    atomicWrite(helper, source);
  }
  if (mainChanged) atomicWrite(main, target);

  const changed = mainChanged;
  const result = {
    state: mainChanged || helperChanged ? 'installed' : 'unchanged',
    version,
    changed,
    backup,
    updatedAt: now(),
  };
  atomicWrite(
    manifest,
    `${JSON.stringify({ state: 'installed', version, changed, backup, updatedAt: result.updatedAt }, null, 2)}\n`,
  );
  return result;
}

/**
 * Restore the original entry point.
 * Idempotent. Without a backup the loader is still removable when stripping it
 * yields the allowlisted original; only a client with no trace of the loader
 * reports `{state:'absent', changed:false}`. A main.js that was modified around
 * our loader is refused (`trae_client_refresh_build_unsupported`) instead of
 * being silently overwritten.
 * @param {Omit<ClientRefreshOptions, 'restore'>} [options]
 * @returns {ClientRefreshResult}
 */
export function restoreClient(options = {}) {
  try {
    return installClientRefresh({ ...options, restore: true });
  } catch (error) {
    if (error?.code === 'trae_client_not_installed') {
      return { state: 'absent', version: '', changed: false, updatedAt: new Date().toISOString() };
    }
    throw error;
  }
}
