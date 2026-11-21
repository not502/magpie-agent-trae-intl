'use strict';
// In-main-process refresh notifier. Owner: implementer A.
//
// Contract: docs/design/interfaces.md §10.
// Loaded by the appended dynamic import inside Trae's `out/main.js`:
//   import("./magpie-model-refresh.cjs").then(m => (m.default ?? m).startNotifier())
// It reads sync-status.json only. It must never read connection.json, tokens,
// the credential cache or chat data, and must never send model content.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

// Kept as a literal because this file is copied into Trae's ESM app tree where
// `require` of an ESM module is impossible. test/skeleton.test.mjs asserts it
// equals HOT_REFRESH.mainToRenderer.
const CHANNEL = 'vscode:main::sandbox-icubeModelManagementChange';
const WINDOW_URL_PREFIX = 'vscode-file://vscode-app/';
const INTERVAL_MS = 1000;
const REVISION = /^[a-f0-9]{64}$/;
const INSTANCE = Symbol.for('magpie.trae-intl.model-refresh.v1');
const CONFIG_DIR_NAME = 'magpie-trae-intl';

/**
 * @typedef {object} NotifierOptions
 * @property {object} [electron]       Injectable Electron module (tests).
 * @property {string} [directory]      Plugin config dir (default resolved at runtime).
 * @property {number} [interval]       Poll interval; default 1000 ms.
 * @property {string} [windowUrlPrefix] Default `vscode-file://vscode-app/`.
 */

/**
 * @typedef {object} Notifier
 * @property {() => number} tick  Send to eligible windows; returns the number sent.
 * @property {() => void} stop
 */

function resolveElectron(injected) {
  if (injected) return injected;
  try {
    return require('electron');
  } catch {
    /* Fall through: an ESM app tree may only expose Electron through execPath. */
  }
  try {
    return createRequire(process.execPath)('electron');
  } catch {
    throw Object.assign(new Error('trae_notifier_unavailable'), { code: 'trae_notifier_unavailable' });
  }
}

function writeReceipt(directory, revision, windows) {
  const file = path.join(directory, 'client-refresh-status.json');
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      temporary,
      JSON.stringify({ revision, windows, notifiedAt: new Date().toISOString() }, null, 2),
      { flag: 'wx', mode: 0o600 },
    );
    fs.renameSync(temporary, file);
  } catch {
    /* Diagnostic status never prevents a refresh. */
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /* Best effort. */
    }
  }
}

/**
 * Start the singleton notifier.
 * A window receives `{detail: {type: 'update', model: {}, openSource: 'magpie',
 * source: 'magpie', revision}}` once per revision. Send only when the window is
 * not destroyed, its URL starts with the prefix, it is not loading its main
 * frame, and its last delivered revision differs. Stop on `will-quit`.
 * @param {NotifierOptions} [options]
 * @returns {Notifier}
 * @throws {Error} `trae_notifier_unavailable` when Electron/a window API is missing.
 */
function startNotifier(options = {}) {
  if (globalThis[INSTANCE]) return globalThis[INSTANCE];

  const electron = resolveElectron(options.electron);
  if (
    !electron ||
    !electron.webContents ||
    typeof electron.webContents.getAllWebContents !== 'function' ||
    !electron.app ||
    typeof electron.app.once !== 'function'
  ) {
    throw Object.assign(new Error('trae_notifier_unavailable'), { code: 'trae_notifier_unavailable' });
  }

  const directory =
    typeof options.directory === 'string' && options.directory.length > 0
      ? options.directory
      : path.join(os.homedir(), '.config', CONFIG_DIR_NAME);
  const statusFile = path.join(directory, 'sync-status.json');
  const interval = Number.isInteger(options.interval) && options.interval > 0 ? options.interval : INTERVAL_MS;
  const prefix =
    typeof options.windowUrlPrefix === 'string' && options.windowUrlPrefix.length > 0
      ? options.windowUrlPrefix
      : WINDOW_URL_PREFIX;

  const delivered = new Map();
  let stopped = false;
  let timer = null;

  const tick = () => {
    if (stopped) return 0;
    let status;
    try {
      status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    } catch {
      return 0;
    }
    if (
      !status ||
      typeof status !== 'object' ||
      !['synced', 'disconnected'].includes(status.state) ||
      typeof status.revision !== 'string' ||
      !REVISION.test(status.revision)
    ) {
      return 0;
    }

    let windows;
    try {
      windows = electron.webContents.getAllWebContents();
    } catch {
      return 0;
    }
    if (!Array.isArray(windows)) return 0;

    const active = new Set();
    const eligible = [];
    for (const window of windows) {
      try {
        if (!window || typeof window.isDestroyed !== 'function' || window.isDestroyed()) continue;
        const id = window.id;
        if (id === undefined || id === null) continue;
        active.add(id);
        if (
          typeof window.getURL !== 'function' ||
          typeof window.send !== 'function' ||
          !String(window.getURL() || '').startsWith(prefix)
        ) {
          continue;
        }
        if (typeof window.isLoadingMainFrame === 'function' && window.isLoadingMainFrame()) continue;
        eligible.push(window);
      } catch {
        /* A window closing mid-iteration is simply skipped. */
      }
    }
    for (const id of delivered.keys()) {
      if (!active.has(id)) delivered.delete(id);
    }

    let sent = 0;
    for (const window of eligible) {
      if (delivered.get(window.id) === status.revision) continue;
      try {
        window.send(CHANNEL, {
          detail: {
            type: 'update',
            model: {},
            openSource: 'magpie',
            source: 'magpie',
            revision: status.revision,
          },
        });
        delivered.set(window.id, status.revision);
        sent++;
      } catch {
        /* A closing window is retried on the next tick if it still exists. */
      }
    }
    if (sent > 0) writeReceipt(directory, status.revision, sent);
    return sent;
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (globalThis[INSTANCE] === instance) delete globalThis[INSTANCE];
  };

  const instance = { tick, stop };
  globalThis[INSTANCE] = instance;

  timer = setInterval(tick, interval);
  timer.unref?.();
  try {
    electron.app.once('will-quit', stop);
  } catch {
    /* Stopping is best effort; the process is exiting anyway. */
  }
  tick();
  return instance;
}

module.exports = { startNotifier, CHANNEL };
