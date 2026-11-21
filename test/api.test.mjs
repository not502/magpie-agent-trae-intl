// src/api.mjs — request URLs, bodies, normalization and error codes.
// Transport is always an injected fake; no test here opens a socket to Trae.

import test from 'node:test';
import assert from 'node:assert/strict';
import { TraeAPI, resolveOrigin } from '../src/api.mjs';
import {
  API_PREFIX,
  APP_ID,
  BATCH_DEFAULTS,
  DEFAULT_REGION,
  DEVICE_TYPE,
  IDE_VERSION_CODE_FALLBACK,
  PROVIDER,
  TRAE_HOSTS,
} from '../src/constants.mjs';

const ORIGIN = 'https://core-normal.trae.ai';
const TOKEN = 'test-only-placeholder-token';
const SESSION = Object.freeze({
  token: TOKEN,
  userId: 'synthetic-user-1',
  deviceId: 'synthetic-device-1',
  region: 'US',
  account: 'a'.repeat(64),
  productVersion: '3.6.20',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});
const PRODUCT = Object.freeze({
  appVersion: '3.6.20',
  ideVersionCode: '20250101',
  agentAppId: 'test-only-app-id',
});
const ENDPOINT = 'http://127.0.0.1:3499/v1/chat/completions';

/** @param {{status?: number, body?: unknown, ok?: boolean, raw?: string}} [options] */
function response(options = {}) {
  const status = options.status ?? 200;
  const raw = options.raw ?? JSON.stringify(options.body ?? { code: 0 });
  return {
    status,
    ok: options.ok ?? (status >= 200 && status < 300),
    async json() {
      return JSON.parse(raw);
    },
  };
}

/**
 * @param {{responses?: unknown[], httpGet?: Function}} [options]
 */
function transport(options = {}) {
  const calls = [];
  const queue = [...(options.responses ?? [])];
  const request = async (url, init) => {
    calls.push({ url, init });
    if (!queue.length) throw new Error('no fake response queued');
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, request, httpGet: options.httpGet };
}

function api(overrides = {}) {
  return new TraeAPI(SESSION, {
    origin: ORIGIN,
    product: PRODUCT,
    request: async () => response({ body: { code: 0 } }),
    ...overrides,
  });
}

/** A representative `batch_get_detail_param` payload (object-keyed form). */
function batchPayload() {
  return {
    code: 0,
    data: {
      function_configs: {
        chat: {
          config_info_list: [{
            config_name: 'Group Chat',
            display_config: { display_name: 'Friendly Name', multimodal: true },
            model_detail_list: [{
              model_name: 'model-a',
              provider: PROVIDER,
              max_tokens: 4096,
              prompt_max_tokens: 128000,
              max_turn: 120,
              custom_config: {
                custom_model_id: 321,
                ak: 'test-only-envelope-a',
                sk: '',
                base_url: ENDPOINT,
                status: true,
                auth_type: 0,
                config_source: 3,
                custom_model_type: 'chat_model',
                client_connect: false,
                thinking_enable: 1,
                reasoning_param: { parameter: 'reasoning_effort', values: ['default', 'high'] },
              },
            }],
          }],
        },
        builder: {
          config_info_list: [{
            config_name: 'Builder',
            model_detail_list: [{
              model_name: 'model-a-duplicate',
              custom_config: JSON.stringify({ custom_model_id: 321, status: false }),
            }],
          }],
        },
        other: {
          config_info_list: [{
            config_name: 'Raw',
            model_detail_list: [{
              custom_model_id: 777,
              model_name: 'model-raw',
              custom_config: '{not-json',
            }],
          }],
        },
      },
    },
  };
}

test('batch list posts the fixed body, headers and normalizes entries', async () => {
  const fake = transport({ responses: [response({ body: batchPayload() })] });
  const client = api({ request: fake.request });
  const entries = await client.list();

  assert.equal(fake.calls.length, 1);
  const [call] = fake.calls;
  assert.equal(call.url, `${ORIGIN}${API_PREFIX}/batch_get_detail_param`);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.redirect, 'error');
  assert.equal(call.init.signal instanceof AbortSignal, true);
  const body = JSON.parse(call.init.body);
  assert.deepEqual(body, {
    functions: [...BATCH_DEFAULTS.functions],
    access_type: 0,
    ab_force_vids: BATCH_DEFAULTS.ab_force_vids,
    ab_autotest_advanced_mode: BATCH_DEFAULTS.ab_autotest_advanced_mode,
    agent_type: '',
    current_config_info: { config_name: '', is_custom_model: false },
    mode_type: 0,
    show_custom_model: true,
  });
  // Verified live (2026-11-21): the international endpoint rejects `Request`.
  assert.equal(Object.hasOwn(body, 'Request'), false);

  assert.equal(call.init.headers.authorization, `Cloud-IDE-JWT ${TOKEN}`);
  assert.equal(call.init.headers['x-ide-token'], TOKEN);
  assert.equal(call.init.headers['x-app-id'], 'test-only-app-id');
  assert.equal(call.init.headers['x-device-id'], 'synthetic-device-1');
  assert.equal(call.init.headers['x-device-type'], DEVICE_TYPE);
  assert.equal(call.init.headers['x-app-version'], '3.6.20');
  assert.equal(call.init.headers['x-ide-version-code'], '20250101');
  assert.equal(call.init.headers['x-user-region'], 'US');
  assert.equal(call.init.headers['x-trae-client-type'], 'ide');
  assert.equal(Object.hasOwn(call.init.headers, 'x-uid'), false);
  assert.equal(Object.hasOwn(call.init.headers, 'x-cloudide-token'), false);

  assert.equal(entries.length, 2);
  const [first, raw] = entries;
  assert.equal(first.id, '321');
  assert.equal(first.model, 'model-a');
  assert.equal(first.provider, PROVIDER);
  assert.equal(first.name, 'Friendly Name');
  assert.equal(first.ak, 'test-only-envelope-a');
  assert.equal(first.sk, '');
  assert.equal(first.baseURL, ENDPOINT);
  assert.equal(first.status, true);
  assert.equal(first.authType, 0);
  assert.equal(first.configSource, 3);
  assert.equal(first.customModelType, 'chat_model');
  assert.deepEqual(first.config, {
    custom_model_id: 321,
    ak: 'test-only-envelope-a',
    sk: '',
    base_url: ENDPOINT,
    status: true,
    auth_type: 0,
    config_source: 3,
    custom_model_type: 'chat_model',
    client_connect: false,
    thinking_enable: 1,
    reasoning_param: { parameter: 'reasoning_effort', values: ['default', 'high'] },
  });
  assert.deepEqual(first.detail, {
    multimodal: true,
    model_hyper_params: {
      max_tokens: 4096,
      prompt_max_tokens: 128000,
      thinking_enable: 1,
      reasoning_param: { parameter: 'reasoning_effort', values: ['default', 'high'] },
    },
    max_turn: 120,
  });

  assert.equal(raw.id, '777');
  assert.deepEqual(raw.config, {});
  assert.deepEqual(raw.raw, { custom_config: '{not-json' });
});

test('batch parsing also accepts an array of function groups', () => {
  const client = api();
  const entries = client.parseBatch({
    data: {
      function_configs: [
        { function: 'chat', config_info_list: [{
          config_name: 'Chat',
          model_detail_list: [{ custom_model_id: 5, model_name: 'model-5' }],
        }] },
        { name: 'builder', config_info_list: [{
          config_name: 'Builder',
          model_detail_list: [{ custom_model_id: 6, model_name: 'model-6' }],
        }] },
      ],
    },
  });
  assert.deepEqual(entries.map((entry) => entry.id), ['5', '6']);
  assert.deepEqual(entries.map((entry) => entry.model), ['model-5', 'model-6']);
});

test('batch parsing rejects payloads without function_configs', async () => {
  const fake = transport({ responses: [response({ body: { code: 0, data: {} } })] });
  await assert.rejects(api({ request: fake.request }).list(), (error) => error.code === 'trae_catalog_unknown');
});

test('batch parsing surfaces group error codes as trae_catalog_<code>', () => {
  const client = api();
  assert.throws(
    () => client.parseBatch({ function_configs: [{ function: 'chat', error_code: 'E_AUTH' }] }),
    (error) => error.code === 'trae_catalog_e_auth',
  );
  assert.throws(
    () => client.parseBatch({ function_configs: { chat: { error_code: 42 } } }),
    (error) => error.code === 'trae_catalog_42',
  );
});

test('batch parsing deduplicates by id, first entry wins', () => {
  const entries = api().parseBatch(batchPayload());
  const duplicate = entries.filter((entry) => entry.id === '321');
  assert.equal(duplicate.length, 1);
  assert.equal(duplicate[0].model, 'model-a');
});

test('envelope:false, custom functions and a custom product are honored', async () => {
  const fake = transport({ responses: [response({ body: { code: 0, function_configs: {} } })] });
  const client = new TraeAPI(
    { ...SESSION, productVersion: '9.9.9' },
    {
      origin: ORIGIN,
      request: fake.request,
      envelope: false,
      functions: ['chat'],
      idType: 'number',
    },
  );
  await client.list();
  const body = JSON.parse(fake.calls[0].init.body);
  assert.deepEqual(body.functions, ['chat']);
  assert.equal(Object.hasOwn(body, 'Request'), false);
  assert.equal(fake.calls[0].init.headers['x-app-id'], APP_ID);
  assert.equal(fake.calls[0].init.headers['x-ide-version-code'], IDE_VERSION_CODE_FALLBACK);
  assert.equal(fake.calls[0].init.headers['x-app-version'], '9.9.9');
});

test('model_list strategy uses GET-with-body and normalizes flat entries', async () => {
  const payload = {
    code: 0,
    data: {
      model_list: [
        {
          custom_model_id: 12,
          model_name: 'model-12',
          name: 'fallback-name',
          display_name: 'Display 12',
          provider: PROVIDER,
          ak: 'test-only-envelope-b',
          sk: '',
          base_url: ENDPOINT,
          status: true,
          auth_type: 0,
          config_source: 3,
          custom_model_type: 'chat_model',
          client_connect: true,
          multimodal: true,
          max_tokens: 100,
          prompt_max_tokens: 200,
          thinking_enable: 1,
          reasoning_param: { parameter: 'reasoning_effort', values: ['default', 'low'] },
          max_turn: 9,
          custom_config: JSON.stringify({ custom_model_id: 12, extra: 'kept' }),
        },
        { custom_model_id: 12, model_name: 'duplicate' },
      ],
    },
  };
  const getCalls = [];
  const client = api({
    catalog: 'model_list',
    httpGet: async (url, options) => {
      getCalls.push({ url, options });
      return { status: 200, text: JSON.stringify(payload) };
    },
  });
  const entries = await client.list();

  assert.equal(getCalls.length, 1);
  assert.equal(getCalls[0].url, `${ORIGIN}${API_PREFIX}/model_list?type=`);
  assert.equal(getCalls[0].options.body, JSON.stringify({ Request: {} }));
  assert.equal(getCalls[0].options.headers.authorization, `Cloud-IDE-JWT ${TOKEN}`);
  assert.equal(getCalls[0].options.timeoutMs, 15_000);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, '12');
  assert.equal(entries[0].model, 'model-12');
  assert.equal(entries[0].name, 'Display 12');
  assert.equal(entries[0].ak, 'test-only-envelope-b');
  assert.equal(entries[0].clientConnect, true);
  assert.deepEqual(entries[0].config, { custom_model_id: 12, extra: 'kept' });
  assert.deepEqual(entries[0].detail, {
    multimodal: true,
    model_hyper_params: {
      max_tokens: 100,
      prompt_max_tokens: 200,
      thinking_enable: 1,
      reasoning_param: { parameter: 'reasoning_effort', values: ['default', 'low'] },
    },
    max_turn: 9,
  });
});

test('model_list strategy maps transport failures to machine codes', async () => {
  const cases = [
    [{ status: 500, text: '{}' }, 'trae_api_500'],
    [{ status: 200, text: 'not-json' }, 'trae_response_200'],
    [{ status: 200, text: JSON.stringify({ code: 7 }) }, 'trae_api_7'],
    [{ status: 401, text: JSON.stringify({ code: 401 }) }, 'trae_api_401'],
  ];
  for (const [reply, code] of cases) {
    const client = api({ catalog: 'model_list', httpGet: async () => reply });
    await assert.rejects(client.list(), (error) => error.code === code, code);
  }
});

test('auto falls back to model_list only for trae_catalog_unknown', async () => {
  const batchUnknown = transport({ responses: [response({ body: { code: 0, data: {} } })] });
  let getCalls = 0;
  const fallback = api({
    catalog: 'auto',
    request: batchUnknown.request,
    httpGet: async () => {
      getCalls += 1;
      return { status: 200, text: JSON.stringify({ code: 0, data: { model_list: [{ custom_model_id: 1 }] } }) };
    },
  });
  const entries = await fallback.list();
  assert.equal(entries.length, 1);
  assert.equal(getCalls, 1);

  const authFailure = transport({ responses: [response({ status: 401, body: { code: 401 } })] });
  const noFallback = api({
    catalog: 'auto',
    request: authFailure.request,
    httpGet: async () => {
      getCalls += 1;
      return { status: 200, text: '{}' };
    },
  });
  await assert.rejects(noFallback.list(), (error) => error.code === 'trae_api_401');
  assert.equal(getCalls, 1);
});

test('add posts the ModelRequest and encodes an empty SK without mutating the caller', async () => {
  const fake = transport({ responses: [response({ body: { code: 0, message: 'ok' } })] });
  const client = api({ request: fake.request, encodeEmptySecret: () => 'test-only-empty-envelope' });
  const request = {
    ak: 'test-only-envelope-a',
    provider: PROVIDER,
    model_name: 'model-a',
    is_custom: true,
    auth_type: 0,
    region: '',
    sk: '',
    base_url: ENDPOINT,
    custom_model_type: '',
    config_detail: { multimodal: true, model_hyper_params: {}, max_turn: 500 },
    display_name: 'Model A · Magpie',
  };
  const ack = await client.add(request);

  assert.deepEqual(ack, { code: 0, message: 'ok' });
  assert.equal(fake.calls[0].url, `${ORIGIN}${API_PREFIX}/add_custom_model`);
  assert.equal(fake.calls[0].init.method, 'POST');
  const body = JSON.parse(fake.calls[0].init.body);
  assert.deepEqual({ ...body, sk: '' }, request);
  assert.equal(body.sk, 'test-only-empty-envelope');
  assert.equal(request.sk, '', 'caller object must not be mutated');

  const bare = transport({ responses: [response({ body: { code: 0 } })] });
  assert.deepEqual(await api({ request: bare.request }).add(request), { code: 0 });
  await assert.rejects(api({ request: fake.request }).add('nope'), (error) => error.code === 'trae_model_invalid');
});

test('update posts action=update, honors idType and encodes an empty SK', async () => {
  const fake = transport({
    responses: [
      response({ body: { code: 0 } }),
      response({ body: { code: 0 } }),
    ],
  });
  const client = api({ request: fake.request, encodeEmptySecret: () => 'test-only-empty-envelope' });
  const body = {
    id: '42',
    provider: PROVIDER,
    model_name: 'model-a',
    status: true,
    auth_type: 0,
    sk: '',
    region: '',
    base_url: ENDPOINT,
    custom_model_type: '',
    config_detail: { multimodal: false, model_hyper_params: {}, max_turn: 500 },
    display_name: 'Model A · Magpie',
  };
  await client.update(body);
  const sent = JSON.parse(fake.calls[0].init.body);
  assert.equal(fake.calls[0].url, `${ORIGIN}${API_PREFIX}/update_custom_model`);
  assert.equal(sent.action, 'update');
  // International wire type (verified live 2026-11-21): numeric ids only.
  assert.equal(sent.id, 42);
  assert.equal(sent.sk, 'test-only-empty-envelope');
  assert.equal(Object.hasOwn(body, 'action'), false);

  const legacy = api({
    request: fake.request,
    encodeEmptySecret: () => 'test-only-empty-envelope',
    idType: 'string',
  });
  await legacy.update(body);
  assert.equal(JSON.parse(fake.calls[1].init.body).id, '42');

  for (const id of ['', null, undefined, '42.5', 'abc', -1]) {
    await assert.rejects(
      client.update({ ...body, id }),
      (error) => error.code === 'trae_model_id_invalid',
      `id ${String(id)}`,
    );
  }
  await assert.rejects(api().update(null), (error) => error.code === 'trae_model_invalid');
});

test('remove posts exactly action=delete and the numeric id', async () => {
  const fake = transport({ responses: [response({ body: { code: 0, message: 'deleted' } })] });
  const client = api({ request: fake.request, encodeEmptySecret: () => 'should-not-be-used' });
  const ack = await client.remove({ id: '321' });
  assert.deepEqual(ack, { code: 0, message: 'deleted' });
  assert.equal(fake.calls[0].url, `${ORIGIN}${API_PREFIX}/update_custom_model`);
  const body = JSON.parse(fake.calls[0].init.body);
  assert.deepEqual(Object.keys(body).sort(), ['action', 'id']);
  assert.deepEqual(body, { action: 'delete', id: 321 });

  for (const entry of [null, {}, { id: '' }, { id: null }]) {
    await assert.rejects(client.remove(entry), (error) => error.code === 'trae_model_id_invalid');
  }
});

test('call rejects unsupported methods before touching the transport', async () => {
  const fake = transport({ responses: [] });
  await assert.rejects(
    api({ request: fake.request }).call('model_list', {}),
    (error) => error.code === 'unsupported_trae_operation',
  );
  assert.equal(fake.calls.length, 0);
});

test('call maps business and HTTP failures to trae_api_<code|status>', async () => {
  const cases = [
    [response({ status: 200, body: { code: 123, message: 'nope' } }), 'trae_api_123'],
    [response({ status: 500, body: {} }), 'trae_api_500'],
    [response({ status: 403, body: { code: 1001 } }), 'trae_api_1001'],
    [response({ status: 200, body: { code: 'BAD CODE' } }), 'trae_api_bad_code'],
  ];
  for (const [reply, code] of cases) {
    const fake = transport({ responses: [reply] });
    await assert.rejects(
      api({ request: fake.request }).call('add_custom_model', { ok: true }),
      (error) => error.code === code,
      code,
    );
  }

  const broken = transport({
    responses: [{
      status: 200,
      ok: true,
      async json() {
        throw new SyntaxError('not json');
      },
    }],
  });
  await assert.rejects(
    api({ request: broken.request }).call('add_custom_model', {}),
    (error) => error.code === 'trae_response_200',
  );
});

test('call returns the raw parsed object on code 0', async () => {
  const fake = transport({ responses: [response({ body: { code: 0, data: { kept: true } } })] });
  const result = await api({ request: fake.request }).call('add_custom_model', {});
  assert.deepEqual(result, { code: 0, data: { kept: true } });
});

test('resolveOrigin selects the region host and validates overrides', () => {
  assert.equal(resolveOrigin({ session: { region: 'SG' } }), `https://${TRAE_HOSTS.agent.SG}`);
  assert.equal(resolveOrigin({ session: { region: 'US' } }), `https://${TRAE_HOSTS.agent.US}`);
  assert.equal(resolveOrigin({ session: { region: 'USTTP' } }), `https://${TRAE_HOSTS.agent.USTTP}`);
  assert.equal(resolveOrigin({ session: { region: 'CN' } }), `https://${TRAE_HOSTS.agent.normal}`);
  assert.equal(resolveOrigin({ session: { region: 'XX' } }), `https://${TRAE_HOSTS.agent.normal}`);
  assert.equal(resolveOrigin(), `https://${TRAE_HOSTS.agent[DEFAULT_REGION]}`);

  assert.equal(resolveOrigin({ override: 'https://example.test:8443/' }), 'https://example.test:8443');
  assert.equal(resolveOrigin({ override: 'http://127.0.0.1:3499' }), 'http://127.0.0.1:3499');
  assert.equal(resolveOrigin({ override: 'http://localhost:3499/v1' }), 'http://localhost:3499');

  for (const override of [
    'http://example.test',
    'https://user:test-only-userinfo@example.test',
    'https://example.test?query=1',
    'https://example.test#fragment',
    'not a url',
  ]) {
    assert.throws(() => resolveOrigin({ override }), (error) => error.code === 'trae_origin_invalid', override);
  }

  assert.throws(
    () => resolveOrigin({ product: { hosts: { agent: {} } } }),
    (error) => error.code === 'trae_origin_unavailable',
  );
});
