// Skeleton contract tests. They assert the frozen decisions and the export
// surface only; module behaviour is covered by the implementation tests that
// replace/extend this file. No test may read real Trae or Magpie credentials.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = file => readFileSync(path.join(ROOT, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const svg = readFileSync(path.join(ROOT, 'assets/trae.svg'));
const dataUri = 'data:image/svg+xml;base64,' + svg.toString('base64');

const constants = await import('../src/constants.mjs');
const { agent, connect } = await import('../trae.agent.js');

test('package identity and entry points are fixed', () => {
  assert.equal(pkg.name, 'magpie-agent-trae-intl');
  assert.equal(pkg.version, '0.1.0');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, './index.mjs');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.engines.node, '>=20');
  assert.equal(pkg.bin['magpie-trae-intl'], './cli.mjs');
  assert.equal(constants.PRODUCT.name, pkg.name);
  assert.equal(constants.PRODUCT.version, pkg.version);
});

test('magpie metadata follows the host contract and fixed decisions', () => {
  assert.equal(pkg.magpie.agent, './trae.agent.js');
  assert.equal(pkg.magpie.name, 'Trae (International)');
  assert.equal(pkg.magpie.options.port, 3499);
  assert.equal(constants.DEFAULT_PORT, 3499);
  assert.equal(constants.AGENT_ID, 'trae-intl');
  assert.equal(constants.AGENT_NAME, 'Trae (International)');
  assert.equal(constants.CONFIG_DIR_NAME, 'magpie-trae-intl');
  assert.equal(constants.LOCAL_TOKEN, 'magpie-trae-intl-local-bridge-v1');
  assert.match(constants.LOCAL_TOKEN, /^[\x21-\x7e]+$/);
  assert.equal(typeof pkg.magpie.summary.en, 'string');
  assert.equal(typeof pkg.magpie.summary.zh, 'string');
  for (const value of Object.values(pkg.magpie.summary)) assert.ok(Buffer.byteLength(value) <= 300);
});

test('icon is byte-identical in package.json, the descriptor and assets/trae.svg', () => {
  assert.equal(pkg.magpie.icon, dataUri);
  assert.equal(agent.icon, dataUri);
  assert.match(pkg.magpie.icon, /^data:image\/svg\+xml;base64,/);
});

test('descriptor is connect-only and uses the international data dirs', async () => {
  assert.equal(agent.id, constants.AGENT_ID);
  assert.equal(agent.name, constants.AGENT_NAME);
  assert.equal(agent.dir, '$APPDATA/Trae');
  assert.equal(agent.config, '~/.config/magpie-trae-intl/connection.json');
  assert.equal(agent.format, 'json');
  assert.deepEqual(agent.ua, []);
  assert.equal(Object.hasOwn(agent, 'model'), false, 'a connect-only agent must not declare model');
  assert.equal(typeof connect, 'function');
  assert.equal(agent.library.mcpFormat, 'claude');
  assert.equal(agent.library.instructions, '~/.trae/user_rules/magpie.md');
  assert.equal(agent.library.mcp, '$APPDATA/Trae/User/mcp.json');
  assert.equal(agent.library.skills, '~/.trae/skills');
  assert.deepEqual(Object.keys(await import('../trae.agent.js')).sort(), ['agent', 'connect']);
});

test('Bun entry exports exactly one plugin function', async () => {
  const namespace = await import('../index.mjs');
  assert.deepEqual(Object.keys(namespace), ['default']);
  assert.equal(typeof namespace.default, 'function');
});

test('src modules expose the documented surface', async () => {
  const expected = {
    '../src/paths.mjs': ['resolvePaths', 'resolveAppDir', 'readProduct', 'ensureConfigDir'],
    '../src/session.mjs': ['readSession', 'buildHeaders'],
    '../src/credential.mjs': ['readNativeCredentialProfile', 'encodeCredential', 'decodeCredential', 'localCredential', 'credentialMode'],
    '../src/api.mjs': ['TraeAPI', 'resolveOrigin'],
    '../src/state.mjs': ['syncPaths', 'readJson', 'writeJsonAtomic', 'withLock'],
    '../src/sync.mjs': ['syncModels', 'startModelSync', 'modelRequest'],
    '../src/bridge.mjs': ['createBridge', 'startHost', 'connectionPath'],
    '../src/client-refresh.mjs': ['installClientRefresh', 'restoreClient'],
    '../src/vendor/trae-client-codec.mjs': ['clientDecode'],
  };
  for (const [file, names] of Object.entries(expected)) {
    const namespace = await import(file);
    for (const name of names) assert.equal(typeof namespace[name], 'function', `${file} must export ${name}()`);
  }
  const bridge = await import('../src/bridge.mjs');
  assert.equal(bridge.DEFAULT_PORT, constants.DEFAULT_PORT);
  assert.equal(bridge.LOCAL_TOKEN, constants.LOCAL_TOKEN);
});

test('build allowlists are 64-char lowercase hex and fail closed by omission', async () => {
  const { MAIN_SHA256 } = await import('../src/client-refresh.mjs');
  assert.deepEqual(Object.keys(MAIN_SHA256), ['3.6.20']);
  for (const digest of Object.values(MAIN_SHA256)) assert.match(digest, /^[a-f0-9]{64}$/);
  for (const build of Object.values(constants.VERIFIED_BUILDS)) {
    assert.match(build.harness, /^[a-f0-9]{64}$/);
    assert.match(build.aiAgent, /^[a-f0-9]{64}$/);
    assert.match(build.mainJs, /^[a-f0-9]{64}$/);
  }
  assert.equal(constants.DLL_MARKERS.harnessPrefixBytes, 84);
  assert.equal(constants.DLL_MARKERS.aiAgentPrefixBytes, 94);
  assert.equal(constants.CRYPTO.nonceBytes, 12);
  assert.equal(constants.CRYPTO.tagBytes, 16);
  assert.equal(constants.CRYPTO.aadBytes, 10);
});

test('refresh notifier channel matches the client contract', () => {
  const require = createRequire(import.meta.url);
  const notifier = require('../src/refresh-notifier.cjs');
  assert.equal(typeof notifier.startNotifier, 'function');
  assert.equal(notifier.CHANNEL, constants.HOT_REFRESH.mainToRenderer);
  assert.equal(constants.HOT_REFRESH.mainToRenderer, 'vscode:main::sandbox-icubeModelManagementChange');
});

test('files whitelist publishes runtime files only', () => {
  const files = pkg.files;
  for (const required of ['trae.agent.js', 'index.mjs', 'cli.mjs', 'restore.mjs', 'src', 'assets']) {
    assert.ok(files.includes(required), `files must include ${required}`);
  }
  for (const entry of files) {
    assert.doesNotMatch(entry, /^(docs|test|tests|scripts|\.reference|\.zcode|node_modules)\//, `files must not include ${entry}`);
  }
  for (const script of ['test', 'check', 'privacy', 'pack:check']) {
    assert.equal(typeof pkg.scripts[script], 'string', `missing npm script ${script}`);
  }
});
