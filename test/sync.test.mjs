// src/sync.mjs — journal state machine against an in-memory catalog.
// Temporary config dirs only; the fake API never leaves the process.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { syncModels, startModelSync, modelRequest } from '../src/sync.mjs';
import { DEFAULT_PORT, ENV, MODEL_DEFAULTS, PROVIDER, REASONING_PARAMETER } from '../src/constants.mjs';
import { createTempDir, exists, readJson, writeJson } from './helpers/temp.mjs';
import { FakeTraeAPI, remoteEntry } from './helpers/fake-trae-api.mjs';

const ORIGIN = 'https://core-normal.trae.ai';
const ACCOUNT = 'a'.repeat(64);
const AK = 'test-only-envelope-ak';
const ENDPOINT = `http://127.0.0.1:${DEFAULT_PORT}/v1/chat/completions`;
const FIXED_NOW = '2026-01-01T00:00:00.000Z';

const MODEL_A = Object.freeze({
  id: 'model-a',
  name: 'Model A',
  context: 1000,
  output: 200,
  images: true,
  efforts: ['low', 'high'],
});
const MODEL_B = Object.freeze({
  id: 'model-b',
  name: 'Model B',
  context: 32000,
  output: 4096,
  images: false,
  efforts: [],
});

const previousMode = process.env[ENV.credentialMode];
delete process.env[ENV.credentialMode];
after(() => {
  if (previousMode === undefined) delete process.env[ENV.credentialMode];
  else process.env[ENV.credentialMode] = previousMode;
});

/** @param {readonly Record<string, unknown>[]} models */
function controlDoc(models) {
  return {
    version: 2,
    baseURL: 'http://127.0.0.1:41234/v1',
    gatewayKey: 'test-only-gateway-key',
    models,
  };
}

/**
 * @param {import('node:test').TestContext} t
 * @param {{ models?: readonly Record<string, unknown>[], remote?: Record<string, any>[], state?: unknown, account?: string, control?: boolean }} [options]
 */
function fixture(t, options = {}) {
  const dir = createTempDir(t, 'sync');
  const paths = {
    control: path.join(dir, 'connection.json'),
    state: path.join(dir, 'managed-models.json'),
    credential: path.join(dir, 'local-credential.json'),
    lock: path.join(dir, 'model-sync.lock'),
    status: path.join(dir, 'sync-status.json'),
  };
  if (options.control !== false) writeJson(paths.control, controlDoc(options.models ?? []));
  if (Object.hasOwn(options, 'state')) writeJson(paths.state, options.state);
  const api = new FakeTraeAPI({
    account: options.account ?? ACCOUNT,
    remote: options.remote ?? [],
  });
  let credentialCalls = 0;
  let apiFactoryCalls = 0;

  const run = async (overrides = {}) => syncModels({
    paths,
    apiFactory: async () => {
      apiFactoryCalls += 1;
      return api;
    },
    credentialFactory: async () => {
      credentialCalls += 1;
      return AK;
    },
    endpoint: ENDPOINT,
    port: DEFAULT_PORT,
    sleep: async () => {},
    now: () => FIXED_NOW,
    ...overrides,
  });

  return {
    dir,
    paths,
    api,
    run,
    stats: {
      get credentialCalls() {
        return credentialCalls;
      },
      get apiFactoryCalls() {
        return apiFactoryCalls;
      },
      reset() {
        credentialCalls = 0;
        apiFactoryCalls = 0;
      },
    },
  };
}

test('first sync creates every desired model and journals each creation', async (t) => {
  const f = fixture(t, { models: [MODEL_A, MODEL_B] });
  const result = await f.run();

  assert.equal(result.state, 'synced');
  assert.equal(result.models, 2);
  assert.deepEqual(result.warnings, []);
  assert.match(result.revision, /^[a-f0-9]{64}$/);
  assert.equal(result.updatedAt, FIXED_NOW);
  assert.equal(result.origin, 'core-normal.trae.ai');

  assert.equal(f.api.count('add_custom_model'), 2);
  assert.equal(f.api.count('update_custom_model'), 0);
  assert.equal(f.stats.credentialCalls, 1);

  const journal = readJson(f.paths.state);
  assert.equal(journal.version, 2);
  assert.equal(journal.account, ACCOUNT);
  assert.equal(journal.pending, null);
  assert.deepEqual(Object.keys(journal.entries), ['model-a', 'model-b']);
  for (const entry of Object.values(journal.entries)) {
    assert.equal(entry.created, true);
    assert.equal(entry.credentialFormat, 2);
    assert.equal(typeof entry.last, 'string');
    assert.equal(entry.last.length > 0, true);
  }

  const add = f.api.lastCall('add_custom_model').body;
  assert.equal(add.model_name, 'model-b');
  assert.equal(add.provider, PROVIDER);
  assert.equal(add.ak, AK);
  assert.equal(add.is_custom, true);
  assert.equal(add.auth_type, 0);
  assert.equal(add.region, '');
  assert.equal(add.sk, '');
  assert.equal(add.base_url, ENDPOINT);
  assert.equal(add.custom_model_type, '');
  assert.equal(add.display_name, 'Model B · Magpie');
  assert.equal(add.config_detail.multimodal, false);
  assert.equal(add.config_detail.max_turn, MODEL_DEFAULTS.maxTurn);

  assert.deepEqual(readJson(f.paths.status), JSON.parse(JSON.stringify(result)));
});

test('adopts an existing user configuration and updates it in place', async (t) => {
  const existing = remoteEntry({
    id: '55',
    name: 'User Existing',
    ak: 'test-only-user-ak',
    detail: { multimodal: false, model_hyper_params: { thinking_enable: 0 }, max_turn: 500 },
  });
  const f = fixture(t, { models: [MODEL_A], remote: [existing] });
  const result = await f.run();

  assert.equal(result.state, 'synced');
  assert.equal(result.models, 1);
  assert.equal(f.api.count('add_custom_model'), 0);
  assert.equal(f.api.count('update_custom_model'), 1);

  const journal = readJson(f.paths.state);
  const managed = journal.entries['model-a'];
  assert.equal(managed.id, '55');
  assert.equal(managed.created, false);
  assert.equal(managed.before.name, 'User Existing');
  assert.equal(managed.before.ak, 'test-only-user-ak');
  assert.equal(journal.pending, null);

  const update = f.api.lastCall('update_custom_model').body;
  assert.equal(update.action, 'update');
  // International wire type (verified live 2026-11-21): numeric ids only.
  assert.equal(update.id, 55);
  assert.equal(update.ak, AK);
  assert.equal(update.display_name, 'Model A · Magpie');
  assert.equal(update.config_detail.multimodal, true);
  assert.equal(update.base_url, ENDPOINT);
});

test('updates a managed model when the desired configuration changes', async (t) => {
  const f = fixture(t, { models: [MODEL_A] });
  await f.run();
  const firstJournal = readJson(f.paths.state);
  const firstLast = firstJournal.entries['model-a'].last;
  f.stats.reset();
  f.api.resetCalls();

  writeJson(f.paths.control, controlDoc([{ ...MODEL_A, context: 4096 }]));
  const result = await f.run();

  assert.equal(result.state, 'synced');
  assert.equal(f.api.count('add_custom_model'), 0);
  assert.equal(f.api.count('update_custom_model'), 1);
  const update = f.api.lastCall('update_custom_model').body;
  assert.equal(update.id, Number(firstJournal.entries['model-a'].id));
  assert.equal(update.config_detail.model_hyper_params.prompt_max_tokens, 4096);
  assert.equal(update.config_detail.model_hyper_params.max_tokens, 200);

  const journal = readJson(f.paths.state);
  assert.notEqual(journal.entries['model-a'].last, firstLast);
  assert.equal(journal.pending, null);
});

test('deletes a created model when it leaves the desired catalog', async (t) => {
  const f = fixture(t, { models: [MODEL_A] });
  await f.run();
  const created = readJson(f.paths.state).entries['model-a'];
  f.stats.reset();
  f.api.resetCalls();

  writeJson(f.paths.control, controlDoc([]));
  const result = await f.run();

  assert.equal(result.state, 'synced');
  assert.equal(result.models, 0);
  assert.equal(f.api.count('update_custom_model'), 1);
  const deleteCall = f.api.lastCall('update_custom_model').body;
  assert.deepEqual(deleteCall, { action: 'delete', id: Number(created.id) });
  assert.deepEqual(readJson(f.paths.state).entries, {});
  assert.equal(f.api.remote.length, 0);
});

test('recovers a pending add from the exact tuple without adding twice', async (t) => {
  const request = modelRequest(MODEL_A, ENDPOINT, AK);
  const remote = remoteEntry({
    id: '77',
    model: request.model_name,
    provider: request.provider,
    name: request.display_name,
    ak: request.ak,
    baseURL: request.base_url,
    detail: structuredClone(request.config_detail),
  });
  const f = fixture(t, {
    models: [MODEL_A],
    remote: [remote],
    state: {
      version: 2,
      account: ACCOUNT,
      entries: {},
      pending: { kind: 'add', model: 'model-a', request, credentialFormat: 2 },
    },
  });
  const result = await f.run();

  assert.equal(result.state, 'synced');
  assert.equal(f.api.count('add_custom_model'), 0);
  const journal = readJson(f.paths.state);
  assert.equal(journal.pending, null);
  assert.equal(journal.entries['model-a'].id, '77');
  assert.equal(journal.entries['model-a'].created, true);
  assert.equal(journal.entries['model-a'].credentialFormat, 2);
});

test('recovers a pending update by replaying it and verifying the read-back', async (t) => {
  const desired = modelRequest(MODEL_A, ENDPOINT, AK);
  const before = remoteEntry({
    id: '88',
    name: 'Before Name',
    ak: 'test-only-before-ak',
    detail: { multimodal: false, model_hyper_params: { thinking_enable: 0 }, max_turn: 500 },
  });
  const body = {
    action: 'update',
    id: '88',
    ak: desired.ak,
    provider: desired.provider,
    model_name: desired.model_name,
    status: true,
    auth_type: 0,
    region: '',
    sk: '',
    base_url: desired.base_url,
    custom_model_type: '',
    config_detail: desired.config_detail,
    display_name: desired.display_name,
  };
  const f = fixture(t, {
    models: [MODEL_A],
    remote: [before],
    state: {
      version: 2,
      account: ACCOUNT,
      entries: { 'model-a': { id: '88', created: true, last: 'stale', credentialFormat: 2 } },
      pending: { kind: 'update', model: 'model-a', before: structuredClone(before), body, credentialFormat: 2 },
    },
  });
  const result = await f.run();

  assert.equal(result.state, 'synced');
  assert.equal(f.api.count('update_custom_model'), 1);
  assert.equal(readJson(f.paths.state).pending, null);
  assert.notEqual(readJson(f.paths.state).entries['model-a'].last, 'stale');
  assert.equal(f.api.remote[0].name, desired.display_name);
});

test('refuses to replay a pending update when the user edited the entry', async (t) => {
  const before = remoteEntry({ id: '89', name: 'Before Name' });
  const edited = remoteEntry({ id: '89', name: 'User Changed' });
  const desired = modelRequest(MODEL_A, ENDPOINT, AK);
  const f = fixture(t, {
    models: [MODEL_A],
    remote: [edited],
    state: {
      version: 2,
      account: ACCOUNT,
      entries: { 'model-a': { id: '89', created: true, last: 'stale', credentialFormat: 2 } },
      pending: {
        kind: 'update',
        model: 'model-a',
        before: structuredClone(before),
        body: {
          action: 'update',
          id: '89',
          ak: desired.ak,
          provider: desired.provider,
          model_name: desired.model_name,
          status: true,
          auth_type: 0,
          region: '',
          sk: '',
          base_url: desired.base_url,
          custom_model_type: '',
          config_detail: desired.config_detail,
          display_name: desired.display_name,
        },
        credentialFormat: 2,
      },
    },
  });

  await assert.rejects(f.run(), (error) => error.code === 'trae_pending_model_edited');
  assert.equal(f.api.count('update_custom_model'), 0);
});

test('recovers a pending delete', async (t) => {
  const before = remoteEntry({ id: '66' });
  const f = fixture(t, {
    models: [],
    remote: [before],
    state: {
      version: 2,
      account: ACCOUNT,
      entries: { 'model-a': { id: '66', created: true, last: 'stale', credentialFormat: 2 } },
      pending: { kind: 'delete', model: 'model-a', before: structuredClone(before) },
    },
  });
  const result = await f.run();

  assert.equal(result.state, 'synced');
  assert.equal(result.models, 0);
  assert.equal(f.api.count('update_custom_model'), 1);
  assert.deepEqual(f.api.lastCall('update_custom_model').body, { action: 'delete', id: 66 });
  assert.deepEqual(readJson(f.paths.state).entries, {});
  assert.equal(readJson(f.paths.state).pending, null);
});

test('preserves user edits with a warning instead of overwriting or deleting', async (t) => {
  const f = fixture(t, { models: [MODEL_A] });
  await f.run();
  f.stats.reset();
  f.api.resetCalls();
  f.api.remote[0].name = 'User Renamed';

  writeJson(f.paths.control, controlDoc([]));
  const result = await f.run();

  assert.equal(result.state, 'synced');
  assert.deepEqual(result.warnings, [{ model: 'model-a', code: 'model_edited_in_trae' }]);
  assert.equal(f.api.count('update_custom_model'), 0);
  const journal = readJson(f.paths.state);
  assert.equal(journal.entries['model-a'].id, f.api.remote[0].id);
});

test('disconnect deletes models this plugin created and releases the rest', async (t) => {
  const f = fixture(t, { models: [MODEL_A] });
  await f.run();
  const created = readJson(f.paths.state).entries['model-a'];
  f.stats.reset();
  f.api.resetCalls();
  fs.rmSync(f.paths.control, { force: true });

  const result = await f.run();

  assert.equal(result.state, 'disconnected');
  assert.equal(result.models, 0);
  assert.deepEqual(result.warnings, []);
  assert.match(result.revision, /^[a-f0-9]{64}$/);
  assert.equal(f.stats.credentialCalls, 0, 'a disconnected pass must not build credentials');
  assert.equal(f.api.count('update_custom_model'), 1);
  assert.deepEqual(f.api.lastCall('update_custom_model').body, { action: 'delete', id: Number(created.id) });
  assert.deepEqual(readJson(f.paths.state).entries, {});
  assert.equal(readJson(f.paths.status).state, 'disconnected');
});

test('disconnect restores an adopted configuration instead of deleting it', async (t) => {
  const existing = remoteEntry({
    id: '55',
    name: 'User Existing',
    ak: 'test-only-user-ak',
    detail: { multimodal: false, model_hyper_params: { thinking_enable: 0 }, max_turn: 500 },
  });
  const f = fixture(t, { models: [MODEL_A], remote: [existing] });
  await f.run();
  assert.equal(f.api.remote[0].name, 'Model A · Magpie');
  f.stats.reset();
  f.api.resetCalls();
  fs.rmSync(f.paths.control, { force: true });

  const result = await f.run();

  assert.equal(result.state, 'disconnected');
  assert.equal(f.api.count('update_custom_model'), 1);
  const restore = f.api.lastCall('update_custom_model').body;
  assert.equal(restore.display_name, 'User Existing');
  assert.equal(restore.ak, 'test-only-user-ak');
  assert.equal(restore.status, true);
  assert.deepEqual(restore.config_detail, existing.detail);
  assert.deepEqual(readJson(f.paths.state).entries, {});
  assert.equal(f.api.remote.length, 1);
});

test('rejects a journal from a different account before any catalog call', async (t) => {
  const f = fixture(t, {
    models: [MODEL_A],
    state: { version: 2, account: 'b'.repeat(64), entries: {}, pending: null },
  });
  const before = fs.readFileSync(f.paths.state, 'utf8');

  await assert.rejects(f.run(), (error) => error.code === 'trae_account_changed');
  assert.equal(f.api.listCalls, 0);
  assert.equal(f.api.calls.length, 0);
  assert.equal(fs.readFileSync(f.paths.state, 'utf8'), before);
  assert.equal(exists(f.paths.status), false);
});

test('rejects an unknown journal version', async (t) => {
  const f = fixture(t, {
    models: [MODEL_A],
    state: { version: 3, account: ACCOUNT, entries: {}, pending: null },
  });
  await assert.rejects(f.run(), (error) => error.code === 'sync_state_version_unknown');
  assert.equal(f.api.listCalls, 1);
  assert.equal(exists(f.paths.status), false);
});

test('returns early without touching the API when nothing is connected or journaled', async (t) => {
  const f = fixture(t, { control: false });
  const result = await f.run();

  assert.deepEqual(result, {
    state: 'disconnected',
    models: 0,
    warnings: [],
    revision: '',
    updatedAt: FIXED_NOW,
  });
  assert.equal(f.stats.apiFactoryCalls, 0);
  assert.equal(exists(f.paths.status), false);
});

test('startModelSync records a whitelisted pending status on failure', async (t) => {
  const f = fixture(t, { models: [MODEL_A] });
  const messages = [];
  const original = console.error;
  console.error = (...args) => messages.push(args.join(' '));
  t.after(() => {
    console.error = original;
  });

  const failed = new Error('synthetic failure');
  failed.code = 'trae_account_changed';
  const sync = startModelSync({
    paths: f.paths,
    apiFactory: async () => {
      throw failed;
    },
    interval: 60_000,
    now: () => FIXED_NOW,
  });
  await sync.ready;
  await sync.stop();

  const status = readJson(f.paths.status);
  assert.deepEqual(status, { state: 'pending', code: 'trae_account_changed', updatedAt: FIXED_NOW });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /trae_account_changed/);
});

test('startModelSync falls back to trae_sync_failed for non-machine messages', async (t) => {
  const f = fixture(t, { models: [MODEL_A] });
  const original = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = original;
  });

  const sync = startModelSync({
    paths: f.paths,
    apiFactory: async () => {
      throw new Error('Unexpected Failure!');
    },
    interval: 60_000,
    now: () => FIXED_NOW,
  });
  await sync.ready;
  await sync.stop();

  assert.equal(readJson(f.paths.status).code, 'trae_sync_failed');
});

test('modelRequest builds the documented 11-field body', () => {
  const request = modelRequest(MODEL_A, ENDPOINT, AK);
  assert.deepEqual(request, {
    ak: AK,
    provider: PROVIDER,
    model_name: 'model-a',
    is_custom: true,
    auth_type: 0,
    region: '',
    sk: '',
    base_url: ENDPOINT,
    custom_model_type: '',
    config_detail: {
      multimodal: true,
      model_hyper_params: {
        thinking_enable: 1,
        prompt_max_tokens: 1000,
        max_tokens: 200,
        reasoning_param: { parameter: REASONING_PARAMETER, values: ['default', 'low', 'high'] },
      },
      max_turn: MODEL_DEFAULTS.maxTurn,
    },
    display_name: 'Model A · Magpie',
  });
  assert.equal(request.display_name.length <= MODEL_DEFAULTS.displayNameMaxLength, true);

  const minimal = modelRequest({ id: 'model-min' }, ENDPOINT, AK);
  assert.equal(minimal.display_name, 'model-min · Magpie');
  assert.deepEqual(minimal.config_detail, {
    multimodal: false,
    model_hyper_params: { thinking_enable: 0 },
    max_turn: MODEL_DEFAULTS.maxTurn,
  });
  assert.equal(Object.hasOwn(minimal.config_detail.model_hyper_params, 'prompt_max_tokens'), false);
  assert.equal(Object.hasOwn(minimal.config_detail.model_hyper_params, 'max_tokens'), false);
  assert.equal(Object.hasOwn(minimal.config_detail.model_hyper_params, 'reasoning_param'), false);

  const deduped = modelRequest(
    { id: 'model-d', efforts: ['high', 'default', 'high', 42, 'low'] },
    ENDPOINT,
    AK,
  );
  assert.deepEqual(
    deduped.config_detail.model_hyper_params.reasoning_param.values,
    ['default', 'high', 'low'],
  );

  const zeroes = modelRequest({ id: 'model-z', context: 0, output: -1 }, ENDPOINT, AK);
  assert.equal(Object.hasOwn(zeroes.config_detail.model_hyper_params, 'max_tokens'), false);
  assert.equal(Object.hasOwn(zeroes.config_detail.model_hyper_params, 'prompt_max_tokens'), false);

  const longName = modelRequest({ id: 'model-l', name: 'x'.repeat(200) }, ENDPOINT, AK);
  assert.equal(longName.display_name.length, MODEL_DEFAULTS.displayNameMaxLength);

  for (const ak of ['', null, undefined, 42]) {
    assert.throws(
      () => modelRequest(MODEL_A, ENDPOINT, ak),
      (error) => error.code === 'trae_credential_required',
      `ak ${String(ak)}`,
    );
  }
  for (const model of [null, {}, { id: '' }, { id: 42 }]) {
    assert.throws(
      () => modelRequest(model, ENDPOINT, AK),
      (error) => error.code === 'trae_model_invalid',
    );
  }
});
