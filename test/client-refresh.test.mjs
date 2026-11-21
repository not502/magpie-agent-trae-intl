// src/client-refresh.mjs — reversible main.js loader install, per-version
// backup, idempotent reinstall and restore. Fake app trees live under os.tmpdir;
// the hash gate is injected so no real Trae build is needed.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installClientRefresh, restoreClient, MAIN_SHA256 } from '../src/client-refresh.mjs';
import { createTempDir, exists, readJson, writeJson } from './helpers/temp.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const VERSION = '3.6.20';
const SOURCE_MAP = '//# sourceMappingURL=main.js.map';

/** @param {string} value */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** @param {string} version */
function loaderFor(version) {
  return [
    `// Magpie model catalog refresh (reversible, Trae (International) ${version}).`,
    'import("./magpie-model-refresh.cjs").then(m => (m.default ?? m).startNotifier()).catch(() => {});',
    '',
  ].join('\n');
}

/**
 * @param {import('node:test').TestContext} t
 * @param {{ version?: string, main?: string }} [options]
 */
function makeApp(t, options = {}) {
  const version = options.version ?? VERSION;
  const dir = createTempDir(t, 'client-refresh');
  const appDir = path.join(dir, 'resources', 'app');
  const outDir = path.join(appDir, 'out');
  const home = path.join(dir, 'home');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  writeJson(path.join(appDir, 'product.json'), { appVersion: version, providerCode: 'i18n' });
  const main = options.main ?? `console.log("main entry");\n${SOURCE_MAP}\n`;
  const mainPath = path.join(outDir, 'main.js');
  fs.writeFileSync(mainPath, main);
  return {
    dir,
    appDir,
    home,
    outDir,
    mainPath,
    helperPath: path.join(outDir, 'magpie-model-refresh.cjs'),
    backupDir: path.join(home, '.config', 'magpie-trae-intl', 'client-backups', version),
    main,
    expectedHash: sha256(main),
    version,
  };
}

/** @param {string} original @param {number} at @param {string} loader */
function insertAtMarker(original, at, loader) {
  return original.slice(0, at) + loader + original.slice(at);
}

test('install writes a per-version backup, the helper and a reversible loader', (t) => {
  const app = makeApp(t);
  const result = installClientRefresh({
    appDir: app.appDir,
    home: app.home,
    expectedHash: app.expectedHash,
  });

  assert.equal(result.state, 'installed');
  assert.equal(result.version, VERSION);
  assert.equal(result.changed, true);
  assert.equal(typeof result.updatedAt, 'string');
  assert.equal(Number.isNaN(Date.parse(result.updatedAt)), false);

  const expectedBackup = path.join(app.backupDir, 'main.original.js');
  assert.equal(result.backup, expectedBackup);
  assert.equal(fs.readFileSync(expectedBackup, 'utf8'), app.main);
  assert.equal(fs.readFileSync(app.mainPath, 'utf8'), insertAtMarker(
    app.main,
    app.main.lastIndexOf(SOURCE_MAP),
    loaderFor(VERSION),
  ));
  assert.equal(
    fs.readFileSync(app.helperPath, 'utf8'),
    fs.readFileSync(path.join(ROOT, 'src', 'refresh-notifier.cjs'), 'utf8'),
  );

  const manifest = readJson(path.join(app.backupDir, 'manifest.json'));
  assert.equal(manifest.state, 'installed');
  assert.equal(manifest.version, VERSION);
  assert.equal(manifest.changed, true);
  assert.equal(manifest.backup, expectedBackup);
  assert.equal(manifest.updatedAt, result.updatedAt);
});

test('appends the loader when main.js has no source map marker', (t) => {
  const app = makeApp(t, { main: 'console.log("no map");\n' });
  installClientRefresh({ appDir: app.appDir, home: app.home, expectedHash: app.expectedHash });
  assert.equal(fs.readFileSync(app.mainPath, 'utf8'), app.main + loaderFor(VERSION));
});

test('a second install is byte-identical and does not replace the backup', (t) => {
  const app = makeApp(t);
  const first = installClientRefresh({ appDir: app.appDir, home: app.home, expectedHash: app.expectedHash });
  const patched = fs.readFileSync(app.mainPath, 'utf8');
  const backup = fs.readFileSync(first.backup, 'utf8');
  const helper = fs.readFileSync(app.helperPath, 'utf8');

  const second = installClientRefresh({ appDir: app.appDir, home: app.home, expectedHash: app.expectedHash });
  assert.equal(second.state, 'unchanged');
  assert.equal(second.changed, false);
  assert.equal(second.backup, first.backup);
  assert.equal(fs.readFileSync(app.mainPath, 'utf8'), patched);
  assert.equal(fs.readFileSync(first.backup, 'utf8'), backup);
  assert.equal(fs.readFileSync(app.helperPath, 'utf8'), helper);
  assert.equal(readJson(path.join(app.backupDir, 'manifest.json')).changed, false);
});

test('restore puts the original back, removes the helper and is idempotent', (t) => {
  const app = makeApp(t);
  installClientRefresh({ appDir: app.appDir, home: app.home, expectedHash: app.expectedHash });

  const restored = restoreClient({ appDir: app.appDir, home: app.home, expectedHash: app.expectedHash });
  assert.equal(restored.state, 'restored');
  assert.equal(restored.changed, true);
  assert.equal(fs.readFileSync(app.mainPath, 'utf8'), app.main);
  assert.equal(exists(app.helperPath), false);
  assert.equal(readJson(path.join(app.backupDir, 'manifest.json')).state, 'restored');

  const again = restoreClient({ appDir: app.appDir, home: app.home, expectedHash: app.expectedHash });
  assert.equal(again.state, 'unchanged');
  assert.equal(again.changed, false);
  assert.equal(fs.readFileSync(app.mainPath, 'utf8'), app.main);
  assert.equal(readJson(path.join(app.backupDir, 'manifest.json')).changed, false);
});

test('restore without a backup is a no-op, and a missing client is absent', (t) => {
  const app = makeApp(t);
  const absent = restoreClient({ appDir: app.appDir, home: app.home, expectedHash: app.expectedHash });
  assert.equal(absent.state, 'absent');
  assert.equal(absent.changed, false);
  assert.equal(absent.version, VERSION);
  assert.equal(fs.readFileSync(app.mainPath, 'utf8'), app.main);

  const missing = restoreClient({
    appDir: path.join(createTempDir(t, 'missing'), 'resources', 'app'),
    home: app.home,
    expectedHash: app.expectedHash,
  });
  assert.equal(missing.state, 'absent');
  assert.equal(missing.changed, false);
  assert.equal(missing.version, '');
});

test('refuses an unallowlisted version before writing anything', (t) => {
  const app = makeApp(t, { version: '9.9.9' });
  assert.throws(
    () => installClientRefresh({ appDir: app.appDir, home: app.home, expectedHash: app.expectedHash }),
    (error) => error.code === 'trae_client_refresh_build_unsupported',
  );
  assert.equal(fs.readFileSync(app.mainPath, 'utf8'), app.main);
  assert.equal(exists(app.backupDir), false);
  assert.equal(exists(app.helperPath), false);
});

test('refuses a hash mismatch before writing anything', (t) => {
  const app = makeApp(t);
  assert.throws(
    () => installClientRefresh({ appDir: app.appDir, home: app.home, expectedHash: 'f'.repeat(64) }),
    (error) => error.code === 'trae_client_refresh_build_unsupported',
  );
  assert.equal(fs.readFileSync(app.mainPath, 'utf8'), app.main);
  assert.equal(exists(app.backupDir), false);
  assert.equal(exists(app.helperPath), false);
});

test('refuses to overwrite a foreign main.js during restore', (t) => {
  const app = makeApp(t);
  installClientRefresh({ appDir: app.appDir, home: app.home, expectedHash: app.expectedHash });
  fs.writeFileSync(app.mainPath, 'console.log("foreign build");\n');

  assert.throws(
    () => restoreClient({ appDir: app.appDir, home: app.home, expectedHash: app.expectedHash }),
    (error) => error.code === 'trae_client_refresh_build_unsupported',
  );
  assert.equal(fs.readFileSync(app.mainPath, 'utf8'), 'console.log("foreign build");\n');
  assert.equal(exists(app.helperPath), true);
});

test('rejects a pre-existing backup that does not match the allowlist', (t) => {
  const app = makeApp(t);
  fs.mkdirSync(app.backupDir, { recursive: true });
  const foreignBackup = path.join(app.backupDir, 'main.original.js');
  fs.writeFileSync(foreignBackup, 'not the original\n');

  assert.throws(
    () => installClientRefresh({ appDir: app.appDir, home: app.home, expectedHash: app.expectedHash }),
    (error) => error.code === 'trae_client_refresh_backup_invalid',
  );
  assert.equal(fs.readFileSync(app.mainPath, 'utf8'), app.main);
  assert.equal(exists(app.helperPath), false);
});

test('dry run reports the change without touching the client or backup root', (t) => {
  const app = makeApp(t);
  const install = installClientRefresh({
    appDir: app.appDir,
    home: app.home,
    expectedHash: app.expectedHash,
    dryRun: true,
  });
  assert.equal(install.state, 'installed');
  assert.equal(install.changed, true);
  assert.equal(fs.readFileSync(app.mainPath, 'utf8'), app.main);
  assert.equal(exists(app.helperPath), false);
  assert.equal(exists(app.backupDir), false);

  installClientRefresh({ appDir: app.appDir, home: app.home, expectedHash: app.expectedHash });
  const patched = fs.readFileSync(app.mainPath, 'utf8');
  const restore = installClientRefresh({
    appDir: app.appDir,
    home: app.home,
    expectedHash: app.expectedHash,
    restore: true,
    dryRun: true,
  });
  assert.equal(restore.state, 'restored');
  assert.equal(restore.changed, true);
  assert.equal(fs.readFileSync(app.mainPath, 'utf8'), patched);
  assert.equal(exists(app.helperPath), true);
});

test('restore on an unallowlisted version reports absent without writing', (t) => {
  const app = makeApp(t, { version: '9.9.9' });
  const result = restoreClient({ appDir: app.appDir, home: app.home, expectedHash: app.expectedHash });
  assert.equal(result.state, 'absent');
  assert.equal(result.changed, false);
  assert.equal(fs.readFileSync(app.mainPath, 'utf8'), app.main);
});

test('the exported allowlist matches the constants table', () => {
  assert.deepEqual(Object.keys(MAIN_SHA256), [VERSION]);
  assert.match(MAIN_SHA256[VERSION], /^[a-f0-9]{64}$/);
});
