// src/vendor/trae-client-codec.mjs — decode-only vendored client codec.
// Blobs are synthesized inside the test with the documented layout; see
// test/helpers/client-blob.mjs. No real client value, token or credential is
// read or written.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { clientDecode } from '../src/vendor/trae-client-codec.mjs';
import { SALTS, encodeClientBlob } from './helpers/client-blob.mjs';

const SALT_IDS = Object.keys(SALTS);

test('decodes a client-shaped blob for every recorded salt id', () => {
  const body = JSON.stringify({ token: 'test-only-placeholder', userId: 'synthetic-user-1' });
  for (const saltId of SALT_IDS) {
    assert.equal(clientDecode(encodeClientBlob(body, saltId)), body, `salt ${saltId}`);
  }
});

test('round-trips non-ASCII content as UTF-8', () => {
  const body = JSON.stringify({ note: '测试会话 / test session', region: 'US' });
  assert.equal(clientDecode(encodeClientBlob(body, SALT_IDS[0])), body);
});

test('two encodes of the same body differ (fresh random material)', () => {
  const body = '{"token":"test-only-placeholder"}';
  const first = encodeClientBlob(body, SALT_IDS[0]);
  const second = encodeClientBlob(body, SALT_IDS[0]);
  assert.notEqual(first, second);
  assert.equal(clientDecode(first), body);
  assert.equal(clientDecode(second), body);
});

test('rejects an unknown salt id', () => {
  const blob = encodeClientBlob('{"token":"test-only-placeholder"}', SALT_IDS[0]);
  const bytes = Buffer.from(blob, 'base64');
  // Same layout, unrecorded salt id.
  bytes.write('000000000000', 0, 'hex');
  assert.throws(() => clientDecode(bytes.toString('base64')), /not the client's codec/);
});

test('rejects a body at or below the 102-byte minimum', () => {
  const blob = encodeClientBlob('{}', SALT_IDS[0]);
  const bytes = Buffer.from(blob, 'base64');
  const short = bytes.subarray(0, 102);
  assert.throws(() => clientDecode(short.toString('base64')), /not the client's codec/);
});

test('rejects a value whose 64-byte prefix does not hash the body', () => {
  const body = '{"token":"test-only-placeholder"}';
  const wrongPrefix = createHash('sha512').update('different body').digest();
  const blob = encodeClientBlob(body, SALT_IDS[0], { prefixHash: wrongPrefix });
  assert.throws(() => clientDecode(blob), /the client's value doesn't check/);
});

test('rejects a truncated ciphertext', () => {
  const blob = encodeClientBlob('{"token":"test-only-placeholder"}', SALT_IDS[0]);
  const bytes = Buffer.from(blob, 'base64');
  assert.throws(() => clientDecode(bytes.subarray(0, bytes.length - 4).toString('base64')));
});

test('rejects a tampered ciphertext byte', () => {
  const blob = encodeClientBlob('{"token":"test-only-placeholder"}', SALT_IDS[1]);
  const bytes = Buffer.from(blob, 'base64');
  bytes[bytes.length - 5] ^= 0xff;
  assert.throws(() => clientDecode(bytes.toString('base64')));
});
