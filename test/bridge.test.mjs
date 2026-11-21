// src/bridge.mjs — loopback admission, auth, model whitelist, streaming relay,
// idle timeout and client disconnect. Every upstream is a local fake server on
// an ephemeral port; each bridge listens on its own port (never a fixed one).

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createBridge, connectionPath, startHost } from '../src/bridge.mjs';
import { BRIDGE_NAME, ENV, LOCAL_TOKEN, PRODUCT } from '../src/constants.mjs';
import { createTempDir, exists, writeJson } from './helpers/temp.mjs';
import { bodyOf, closeServer, delay, listen, request } from './helpers/http.mjs';

const MODELS = Object.freeze([
  Object.freeze({
    id: 'model-a',
    name: 'Model A',
    context: 128000,
    output: 16000,
    images: true,
    efforts: ['low', 'high'],
  }),
  Object.freeze({ id: 'model-b' }),
]);
const GATEWAY_KEY = 'test-only-gateway-key';
const AUTH = Object.freeze({ authorization: `Bearer ${LOCAL_TOKEN}` });

/**
 * @param {import('node:test').TestContext} t
 * @param {{ handler?: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void, models?: readonly Record<string, unknown>[], maxBodyBytes?: number, upstreamTimeoutMs?: number, exposeModels?: boolean, gatewayKey?: string, baseURL?: string }} [options]
 */
async function fixture(t, options = {}) {
  const dir = createTempDir(t, 'bridge');
  const file = path.join(dir, 'connection.json');
  const upstreamRequests = [];
  const upstream = http.createServer((req, res) => {
    const record = { method: req.method, url: req.url, headers: req.headers, body: null };
    upstreamRequests.push(record);
    if (options.handler) {
      options.handler(req, res, record);
      return;
    }
    bodyOf(req).then((body) => {
      record.body = body.toString('utf8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await listen(upstream);
  const upstreamPort = upstream.address().port;

  const base = options.baseURL ?? `http://127.0.0.1:${upstreamPort}/v1`;
  writeJson(file, {
    version: 2,
    baseURL: base,
    gatewayKey: options.gatewayKey ?? GATEWAY_KEY,
    models: options.models ?? MODELS,
  });

  const bridge = createBridge({
    file,
    port: 0,
    maxBodyBytes: options.maxBodyBytes,
    upstreamTimeoutMs: options.upstreamTimeoutMs,
    exposeModels: options.exposeModels,
  });
  const address = await bridge.listen();
  t.after(async () => {
    await bridge.close();
    await closeServer(upstream);
  });

  return {
    dir,
    file,
    bridge,
    port: address.port,
    upstream,
    upstreamRequests,
    upstreamPort,
  };
}

/** @param {any} response */
function errorOf(response) {
  const body = response.json();
  assert.equal(body.error.type, 'magpie_trae_error');
  assert.equal(typeof body.error.message, 'string');
  return body.error.message;
}

test('health is redacted, reports the bridge contract and caps sync warnings', async (t) => {
  const f = await fixture(t);
  const first = await request(f.port);
  assert.equal(first.status, 200);
  const health = first.json();
  assert.equal(health.name, BRIDGE_NAME);
  assert.equal(health.version, PRODUCT.version);
  assert.equal(health.connected, true);
  assert.deepEqual(health.sync, { state: 'pending', code: 'sync_status_unavailable' });
  assert.deepEqual(health.credential, { mode: 'native' });
  assert.equal(health.requests, 0);
  assert.equal(health.lastRequest, null);
  assert.equal(health.received, 0);
  assert.equal(health.lastInbound, null);
  assert.equal(health.rejected, 0);
  assert.equal(health.lastRejection, null);
  assert.equal(Object.hasOwn(health, 'models'), false);
  for (const secret of [GATEWAY_KEY, 'baseURL', 'model-a', 'model-b']) {
    assert.equal(first.text.includes(secret), false, `${secret} must not appear in /health`);
  }

  writeJson(path.join(f.dir, 'sync-status.json'), {
    state: 'synced',
    models: 2,
    code: 'SYNC FAILED!',
    revision: 'not-a-revision',
    updatedAt: 42,
    warnings: [
      { model: 'model-a', code: 'model_edited_in_trae' },
      { model: 5, code: 'x' },
      { model: 'm', code: 'c', extra: 'dropped' },
    ],
    gatewayKey: GATEWAY_KEY,
    extra: 'never exposed',
  });
  const second = await request(f.port);
  const sync = second.json().sync;
  assert.deepEqual(sync, {
    state: 'synced',
    models: 2,
    warnings: [
      { model: 'model-a', code: 'model_edited_in_trae' },
      { model: 'm', code: 'c' },
    ],
  });
  assert.equal(second.text.includes(GATEWAY_KEY), false);
  assert.equal(second.text.includes('never exposed'), false);
});

test('health can expose the model list only when explicitly enabled', async (t) => {
  const f = await fixture(t, { exposeModels: true });
  const health = (await request(f.port)).json();
  assert.deepEqual(health.models, [
    { id: 'model-a', name: 'Model A' },
    { id: 'model-b', name: 'model-b' },
  ]);
});

test('health reports the credential mode from the environment', async (t) => {
  const previous = process.env[ENV.credentialMode];
  process.env[ENV.credentialMode] = 'plaintext';
  t.after(() => {
    if (previous === undefined) delete process.env[ENV.credentialMode];
    else process.env[ENV.credentialMode] = previous;
  });
  const f = await fixture(t);
  assert.deepEqual((await request(f.port)).json().credential, { mode: 'plaintext' });
});

test('rejects missing and wrong bearer markers and records the rejection', async (t) => {
  const f = await fixture(t);
  const missing = await request(f.port, {
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'model-a', messages: [] }),
  });
  assert.equal(missing.status, 401);
  errorOf(missing);
  assert.equal(missing.text.includes(GATEWAY_KEY), false);

  const wrong = await request(f.port, {
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { authorization: 'Bearer test-only-wrong', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'model-a', messages: [] }),
  });
  assert.equal(wrong.status, 401);
  errorOf(wrong);

  const models = await request(f.port, { path: '/v1/models' });
  assert.equal(models.status, 401);

  assert.equal(f.upstreamRequests.length, 0);
  const health = (await request(f.port)).json();
  assert.equal(health.rejected, 3);
  assert.equal(health.lastRejection.status, 401);
  assert.equal(health.lastRejection.code, 'local_auth_invalid');
  assert.equal(health.received, 3);
  assert.equal(health.lastInbound.method, 'GET');
  assert.equal(health.lastInbound.route, '/v1/models');
  assert.equal(health.lastInbound.status, 401);
});

test('serves /v1/models from connection.json for an authorized caller', async (t) => {
  const f = await fixture(t);
  const response = await request(f.port, { path: '/v1/models', headers: AUTH });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), {
    object: 'list',
    data: [
      {
        id: 'model-a',
        object: 'model',
        owned_by: 'magpie',
        name: 'Model A',
        images: true,
        efforts: ['low', 'high'],
        context_length: 128000,
        max_output_tokens: 16000,
      },
      {
        id: 'model-b',
        object: 'model',
        owned_by: 'magpie',
        name: 'model-b',
        images: false,
        efforts: [],
      },
    ],
  });
});

test('rejects models outside the connection whitelist before contacting upstream', async (t) => {
  const f = await fixture(t);
  const unknown = await request(f.port, {
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'not-in-list', messages: [] }),
  });
  assert.equal(unknown.status, 404);
  errorOf(unknown);

  for (const body of [
    { messages: [] },
    { model: '', messages: [] },
    { model: 5, messages: [] },
    { model: 'model-a', messages: 'not-an-array' },
    [],
  ]) {
    const response = await request(f.port, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400, JSON.stringify(body));
  }

  const malformed = await request(f.port, {
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(malformed.status, 400);
  assert.equal(f.upstreamRequests.length, 0);
});

test('relays a streaming response byte-for-byte and forwards the expected upstream headers', async (t) => {
  const sse = 'data: {"delta":"hello"}\n\ndata: [DONE]\n\n';
  const f = await fixture(t, {
    handler(req, res, record) {
      bodyOf(req).then((body) => {
        record.body = body.toString('utf8');
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'retry-after': '3',
          'x-internal': 'must-not-be-copied',
        });
        res.write('data: {"delta":"hello"}\n\n');
        setTimeout(() => res.end('data: [DONE]\n\n'), 10);
      });
    },
  });

  const payload = {
    model: 'model-a',
    stream: true,
    reasoning_effort: 'high',
    tools: [{ type: 'function', function: { name: 'lookup' } }],
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,test-only' } },
      ],
    }],
  };
  const response = await request(f.port, {
    method: 'POST',
    path: '/v1/chat/completions',
    headers: {
      ...AUTH,
      'content-type': 'application/json',
      'x-magpie-conversation': 'conv-1',
    },
    body: JSON.stringify(payload),
  });

  assert.equal(response.status, 200);
  assert.equal(response.text, sse);
  assert.equal(response.headers['content-type'], 'text/event-stream');
  assert.equal(response.headers['retry-after'], '3');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-accel-buffering'], 'no');
  assert.equal(response.headers['x-internal'], undefined);

  assert.equal(f.upstreamRequests.length, 1);
  const upstream = f.upstreamRequests[0];
  assert.equal(upstream.method, 'POST');
  assert.equal(upstream.url, '/v1/chat/completions');
  assert.equal(upstream.headers.authorization, `Bearer ${GATEWAY_KEY}`);
  assert.equal(upstream.headers['content-type'], 'application/json');
  assert.equal(upstream.headers.accept, 'text/event-stream');
  assert.equal(upstream.headers['x-magpie-conversation'], 'conv-1');
  assert.equal(upstream.headers['user-agent'], `${PRODUCT.name}/${PRODUCT.version}`);
  assert.deepEqual(JSON.parse(upstream.body), payload);

  const health = (await request(f.port)).json();
  assert.equal(health.requests, 1);
  assert.equal(health.lastRequest.model, 'model-a');
  assert.equal(health.lastRequest.status, 200);
  assert.equal(health.lastRequest.stream, true);
  assert.equal(health.lastRequest.tools, 1);
  assert.equal(health.lastRequest.images, 1);
  assert.equal(health.lastRequest.reasoningEffort, 'high');
  assert.equal(Number.isInteger(health.lastRequest.durationMs), true);
});

test('passes upstream status, body and retry-after through for non-streaming calls', async (t) => {
  const upstreamBody = '{"error":{"message":"rate limited"}}';
  const f = await fixture(t, {
    handler(req, res) {
      bodyOf(req).then(() => {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '9' });
        res.end(upstreamBody);
      });
    },
  });
  const response = await request(f.port, {
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(response.status, 429);
  assert.equal(response.text, upstreamBody);
  assert.equal(response.headers['retry-after'], '9');
  assert.equal(f.upstreamRequests[0].headers.accept, 'application/json');
});

test('does not forward an invalid conversation header', async (t) => {
  const f = await fixture(t);
  const response = await request(f.port, {
    method: 'POST',
    path: '/v1/chat/completions',
    headers: {
      ...AUTH,
      'content-type': 'application/json',
      'x-magpie-conversation': 'bad value!',
    },
    body: JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(response.status, 200);
  assert.equal(Object.hasOwn(f.upstreamRequests[0].headers, 'x-magpie-conversation'), false);
});

test('returns 502 with a generic message when the upstream stays idle', async (t) => {
  const f = await fixture(t, {
    upstreamTimeoutMs: 80,
    handler(req) {
      req.resume();
      /* Never respond. */
    },
  });
  const response = await request(f.port, {
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(response.status, 502);
  errorOf(response);
  assert.equal(response.text.includes(GATEWAY_KEY), false);
  assert.equal(f.upstreamRequests.length, 1);
});

test('destroys the upstream request when the client disconnects', async (t) => {
  let seen;
  let closed;
  const upstreamSeen = new Promise((resolve) => {
    seen = resolve;
  });
  const upstreamClosed = new Promise((resolve) => {
    closed = resolve;
  });
  const f = await fixture(t, {
    handler(req, res) {
      req.resume();
      seen();
      res.on('close', closed);
    },
  });

  const client = http.request({
    host: '127.0.0.1',
    port: f.port,
    method: 'POST',
    path: '/v1/chat/completions',
    headers: {
      ...AUTH,
      'content-type': 'application/json',
      connection: 'close',
    },
    agent: false,
  });
  client.on('error', () => {
    /* Expected: the client socket is destroyed below. */
  });
  client.end(JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: 'hi' }] }));

  await upstreamSeen;
  client.destroy();
  await Promise.race([
    upstreamClosed,
    delay(3000).then(() => {
      assert.fail('the bridge kept the upstream request open after the client disconnected');
    }),
  ]);
});

test('enforces the local-only admission rules', async (t) => {
  const f = await fixture(t);

  const origin = await request(f.port, { headers: { origin: 'http://example.test' } });
  assert.equal(origin.status, 403);
  errorOf(origin);

  const host = await request(f.port, { headers: { host: 'example.test:1234' }, path: '/v1/models' });
  assert.equal(host.status, 403);

  const put = await request(f.port, {
    method: 'PUT',
    path: '/v1/chat/completions',
    headers: AUTH,
  });
  assert.equal(put.status, 405);

  const postModels = await request(f.port, {
    method: 'POST',
    path: '/v1/models',
    headers: AUTH,
  });
  assert.equal(postModels.status, 405);

  const unknown = await request(f.port, { path: '/v1/unknown', headers: AUTH });
  assert.equal(unknown.status, 404);

  const root = await request(f.port, { path: '/', headers: AUTH });
  assert.equal(root.status, 404);
  assert.equal(f.upstreamRequests.length, 0);
});

test('returns 503 when connection.json violates the host contract', async (t) => {
  const f = await fixture(t);
  writeJson(f.file, {
    version: 1,
    baseURL: 'http://127.0.0.1:1/v1',
    gatewayKey: GATEWAY_KEY,
    models: MODELS,
  });
  const badVersion = await request(f.port, { path: '/v1/models', headers: AUTH });
  assert.equal(badVersion.status, 503);
  errorOf(badVersion);
  assert.equal(exists(path.join(f.dir, 'sync-status.json')), false);

  writeJson(f.file, {
    version: 2,
    baseURL: 'http://127.0.0.1:1/v1',
    gatewayKey: 'key with spaces',
    models: MODELS,
  });
  assert.equal((await request(f.port, { path: '/v1/models', headers: AUTH })).status, 503);

  writeJson(f.file, {
    version: 2,
    baseURL: 'http://example.test/v1',
    gatewayKey: GATEWAY_KEY,
    models: MODELS,
  });
  assert.equal((await request(f.port, { path: '/v1/models', headers: AUTH })).status, 503);

  writeJson(f.file, {
    version: 2,
    baseURL: `http://127.0.0.1:${f.port}/v1`,
    gatewayKey: GATEWAY_KEY,
    models: MODELS,
  });
  assert.equal((await request(f.port, { path: '/v1/models', headers: AUTH })).status, 503);
});

test('rejects oversized bodies with 413 and truncates at maxBodyBytes', async (t) => {
  const f = await fixture(t, { maxBodyBytes: 16 });
  const body = JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: 'x'.repeat(64) }] });
  const response = await request(f.port, {
    method: 'POST',
    path: '/v1/chat/completions',
    headers: {
      ...AUTH,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    },
    body,
  });
  assert.equal(response.status, 413);
  errorOf(response);
  assert.equal(f.upstreamRequests.length, 0);
});

test('connectionPath derives the documented config location', (t) => {
  const home = createTempDir(t, 'home');
  assert.equal(
    connectionPath(home),
    path.join(home, '.config', 'magpie-trae-intl', 'connection.json'),
  );
});

test('startHost rejects an invalid port', () => {
  for (const port of [0, -1, 65536, 1.5, '3499']) {
    assert.throws(() => startHost({ port }), (error) => error.code === 'trae_bridge_port_invalid');
  }
});
