// src/session.mjs — storage.json login decoding, expiry, device and host checks.
// Every storage.json here is synthetic and lives in a random os.tmpdir() folder.
// Tokens are obviously fake derivatives of fixed test strings; no real token,
// user id or device id is read.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readSession, buildHeaders } from '../src/session.mjs';
import { APP_ID, DEFAULT_REGION, IDE_VERSION_CODE_FALLBACK, LIMITS, PRODUCT } from '../src/constants.mjs';
import { createTempDir } from './helpers/temp.mjs';
import { encodeClientBlob } from './helpers/client-blob.mjs';

const AUTH_KEY = 'iCubeAuthInfo://icube.cloudide';
const NOW_SECONDS = Math.floor(Date.now() / 1000);
const FAKE_TOKEN = 'test-only-placeholder-jwt';
const PRODUCT_DESCRIPTOR = Object.freeze({ appVersion: '3.6.20' });

/** @param {Record<string, unknown>} payload @returns {string} */
function fakeJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.test-only-signature`;
}

/** @param {number} ttlSeconds @returns {string} */
function tokenExpiring(ttlSeconds = 3600) {
  return fakeJwt({ exp: NOW_SECONDS + ttlSeconds, sub: 'synthetic-subject' });
}

/**
 * @param {import('node:test').TestContext} t
 * @param {Record<string, unknown>|string} storage
 * @returns {string}
 */
function storageFile(t, storage) {
  const dir = createTempDir(t, 'session');
  const file = path.join(dir, 'storage.json');
  fs.writeFileSync(file, typeof storage === 'string' ? storage : JSON.stringify(storage));
  return file;
}

/** @param {string} token @param {Record<string, unknown>} [extra] */
function authRecord(token, extra = {}) {
  return {
    token,
    userId: 'synthetic-user-1',
    host: 'core-normal.trae.ai',
    userRegion: { region: 'US' },
    ...extra,
  };
}

/** @param {Record<string, unknown>|null} auth */
function encodedStorage(t, auth) {
  return storageFile(t, {
    [AUTH_KEY]: 'synthetic-encoded-value',
    'iCubeAuthInfo://icube-dc:1234567890': {},
    __auth: auth,
  });
}

test('reads a plaintext JSON auth blob and derives the session fields', (t) => {
  const token = tokenExpiring();
  const file = storageFile(t, {
    [AUTH_KEY]: JSON.stringify(authRecord(token, {
      host: 'https://core-normal.trae.ai',
      userRegion: { region: 'SG', _aiRegion: 'sg-ai' },
      account: { storeRegion: 'US' },
    })),
    'iCubeAuthInfo://icube-dc:9876543210': {},
    'unrelated/key': 'ignored',
  });

  const session = readSession({ storageFile: file, product: PRODUCT_DESCRIPTOR });
  assert.equal(session.account, createHash('sha256').update('synthetic-user-1').digest('hex'));
  assert.equal(session.token, token);
  assert.equal(session.userId, 'synthetic-user-1');
  assert.equal(session.deviceId, '9876543210');
  assert.equal(session.region, 'SG');
  assert.equal(session.aiRegion, 'sg-ai');
  assert.equal(session.authHost, 'core-normal.trae.ai');
  assert.equal(session.expiresAt, new Date((NOW_SECONDS + 3600) * 1000).toISOString());
  assert.equal(session.storageFile, file);
  assert.equal(session.productVersion, '3.6.20');
});

test('decodes a client-encoded blob through the injected codec', (t) => {
  const token = tokenExpiring();
  const auth = authRecord(token);
  let received = '';
  const file = encodedStorage(t, auth);
  const session = readSession({
    storageFile: file,
    product: PRODUCT_DESCRIPTOR,
    codec: {
      decode(value) {
        received = value;
        return JSON.stringify(auth);
      },
    },
  });
  assert.equal(received, 'synthetic-encoded-value');
  assert.equal(session.token, token);
  assert.equal(session.account, createHash('sha256').update('synthetic-user-1').digest('hex'));
});

test('decodes a real client-shaped blob with the vendored codec', (t) => {
  const token = tokenExpiring();
  const auth = authRecord(token, {
    host: 'https://coreva-normal.trae.ai',
    userRegion: { region: 'US', _aiRegion: 'us-ai' },
  });
  const blob = encodeClientBlob(JSON.stringify(auth), '123920200203');
  const file = storageFile(t, {
    [AUTH_KEY]: blob,
    'iCubeAuthInfo://icube-dc:2468101214': {},
  });

  const session = readSession({ storageFile: file, product: PRODUCT_DESCRIPTOR });
  assert.equal(session.token, token);
  assert.equal(session.userId, 'synthetic-user-1');
  assert.equal(session.deviceId, '2468101214');
  assert.equal(session.region, 'US');
  assert.equal(session.aiRegion, 'us-ai');
  assert.equal(session.authHost, 'coreva-normal.trae.ai');
});

test('reports codec failures and non-string codec output as trae_codec_unsupported', (t) => {
  const file = encodedStorage(t, null);
  assert.throws(
    () => readSession({ storageFile: file, product: PRODUCT_DESCRIPTOR, codec: { decode() { throw new Error('nope'); } } }),
    (error) => error.code === 'trae_codec_unsupported',
  );
  assert.throws(
    () => readSession({ storageFile: file, product: PRODUCT_DESCRIPTOR, codec: { decode() { return { auth: true }; } } }),
    (error) => error.code === 'trae_codec_unsupported',
  );
});

test('rejects an expired or unparseable token as trae_sign_in_expired', (t) => {
  const cases = [
    fakeJwt({ exp: NOW_SECONDS - 1 }),
    fakeJwt({ exp: NOW_SECONDS + Math.floor(LIMITS.connectionExpirySkewMs / 1000) - 5 }),
    fakeJwt({ exp: 'not-a-number' }),
    fakeJwt({ exp: 0 }),
    'no-dots-in-this-token',
    'header.not-json.signature',
    'header..signature',
  ];
  for (const token of cases) {
    const file = storageFile(t, {
      [AUTH_KEY]: JSON.stringify(authRecord(token)),
      'iCubeAuthInfo://icube-dc:1': {},
    });
    assert.throws(
      () => readSession({ storageFile: file, product: PRODUCT_DESCRIPTOR }),
      (error) => error.code === 'trae_sign_in_expired',
      `expected expiry for ${token.slice(0, 20)}`,
    );
  }
});

test('requires exactly one device key', (t) => {
  const auth = JSON.stringify(authRecord(tokenExpiring()));
  const cases = [
    { [AUTH_KEY]: auth },
    { [AUTH_KEY]: auth, 'iCubeAuthInfo://icube-dc:1': {}, 'iCubeAuthInfo://icube-dc:2': {} },
    { [AUTH_KEY]: auth, 'iCubeAuthInfo://icube-dc:abc': {} },
    { [AUTH_KEY]: auth, 'iCubeAuthInfo://icube-dc:': {} },
    { [AUTH_KEY]: auth, 'iCubeAuthInfo://other-dc:1': {} },
  ];
  for (const storage of cases) {
    const file = storageFile(t, storage);
    assert.throws(
      () => readSession({ storageFile: file, product: PRODUCT_DESCRIPTOR }),
      (error) => error.code === 'trae_device_unavailable',
    );
  }
});

test('accepts only https Trae hosts and normalizes them', (t) => {
  const accepted = new Map([
    ['core-normal.trae.ai', 'core-normal.trae.ai'],
    ['https://coreva-normal.trae.ai', 'coreva-normal.trae.ai'],
    ['HTTPS://CORE-NORMAL.TRAE.AI', 'core-normal.trae.ai'],
    ['https://grow-normal.trae.com', 'grow-normal.trae.com'],
    ['', ''],
    [undefined, ''],
  ]);
  for (const [host, expected] of accepted) {
    const file = storageFile(t, {
      [AUTH_KEY]: JSON.stringify(authRecord(tokenExpiring(), { host })),
      'iCubeAuthInfo://icube-dc:42': {},
    });
    const session = readSession({ storageFile: file, product: PRODUCT_DESCRIPTOR });
    assert.equal(session.authHost, expected, `host ${String(host)}`);
  }

  const rejected = [
    'http://core-normal.trae.ai',
    'https://evil.example.com',
    'https://core-normal.trae.ai.evil.example',
    'https://core-normal.trae.ai:8443',
    'https://someone:someone@example.test',
    'not a host',
    42,
    '   ',
  ];
  for (const host of rejected) {
    const file = storageFile(t, {
      [AUTH_KEY]: JSON.stringify(authRecord(tokenExpiring(), { host })),
      'iCubeAuthInfo://icube-dc:42': {},
    });
    assert.throws(
      () => readSession({ storageFile: file, product: PRODUCT_DESCRIPTOR }),
      (error) => error.code === 'trae_session_invalid',
      `host ${String(host)}`,
    );
  }
});

test('maps regions with documented fallbacks and marks unknown regions', (t) => {
  const cases = [
    [{ userRegion: { region: 'USTTP', _aiRegion: 'usttp-ai' }, account: { storeRegion: 'CN' } }, 'USTTP', 'usttp-ai'],
    [{ userRegion: 'SG', account: { storeRegion: 'US' } }, 'SG', 'US'],
    [{ userRegion: undefined, account: { storeRegion: 'CN' } }, 'CN', 'CN'],
    [{ userRegion: { region: 'XX' } }, 'UNKNOWN', 'UNKNOWN'],
    [{ userRegion: undefined }, DEFAULT_REGION, DEFAULT_REGION],
  ];
  for (const [extra, region, aiRegion] of cases) {
    const file = storageFile(t, {
      [AUTH_KEY]: JSON.stringify(authRecord(tokenExpiring(), extra)),
      'iCubeAuthInfo://icube-dc:7': {},
    });
    const session = readSession({ storageFile: file, product: PRODUCT_DESCRIPTOR });
    assert.equal(session.region, region);
    assert.equal(session.aiRegion, aiRegion);
  }
});

test('reports unreadable storage and signed-out states', (t) => {
  const dir = createTempDir(t, 'session');
  const missing = path.join(dir, 'missing.json');
  assert.throws(
    () => readSession({ storageFile: missing, product: PRODUCT_DESCRIPTOR }),
    (error) => error.code === 'trae_session_unreadable',
  );
  for (const content of ['{not json', '[]', 'null']) {
    const file = storageFile(t, content);
    assert.throws(
      () => readSession({ storageFile: file, product: PRODUCT_DESCRIPTOR }),
      (error) => error.code === 'trae_session_unreadable',
    );
  }
  for (const storage of [{}, { [AUTH_KEY]: '' }, { [AUTH_KEY]: '   ' }, { [AUTH_KEY]: 42 }]) {
    const file = storageFile(t, storage);
    assert.throws(
      () => readSession({ storageFile: file, product: PRODUCT_DESCRIPTOR }),
      (error) => error.code === 'trae_not_signed_in',
    );
  }
});

test('rejects auth blobs without token or userId', (t) => {
  const cases = [
    { userId: 'synthetic-user-1' },
    { token: '' , userId: 'synthetic-user-1' },
    { token: 42, userId: 'synthetic-user-1' },
    { token: tokenExpiring() },
    { token: tokenExpiring(), userId: '' },
    { token: tokenExpiring(), userId: null },
  ];
  for (const auth of cases) {
    const file = storageFile(t, {
      [AUTH_KEY]: JSON.stringify(auth),
      'iCubeAuthInfo://icube-dc:1': {},
    });
    assert.throws(
      () => readSession({ storageFile: file, product: PRODUCT_DESCRIPTOR }),
      (error) => error.code === 'trae_not_signed_in',
    );
  }
});

test('rejects a decodable but non-JSON auth payload as trae_session_unreadable', (t) => {
  const file = encodedStorage(t, null);
  assert.throws(
    () => readSession({ storageFile: file, product: PRODUCT_DESCRIPTOR, codec: { decode: () => 'not-json' } }),
    (error) => error.code === 'trae_session_unreadable',
  );
  for (const decoded of ['null', '[]', '42']) {
    assert.throws(
      () => readSession({ storageFile: file, product: PRODUCT_DESCRIPTOR, codec: { decode: () => decoded } }),
      (error) => error.code === 'trae_not_signed_in',
      `decoded ${decoded}`,
    );
  }
});

test('buildHeaders returns a fresh, minimal header record', () => {
  const session = {
    token: FAKE_TOKEN,
    userId: 'synthetic-user-1',
    deviceId: 'synthetic-device-1',
    region: 'SG',
    productVersion: '3.6.20',
    account: 'a'.repeat(64),
  };
  const product = {
    appVersion: '3.6.20',
    ideVersionCode: '20250101',
    agentAppId: 'test-only-app-id',
  };
  const headers = buildHeaders(session, product);

  assert.equal(headers.authorization, `Cloud-IDE-JWT ${FAKE_TOKEN}`);
  assert.equal(headers['x-ide-token'], FAKE_TOKEN);
  assert.equal(headers['x-app-id'], 'test-only-app-id');
  assert.equal(headers['x-device-id'], 'synthetic-device-1');
  assert.equal(headers['x-device-type'], 'windows');
  assert.equal(headers['x-app-version'], '3.6.20');
  assert.equal(headers['x-ide-version'], '3.6.20');
  assert.equal(headers['x-ide-version-code'], '20250101');
  assert.equal(headers['x-user-region'], 'SG');
  assert.equal(headers['x-trae-client-type'], 'ide');
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['user-agent'], `${PRODUCT.name}/${PRODUCT.version}`);

  for (const absent of ['x-uid', 'x-cloudide-token', 'cookie', 'x-forwarded-for', 'x-machine-id']) {
    assert.equal(Object.hasOwn(headers, absent), false, `${absent} must not be sent`);
  }

  const again = buildHeaders(session, product);
  assert.notEqual(headers, again);
  headers.authorization = 'mutated';
  assert.equal(session.token, FAKE_TOKEN);
  assert.equal(buildHeaders(session, product).authorization, `Cloud-IDE-JWT ${FAKE_TOKEN}`);
});

test('buildHeaders falls back to constants and session values', () => {
  const session = {
    token: FAKE_TOKEN,
    deviceId: 'synthetic-device-1',
    region: '',
    productVersion: '3.6.20',
  };
  const headers = buildHeaders(session);
  assert.equal(headers['x-app-id'], APP_ID);
  assert.equal(headers['x-ide-version-code'], IDE_VERSION_CODE_FALLBACK);
  assert.equal(headers['x-app-version'], '3.6.20');
  assert.equal(headers['x-ide-version'], '3.6.20');
  assert.equal(headers['x-user-region'], DEFAULT_REGION);
});

test('buildHeaders rejects incomplete sessions', () => {
  for (const session of [null, {}, { token: '' }, { token: FAKE_TOKEN }, { deviceId: 'x' }]) {
    assert.throws(
      () => buildHeaders(session),
      (error) => error.code === 'trae_session_invalid',
    );
  }
});
