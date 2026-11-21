// Bun companion entry. Magpie loads this module as the package plugin.
//
// Contract: docs/design/interfaces.md §12.
// IMPORTANT: this file must export exactly one function (the default). The
// host invokes every exported function as a plugin, so helpers belong in
// other modules.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, ENV } from './src/constants.mjs';
import { startHost } from './src/bridge.mjs';
import { startModelSync } from './src/sync.mjs';
import { installClientRefresh } from './src/client-refresh.mjs';
import { ensureConfigDir, resolvePaths } from './src/paths.mjs';
import { writeJsonAtomic } from './src/state.mjs';

const INSTANCE = Symbol.for('magpie.trae-intl.bridge.v1');
const MACHINE_CODE = /^[a-z][a-z0-9_]*$/;
/**
 * Bound on how long plugin startup waits for the first successful listen.
 * `startHost` keeps retrying a busy port in the background forever (that is its
 * contract); this only stops `await ready` from hanging plugin initialization.
 */
const BRIDGE_READY_TIMEOUT_MS = 15_000;

function wait(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
}

function whitelist(error, fallback) {
  const code = error && typeof error.code === 'string' ? error.code : error && typeof error.message === 'string' ? error.message : '';
  return MACHINE_CODE.test(code) ? code : fallback;
}

function record(name, value) {
  try {
    const paths = resolvePaths();
    ensureConfigDir(paths);
    writeJsonAtomic(paths[name], value);
  } catch {
    /* Status is diagnostic; it must never affect the host. */
  }
}

function recordClientRefreshFailure(code) {
  record('clientRefreshStatus', { state: 'unsupported', code, updatedAt: new Date().toISOString() });
}

function recordSyncFailure(code) {
  record('status', { state: 'pending', code, updatedAt: new Date().toISOString() });
}

function spawnRestore(port) {
  try {
    const entry = fileURLToPath(new URL('./restore.mjs', import.meta.url));
    const child = spawn(process.execPath, [entry, String(port)], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
  } catch {
    /* The pending journal is retried by the next plugin start. */
  }
}

/**
 * @param {object} _input   OpenCode-shaped host input; unused.
 * @param {object} [options] This plugin's `plugins.json` options.
 * @param {number} [options.port=3499]
 * @param {boolean} [options.skipNativeSync] Start only the bridge (tests/diagnostics).
 * @param {boolean} [options.clientRefresh] Install the optional client hook (off by default).
 * @returns {Promise<Record<string, never>>} Always `{}`: connecting is a side effect, not an API object.
 */
export default async function TraeIntlBridge(_input, options = {}) {
  if (globalThis[INSTANCE]) return {};

  const state = { host: null, sync: null };
  globalThis[INSTANCE] = state;

  try {
    const envPort = Number(process.env[ENV.port]);
    const port =
      options.port ?? (Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535 ? envPort : DEFAULT_PORT);
    const skipNativeSync = options.skipNativeSync === true;
    const clientRefresh = options.clientRefresh === true || process.env[ENV.clientRefresh] === '1';

    if (clientRefresh) {
      try {
        installClientRefresh();
      } catch (error) {
        const code = whitelist(error, 'trae_client_refresh_install_failed');
        process.stderr.write(`magpie-trae-intl: client refresh ${code}\n`);
        recordClientRefreshFailure(code);
      }
    }

    state.host = startHost({ port });
    const bound = await Promise.race([
      state.host.ready.then(() => true),
      wait(BRIDGE_READY_TIMEOUT_MS),
    ]);
    if (!bound) {
      process.stderr.write(
        `magpie-trae-intl: the local bridge did not bind 127.0.0.1:${port} within ` +
          `${Math.round(BRIDGE_READY_TIMEOUT_MS / 1000)}s; it keeps retrying in the background.\n`,
      );
    }

    if (!skipNativeSync) {
      try {
        state.sync = startModelSync({ port });
        state.sync?.ready?.catch?.(() => {});
      } catch (error) {
        const code = whitelist(error, 'trae_sync_failed');
        process.stderr.write(`magpie-trae-intl: model sync ${code}\n`);
        recordSyncFailure(code);
      }
      process.once('exit', () => spawnRestore(port));
    }

    return {};
  } catch (error) {
    delete globalThis[INSTANCE];
    throw error;
  }
}
