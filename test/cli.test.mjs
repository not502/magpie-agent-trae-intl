// cli.mjs — exit codes and output for `status` and `models` when the bridge is
// unavailable, plus the live contract on a loopback bridge. A free ephemeral
// port is obtained per test; no fixed port is shared.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBridge } from '../src/bridge.mjs';
import { BRIDGE_NAME, ENV, LOCAL_TOKEN } from '../src/constants.mjs';
import { createTempDir, writeJson } from './helpers/temp.mjs';
import { closeServer, listen } from './helpers/http.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLI = path.join(ROOT, 'cli.mjs');

/**
 * @param {string[]} args
 * @param {{env?: Record<string, string|undefined>, timeoutMs?: number}} [options]
 */
function runCli(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...(options.env ?? {}) },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, options.timeoutMs ?? 15_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
  });
}

/** Reserve and immediately release a loopback port for the CLI to dial. */
async function freePort() {
  const server = net.createServer();
  await listen(server);
  const { port } = server.address();
  await closeServer(server);
  return port;
}

/**
 * @param {import('node:test').TestContext} t
 * @param {Record<string, unknown>} connection
 */
async function liveBridge(t, connection) {
  const dir = createTempDir(t, 'cli-bridge');
  const file = path.join(dir, 'connection.json');
  writeJson(file, connection);
  const bridge = createBridge({ file, port: 0 });
  const address = await bridge.listen();
  t.after(() => bridge.close());
  return { file, port: address.port };
}

/** @param {Record<string, unknown>[]} models */
function connection(models) {
  return {
    version: 2,
    baseURL: 'http://127.0.0.1:1/v1',
    gatewayKey: 'test-only-gateway-key',
    models,
  };
}

/** @param {Record<string, unknown>} result */
function assertNoSecrets(result) {
  for (const text of [result.stdout, result.stderr]) {
    assert.equal(text.includes('test-only-gateway-key'), false);
    assert.equal(text.includes(LOCAL_TOKEN), false);
  }
}

test('status exits 1 and explains the bridge is not answering', async (t) => {
  const port = await freePort();
  const home = createTempDir(t, 'cli-home');
  const result = await runCli(['status', '--port', String(port)], {
    env: { USERPROFILE: home, HOME: home },
  });
  assert.equal(result.timedOut, false);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, new RegExp(`127\\.0\\.0\\.1:${port} is not answering`));
  assertNoSecrets(result);
});

test('models exits 1 and explains the bridge is not answering', async (t) => {
  const port = await freePort();
  const home = createTempDir(t, 'cli-home');
  const result = await runCli(['models', '--port', String(port)], {
    env: { USERPROFILE: home, HOME: home },
  });
  assert.equal(result.timedOut, false);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, new RegExp(`127\\.0\\.0\\.1:${port} is not answering`));
  assertNoSecrets(result);
});

test('status prints the redacted health document from a live bridge', async (t) => {
  const bridge = await liveBridge(t, connection([{ id: 'model-a', name: 'Model A' }]));
  const home = createTempDir(t, 'cli-home');
  const result = await runCli(['status', '--port', String(bridge.port)], {
    env: { USERPROFILE: home, HOME: home },
  });

  assert.equal(result.timedOut, false);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  const health = JSON.parse(result.stdout);
  assert.equal(health.name, BRIDGE_NAME);
  assert.equal(health.connected, true);
  assert.equal(health.credential.mode, 'native');
  assert.equal(Object.hasOwn(health, 'models'), false);
  assertNoSecrets(result);
});

test('models prints the catalog array from a live bridge', async (t) => {
  const bridge = await liveBridge(t, connection([
    { id: 'model-a', name: 'Model A', context: 128000 },
    { id: 'model-b' },
  ]));
  const home = createTempDir(t, 'cli-home');
  const result = await runCli(['models', '--port', String(bridge.port)], {
    env: { USERPROFILE: home, HOME: home },
  });

  assert.equal(result.timedOut, false);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  const models = JSON.parse(result.stdout);
  assert.equal(Array.isArray(models), true);
  assert.deepEqual(models.map((model) => model.id), ['model-a', 'model-b']);
  assert.equal(models[0].name, 'Model A');
  assert.equal(models[1].name, 'model-b');
  assert.equal(Object.hasOwn(models[0], 'ak'), false);
  assertNoSecrets(result);
});

test('status rejects a server that answers with a different identity', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: 'not-the-bridge', ok: true }));
  });
  await listen(server);
  t.after(() => closeServer(server));
  const home = createTempDir(t, 'cli-home');
  const result = await runCli(['status', '--port', String(server.address().port)], {
    env: { USERPROFILE: home, HOME: home },
  });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /not answering/);
});

test('rejects an invalid port before contacting anything', async () => {
  for (const port of ['0', '65536', 'not-a-number']) {
    const result = await runCli(['status', '--port', port]);
    assert.equal(result.code, 1, port);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /invalid port/);
  }
});

test('prints usage for --help and unknown commands', async () => {
  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: magpie-trae-intl/);
  assert.equal(help.stderr, '');

  const unknown = await runCli(['no-such-command']);
  assert.equal(unknown.code, 1);
  assert.equal(unknown.stdout, '');
  assert.match(unknown.stderr, /Usage: magpie-trae-intl/);
});
