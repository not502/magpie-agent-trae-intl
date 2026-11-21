// Durable state primitives. Owner: implementer A (state) / shared by sync (B).
//
// Contract: docs/design/interfaces.md §6 and §15.
// All writes are atomic and 0600; the containing directory is 0700.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolvePaths } from './paths.mjs';

/**
 * @typedef {object} SyncPaths
 * @property {string} control   connection.json (host-written, read-only here).
 * @property {string} state     managed-models.json.
 * @property {string} credential local-credential.json.
 * @property {string} lock      model-sync.lock.
 * @property {string} status    sync-status.json.
 */

/**
 * @typedef {object} PendingAdd
 * @property {'add'} kind
 * @property {string} model
 * @property {import('./sync.mjs').ModelRequest} request
 * @property {2} [credentialFormat]
 */

/**
 * @typedef {object} PendingUpdate
 * @property {'update'} kind
 * @property {string} model
 * @property {import('./api.mjs').CatalogEntry} before
 * @property {import('./sync.mjs').ModelUpdateRequest} body
 * @property {2} [credentialFormat]
 * @property {boolean} [release] Delete the journal entry after a successful restore.
 */

/**
 * @typedef {object} PendingDelete
 * @property {'delete'} kind
 * @property {string} model
 * @property {import('./api.mjs').CatalogEntry} before
 */

/**
 * @typedef {object} ManagedEntry
 * @property {string} id        Server-side custom_model_id (string).
 * @property {boolean} created  true = this plugin created it; false = adopted.
 * @property {string} last      Fingerprint at the last successful write.
 * @property {2} [credentialFormat]
 * @property {import('./api.mjs').CatalogEntry} [before] Present only for adoptions.
 */

/**
 * @typedef {object} Journal
 * @property {2} version
 * @property {string} account   Lowercase hex SHA-256 of the account id.
 * @property {Record<string, ManagedEntry>} entries Keyed by model id.
 * @property {PendingAdd|PendingUpdate|PendingDelete|null} pending At most one.
 */

/** @param {string} code @returns {Error} */
function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/**
 * Persistence paths, derived from the single path resolver.
 * @param {string} [home] Home directory override (tests).
 * @returns {SyncPaths}
 * @throws {Error} `trae_home_invalid` when `home` is not absolute.
 */
export function syncPaths(home = os.homedir()) {
  // Keep the ambient environment so the synchronizer and restore.mjs resolve
  // HOME/USERPROFILE the same way the bridge and doctor do, while an explicit
  // `home` still wins over the ambient values.
  const paths = resolvePaths({ ...process.env, USERPROFILE: home, HOME: home });
  return {
    control: paths.connection,
    state: paths.state,
    credential: paths.credential,
    lock: paths.lock,
    status: paths.status,
  };
}

/**
 * Read JSON with an ENOENT-only fallback.
 * @template T
 * @param {string} file
 * @param {T} fallback Returned when the file does not exist.
 * @returns {T|unknown}
 * @throws {Error} `sync_file_unreadable` for any other read/parse failure.
 */
export function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw failure('sync_file_unreadable');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw failure('sync_file_unreadable');
  }
}

/**
 * Atomically replace a JSON file: `<file>.<uuid>.tmp`, flag `wx`, mode 0600, rename.
 * @param {string} file
 * @param {unknown} value
 * @returns {void}
 * @throws {Error} `sync_file_unwritable` on failure; the temp file is always removed.
 */
export function writeJsonAtomic(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch {
    throw failure('sync_file_unwritable');
  }
  let serialized;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch {
    throw failure('sync_file_unwritable');
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, serialized, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch {
    throw failure('sync_file_unwritable');
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /* Best effort; a stale temp file never shadows the real one. */
    }
  }
}

/** Age after which an unparseable lock file is treated as a crashed write. */
const CORRUPT_LOCK_AGE_MS = 10_000;
/** Bound on reclaim retries so a pathological loop still fails with sync_busy. */
const LOCK_ATTEMPTS = 8;

/**
 * Inspect the current lock slot without throwing on content problems.
 * @param {string} file
 * @returns {{kind:'missing'} | {kind:'held', pid:number, key:string} | {kind:'corrupt', ageMs:number}}
 */
function readLockSnapshot(file) {
  let text;
  let mtimeMs = 0;
  try {
    const stat = fs.statSync(file);
    mtimeMs = stat.mtimeMs;
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'missing' };
    throw failure('sync_file_unreadable');
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object'
      && Number.isInteger(parsed.pid) && parsed.pid > 0
      && typeof parsed.key === 'string' && parsed.key !== '') {
      return { kind: 'held', pid: parsed.pid, key: parsed.key };
    }
  } catch {
    /* Fall through: shape or JSON problems are handled as a corrupt lock. */
  }
  return { kind: 'corrupt', ageMs: Date.now() - mtimeMs };
}

/** Tolerant content read of a moved lock file; never throws. */
function readMovedLock(junk) {
  try {
    const parsed = JSON.parse(fs.readFileSync(junk, 'utf8'));
    if (parsed && typeof parsed === 'object' && Number.isInteger(parsed.pid)
      && typeof parsed.key === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Atomically move the current lock aside and verify the moved content is still
 * the lock that was judged stale. Only a verified stale (or aged-corrupt) lock
 * is deleted, so two concurrent reclamation attempts can never destroy each
 * other's freshly created lock. When the slot changed under us the moved file
 * is restored into a free slot, or left as an orphan otherwise, and the caller
 * re-evaluates whoever holds the slot now.
 * @param {string} file
 * @param {{pid: number, key: string} | null} expected Verified payload, or
 *   null when the lock was corrupt and only its age could be judged.
 * @returns {'reclaimed'|'vanished'|'changed'}
 */
function reclaimStaleLock(file, expected) {
  const junk = `${file}.${randomUUID()}.reclaimed`;
  try {
    fs.renameSync(file, junk);
  } catch (error) {
    if (error?.code === 'ENOENT') return 'vanished';
    // A concurrent writer briefly holds the path open on Windows: re-evaluate.
    if (error?.code === 'EPERM' || error?.code === 'EBUSY' || error?.code === 'EACCES') return 'changed';
    throw failure('sync_file_unwritable');
  }
  const moved = readMovedLock(junk);
  const matches = expected
    ? Boolean(moved && moved.pid === expected.pid && moved.key === expected.key)
    : moved === null;
  if (!matches) {
    try {
      if (!fs.existsSync(file)) fs.renameSync(junk, file);
    } catch {
      /* Leave the moved file as an orphan; the live slot decides next. */
    }
    return 'changed';
  }
  try {
    fs.rmSync(junk, { force: true });
  } catch {
    /* The slot is already free; a leftover junk file is harmless. */
  }
  return 'reclaimed';
}

/**
 * Cross-process mutex. Payload `{pid, key}`; stale locks (dead pid) and locks
 * left corrupt by a crashed write (older than CORRUPT_LOCK_AGE_MS) are taken
 * over through a verified atomic rename — never through a blind unlink — and
 * release only happens when the key still matches.
 * @template T
 * @param {string} file
 * @param {() => T|Promise<T>} fn
 * @returns {Promise<T>}
 * @throws {Error} `sync_busy` | `sync_lock_invalid` | `sync_file_unreadable` | `sync_file_unwritable`.
 */
export async function withLock(file, fn) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch {
    throw failure('sync_file_unwritable');
  }
  const key = randomUUID();
  const payload = JSON.stringify({ pid: process.pid, key });
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(file, payload, { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw failure('sync_file_unwritable');
      if (attempt >= LOCK_ATTEMPTS) throw failure('sync_busy');
      const current = readLockSnapshot(file);
      if (current.kind === 'held') {
        try {
          process.kill(current.pid, 0);
        } catch (probe) {
          if (probe?.code !== 'ESRCH') throw probe;
          // Dead holder: reclaim only if the slot still holds this exact lock.
          reclaimStaleLock(file, { pid: current.pid, key: current.key });
          continue;
        }
        throw failure('sync_busy');
      }
      if (current.kind === 'corrupt') {
        if (current.ageMs >= CORRUPT_LOCK_AGE_MS) {
          // Crashed mid-write: no holder to probe, so judge by age only.
          reclaimStaleLock(file, null);
          continue;
        }
        throw failure('sync_lock_invalid');
      }
      // 'missing': the slot freed up between EEXIST and the read; retry create.
      continue;
    }
  }
  try {
    return await fn();
  } finally {
    try {
      const current = readLockSnapshot(file);
      if (current.kind === 'held' && current.key === key) fs.unlinkSync(file);
    } catch {
      /* Releasing must never mask the result of fn(). */
    }
  }
}