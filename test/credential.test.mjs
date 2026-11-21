// src/credential.mjs — profile extraction from synthetic DLL buffers, AES-GCM
// envelope round-trips, cache reuse, self-check failure and plaintext mode.
// All key material is synthesized in a random os.tmpdir() folder; nothing here
// reads the installed Trae DLLs or any real credential.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  credentialMode,
  decodeCredential,
  encodeCredential,
  localCredential,
  readNativeCredentialProfile,
} from '../src/credential.mjs';
import { CRYPTO, ENV, LOCAL_TOKEN } from '../src/constants.mjs';
import { createTempDir, exists, readJson, writeJson } from './helpers/temp.mjs';
import {
  AI_AGENT_MARKER,
  AI_SALT_HEX,
  AAD,
  HARNESS_MARKER,
  KEY_HEX,
  SALT_HEX,
  dllBytes,
  keyMaterial,
  sha256Hex,
} from './helpers/dll.mjs';

const VERSION = '9.9.9';

/**
 * @param {import('node:test').TestContext} t
 * @param {{ harnessPrefix?: string, aiAgentPrefix?: string, harness?: Buffer, aiAgent?: Buffer, writeHarness?: boolean, writeAiAgent?: boolean, version?: string }} [options]
 */
function fakeInstall(t, options = {}) {
  const material = keyMaterial({
    keyHex: options.keyHex,
    saltHex: options.saltHex,
    aiSaltHex: options.aiSaltHex,
  });
  const harnessPrefix = options.harnessPrefix ?? material.harnessPrefix;
  const aiAgentPrefix = options.aiAgentPrefix ?? material.aiAgentPrefix;
  const harness = options.harness ?? dllBytes(harnessPrefix, HARNESS_MARKER, {
    before: 'harness-prelude',
    after: 'harness-epilogue',
  });
  const aiAgent = options.aiAgent ?? dllBytes(aiAgentPrefix, AI_AGENT_MARKER, {
    before: 'ai-agent-prelude',
    after: 'ai-agent-epilogue',
  });
  const version = options.version ?? VERSION;
  const dir = createTempDir(t, 'credential');
  const appDir = path.join(dir, 'app');
  const moduleDir = path.join(appDir, 'modules', 'ai-agent');
  fs.mkdirSync(moduleDir, { recursive: true });
  writeJson(path.join(appDir, 'product.json'), { appVersion: version, providerCode: 'i18n' });
  if (options.writeHarness !== false) fs.writeFileSync(path.join(moduleDir, 'harness.dll'), harness);
  if (options.writeAiAgent !== false) fs.writeFileSync(path.join(moduleDir, 'ai_agent.dll'), aiAgent);
  const builds = { [version]: { harness: sha256Hex(harness), aiAgent: sha256Hex(aiAgent) } };
  return { dir, appDir, harness, aiAgent, builds, harnessPrefix, aiAgentPrefix };
}

/** Expected profile key: harness key bytes with the first 8 XORed with the salt. */
function expectedKey() {
  const key = Buffer.from(KEY_HEX, 'hex');
  const salt = Buffer.from(SALT_HEX, 'hex');
  for (let index = 0; index < CRYPTO.keyXorBytes; index++) key[index] ^= salt[index];
  return key;
}

/** @param {string} code */
function throwsCode(code) {
  return (error) => {
    assert.equal(error.code, code);
    return true;
  };
}

test('derives the AES-256-GCM profile from synthetic DLLs and caches it', (t) => {
  const install = fakeInstall(t);
  const profile = readNativeCredentialProfile({ appDir: install.appDir, builds: install.builds });

  assert.equal(profile.version, VERSION);
  assert.equal(profile.id, `trae-intl-${VERSION}:${install.builds[VERSION].harness}`);
  assert.equal(profile.identity, `${VERSION}|${[
    path.join(install.appDir, 'modules', 'ai-agent', 'harness.dll'),
    path.join(install.appDir, 'modules', 'ai-agent', 'ai_agent.dll'),
  ].map((file) => {
    const stat = fs.statSync(file);
    return `${file}:${stat.size}:${stat.mtimeMs}`;
  }).join('|')}`);
  assert.equal(Buffer.isBuffer(profile.key), true);
  assert.equal(profile.key.length, CRYPTO.keyBytes);
  assert.deepEqual(profile.key, expectedKey());
  assert.equal(Buffer.isBuffer(profile.aad), true);
  assert.equal(profile.aad.toString('ascii'), AAD);
  assert.equal(profile.aad.length, CRYPTO.aadBytes);
  assert.equal(profile.harnessSha256, install.builds[VERSION].harness);
  assert.equal(profile.aiAgentSha256, install.builds[VERSION].aiAgent);
  assert.equal(Object.isFrozen(profile), true);

  // The in-memory cache is keyed by version + file size/mtime.
  assert.equal(readNativeCredentialProfile({ appDir: install.appDir, builds: install.builds }), profile);
});

test('finds a marker and its 84-byte prefix across the 1 MiB scan boundary', (t) => {
  const material = keyMaterial();
  const chunk = 1024 * 1024;
  const before = 'p'.repeat(chunk - 10 - material.harnessPrefix.length);
  const harness = dllBytes(material.harnessPrefix, HARNESS_MARKER, { before });
  const install = fakeInstall(t, { harness });
  const profile = readNativeCredentialProfile({ appDir: install.appDir, builds: install.builds });
  assert.deepEqual(profile.key, expectedKey());
  assert.equal(profile.aad.toString('ascii'), AAD);
});

test('rejects builds outside the allowlist or with mismatched digests', (t) => {
  const install = fakeInstall(t);
  assert.throws(
    () => readNativeCredentialProfile({ appDir: install.appDir, builds: {} }),
    throwsCode('trae_credential_version_unsupported'),
  );
  assert.throws(
    () => readNativeCredentialProfile({
      appDir: install.appDir,
      builds: { [VERSION]: { harness: 'f'.repeat(64), aiAgent: install.builds[VERSION].aiAgent } },
    }),
    throwsCode('trae_credential_build_unsupported'),
  );
  assert.throws(
    () => readNativeCredentialProfile({ appDir: install.appDir, builds: { [VERSION]: { harness: '', aiAgent: '' } } }),
    throwsCode('trae_credential_build_unsupported'),
  );
});

test('reports a missing installation or DLL as trae_installation_unavailable', (t) => {
  const install = fakeInstall(t, { writeHarness: false });
  assert.throws(
    () => readNativeCredentialProfile({ appDir: install.appDir, builds: install.builds }),
    throwsCode('trae_installation_unavailable'),
  );
});

test('rejects duplicated or prefix-less markers as trae_credential_profile_unknown', (t) => {
  const material = keyMaterial();
  const duplicate = dllBytes(material.harnessPrefix, HARNESS_MARKER, { repeat: 2 });
  const duplicated = fakeInstall(t, { harness: duplicate });
  assert.throws(
    () => readNativeCredentialProfile({ appDir: duplicated.appDir, builds: duplicated.builds }),
    throwsCode('trae_credential_profile_unknown'),
  );

  const early = dllBytes('short', HARNESS_MARKER, { before: 'x' });
  const prefixLess = fakeInstall(t, { harness: early });
  assert.throws(
    () => readNativeCredentialProfile({ appDir: prefixLess.appDir, builds: prefixLess.builds }),
    throwsCode('trae_credential_profile_unknown'),
  );
});

test('rejects malformed prefixes and cross-file invariant violations', (t) => {
  const nonHex = fakeInstall(t, { harnessPrefix: 'z'.repeat(84) });
  assert.throws(
    () => readNativeCredentialProfile({ appDir: nonHex.appDir, builds: nonHex.builds }),
    throwsCode('trae_credential_profile_unknown'),
  );

  const mismatched = fakeInstall(t, {
    harnessPrefix: `${'a'.repeat(64)}${SALT_HEX}`,
    aiAgentPrefix: `${'d'.repeat(64)}${AAD}${AI_SALT_HEX}`,
  });
  assert.throws(
    () => readNativeCredentialProfile({ appDir: mismatched.appDir, builds: mismatched.builds }),
    throwsCode('trae_credential_profile_unknown'),
  );

  const badAiSalt = fakeInstall(t, {
    harnessPrefix: `${'a'.repeat(64)}${SALT_HEX}`,
    aiAgentPrefix: `${'a'.repeat(64)}${AAD}${'x'.repeat(20)}`,
  });
  assert.throws(
    () => readNativeCredentialProfile({ appDir: badAiSalt.appDir, builds: badAiSalt.builds }),
    throwsCode('trae_credential_profile_unknown'),
  );
});

test('AES-GCM envelope round-trips and rejects malformed input', (t) => {
  const install = fakeInstall(t);
  const profile = readNativeCredentialProfile({ appDir: install.appDir, builds: install.builds });
  const value = 'test-only-placeholder';

  const first = encodeCredential(value, profile);
  const second = encodeCredential(value, profile);
  assert.notEqual(first, second);
  assert.equal(decodeCredential(first, profile), value);
  assert.equal(decodeCredential(second, profile), value);

  const nonce = Buffer.alloc(CRYPTO.nonceBytes, 7);
  const deterministic = encodeCredential(value, profile, nonce);
  assert.equal(decodeCredential(deterministic, profile), value);
  assert.equal(decodeCredential(encodeCredential(value, profile, nonce), profile), value);

  const empty = encodeCredential('', profile);
  assert.equal(Buffer.from(empty, 'base64').length, CRYPTO.nonceBytes + CRYPTO.tagBytes);
  assert.equal(empty.length, CRYPTO.emptyEnvelopeBase64Chars);
  assert.equal(decodeCredential(empty, profile), '');

  assert.throws(() => encodeCredential(42, profile), throwsCode('trae_credential_input_invalid'));
  assert.throws(() => encodeCredential('', { ...profile, key: Buffer.alloc(31, 1) }), throwsCode('trae_credential_input_invalid'));
  assert.throws(() => encodeCredential('', profile, Buffer.alloc(11, 1)), throwsCode('trae_credential_input_invalid'));
  assert.throws(() => encodeCredential('', profile, 'not-a-buffer'), throwsCode('trae_credential_input_invalid'));

  for (const bad of ['', 'not-base64!!', Buffer.alloc(10, 1).toString('base64'), `${first}\n`]) {
    assert.throws(() => decodeCredential(bad, profile), throwsCode('trae_credential_invalid'));
  }

  const bytes = Buffer.from(first, 'base64');
  bytes[bytes.length - 1] ^= 0xff;
  assert.throws(() => decodeCredential(bytes.toString('base64'), profile), throwsCode('trae_credential_invalid'));
  assert.throws(
    () => decodeCredential(first, { ...profile, key: Buffer.alloc(32, 9) }),
    throwsCode('trae_credential_invalid'),
  );
  assert.throws(() => decodeCredential(first, { key: Buffer.alloc(31), aad: Buffer.alloc(10) }), throwsCode('trae_credential_invalid'));
});

test('decode errors never echo the input value', (t) => {
  const install = fakeInstall(t);
  const profile = readNativeCredentialProfile({ appDir: install.appDir, builds: install.builds });
  const value = 'test-only-placeholder';
  const envelope = encodeCredential(value, profile);
  const bytes = Buffer.from(envelope, 'base64');
  bytes[bytes.length - 3] ^= 0x01;
  const tampered = bytes.toString('base64');
  try {
    decodeCredential(tampered, profile);
    assert.fail('expected decodeCredential to throw');
  } catch (error) {
    assert.equal(error.code, 'trae_credential_invalid');
    assert.equal(error.message, 'trae_credential_invalid');
    assert.equal(error.message.includes(value), false);
    assert.equal(error.message.includes(tampered.slice(0, 8)), false);
  }
});

test('localCredential writes, reuses and repairs the native cache', (t) => {
  const install = fakeInstall(t);
  const profile = readNativeCredentialProfile({ appDir: install.appDir, builds: install.builds });
  const file = path.join(createTempDir(t, 'credential-cache'), 'local-credential.json');

  const first = localCredential(file, { profile, mode: 'native' });
  assert.equal(decodeCredential(first, profile), LOCAL_TOKEN);
  const cached = readJson(file);
  assert.equal(cached.version, CRYPTO.cacheVersion);
  assert.equal(cached.mode, 'native');
  assert.equal(cached.profile, profile.id);
  assert.equal(cached.ak, first);

  assert.equal(localCredential(file, { profile, mode: 'native' }), first);

  // A stale envelope is regenerated, not trusted.
  const stale = Buffer.alloc(CRYPTO.nonceBytes + CRYPTO.tagBytes, 3).toString('base64');
  writeJson(file, { version: CRYPTO.cacheVersion, mode: 'native', profile: profile.id, ak: stale });
  const repaired = localCredential(file, { profile, mode: 'native' });
  assert.notEqual(repaired, stale);
  assert.equal(decodeCredential(repaired, profile), LOCAL_TOKEN);
  assert.equal(readJson(file).ak, repaired);

  // A cache from another profile is regenerated too.
  writeJson(file, { version: CRYPTO.cacheVersion, mode: 'native', profile: 'other-profile', ak: first });
  assert.equal(decodeCredential(localCredential(file, { profile, mode: 'native' }), profile), LOCAL_TOKEN);
  assert.equal(readJson(file).profile, profile.id);
});

test('localCredential reports an unreadable cache and unusable profiles', (t) => {
  const install = fakeInstall(t);
  const profile = readNativeCredentialProfile({ appDir: install.appDir, builds: install.builds });
  const dir = createTempDir(t, 'credential-cache');
  const file = path.join(dir, 'local-credential.json');

  fs.writeFileSync(file, '{not json');
  assert.throws(() => localCredential(file, { profile, mode: 'native' }), throwsCode('trae_credential_cache_unreadable'));

  assert.throws(
    () => localCredential(file, { profile: { key: Buffer.alloc(31), aad: Buffer.alloc(10) }, mode: 'native' }),
    throwsCode('trae_credential_unavailable'),
  );
  assert.throws(() => localCredential(file, { profile, mode: 'weird' }), throwsCode('trae_credential_mode_invalid'));
});

test('localCredential fails closed when the self-check cannot verify the envelope', (t) => {
  const file = path.join(createTempDir(t, 'credential-cache'), 'local-credential.json');
  const key = Buffer.alloc(CRYPTO.keyBytes, 7);
  const aads = [Buffer.from('0123456789', 'ascii'), Buffer.from('9876543210', 'ascii')];
  let reads = 0;
  const profile = {
    id: 'test-only-profile',
    get key() {
      return key;
    },
    get aad() {
      // The pre-check and the whole encode pass see the first AAD; the
      // self-check decode pass sees a rotated AAD, so GCM authentication fails.
      reads += 1;
      return reads <= 3 ? aads[0] : aads[1];
    },
  };
  assert.throws(() => localCredential(file, { profile, mode: 'native' }));
  assert.equal(exists(file), false, 'a failed self-check must not write the cache');
});

test('localCredential reports a failed self-check with the documented code', (t) => {
  const file = path.join(createTempDir(t, 'credential-cache'), 'local-credential.json');
  const key = Buffer.alloc(CRYPTO.keyBytes, 7);
  const aads = [Buffer.from('0123456789', 'ascii'), Buffer.from('9876543210', 'ascii')];
  let reads = 0;
  const profile = {
    id: 'test-only-profile',
    get key() {
      return key;
    },
    get aad() {
      reads += 1;
      return reads <= 3 ? aads[0] : aads[1];
    },
  };
  assert.throws(
    () => localCredential(file, { profile, mode: 'native' }),
    throwsCode('trae_credential_self_check_failed'),
  );
});

test('plaintext mode returns the public marker and never writes a cache', (t) => {
  const dir = createTempDir(t, 'credential-cache');
  const file = path.join(dir, 'local-credential.json');
  assert.equal(localCredential(file, { mode: 'plaintext' }), LOCAL_TOKEN);
  assert.equal(exists(file), false);

  const install = fakeInstall(t);
  const profile = readNativeCredentialProfile({ appDir: install.appDir, builds: install.builds });
  assert.equal(localCredential(file, { profile, mode: 'plaintext' }), LOCAL_TOKEN);
  assert.equal(exists(file), false);
});

test('credentialMode reads and validates the environment', (t) => {
  const previous = process.env[ENV.credentialMode];
  t.after(() => {
    if (previous === undefined) delete process.env[ENV.credentialMode];
    else process.env[ENV.credentialMode] = previous;
  });

  delete process.env[ENV.credentialMode];
  assert.equal(credentialMode(), 'native');
  process.env[ENV.credentialMode] = '';
  assert.equal(credentialMode(), 'native');
  process.env[ENV.credentialMode] = 'native';
  assert.equal(credentialMode(), 'native');
  process.env[ENV.credentialMode] = 'plaintext';
  assert.equal(credentialMode(), 'plaintext');
  process.env[ENV.credentialMode] = 'bogus';
  assert.throws(() => credentialMode(), throwsCode('trae_credential_mode_invalid'));
});
