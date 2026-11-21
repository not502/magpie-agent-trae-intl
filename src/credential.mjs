// Native credential envelope for the loopback marker. Owner: implementer B.
//
// Contract: docs/design/interfaces.md §4.
// Key material is derived at runtime from the installed client's DLLs, lives
// only in memory, and is never written to disk, logs, fixtures or tests.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import {
  CLIENT_LAYOUT,
  CRYPTO,
  DLL_MARKERS,
  ENV,
  LOCAL_TOKEN,
  VERIFIED_BUILDS,
} from './constants.mjs';
import { readProduct, resolveAppDir } from './paths.mjs';

const HARNESS_SHAPE = /^[0-9a-f]{84}$/;
const AI_AGENT_SHAPE = /^[0-9a-f]{64}[0-9]{10}[0-9a-f]{20}$/;
const SCAN_CHUNK_BYTES = 1024 * 1024;

/** In-memory profile cache, keyed by version + file size/mtime identity. */
let cachedProfile = null;

/**
 * @typedef {object} CredentialProfile
 * @property {string} id              Stable cache key, e.g. `trae-intl-<version>:<harnessSha256>`.
 * @property {string} identity        Cache key for the in-memory profile (version + file size/mtime).
 * @property {string} version         Trae `appVersion` the profile was derived from.
 * @property {Buffer} key             32-byte AES-256-GCM key.
 * @property {Buffer} aad             10-byte ASCII AAD.
 * @property {string} harnessSha256   Measured harness.dll digest (allowlisted).
 * @property {string} aiAgentSha256   Measured ai_agent.dll digest (allowlisted).
 */

/**
 * @typedef {object} ProfileOptions
 * @property {string} [appDir]   `<install>/resources/app`; discovered when omitted.
 * @property {string} [local]    `%LOCALAPPDATA%`-style root (tests).
 * @property {Readonly<Record<string, {harness: string, aiAgent: string}>>} [builds]
 *   Allowlist override for tests; production must use VERIFIED_BUILDS.
 */

/** @param {string} code @returns {Error} */
function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/** @param {unknown} value @returns {value is string} */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Scan a file once: hash the whole stream and locate exactly the marker prefix.
 * Uses bounded memory (1 MiB chunks) and accepts only candidates whose
 * `prefixBytes` bytes are fully available in the sliding window. No fixed file
 * offsets are used.
 * @param {string} file
 * @param {string} marker
 * @param {number} prefixBytes
 * @returns {{prefix: Buffer, digest: string}}
 */
function inspect(file, marker, prefixBytes) {
  const markerBytes = Buffer.from(marker, 'ascii');
  const tailBytes = prefixBytes + markerBytes.length;
  const chunk = Buffer.alloc(SCAN_CHUNK_BYTES);
  const hash = createHash('sha256');
  const candidates = [];
  let tail = Buffer.alloc(0);
  let total = 0;
  let handle;
  try {
    handle = fs.openSync(file, 'r');
  } catch {
    throw failure('trae_installation_unavailable');
  }
  try {
    let count;
    while ((count = fs.readSync(handle, chunk, 0, chunk.length, null)) > 0) {
      const current = chunk.subarray(0, count);
      hash.update(current);
      const window = tail.length ? Buffer.concat([tail, current]) : current;
      const windowStart = total - tail.length;
      let at = -1;
      while ((at = window.indexOf(markerBytes, at + 1)) >= 0) {
        // A candidate's prefix must be complete, and the marker must not have
        // been counted in an earlier chunk (its end lies beyond this chunk start).
        if (at >= prefixBytes && windowStart + at + markerBytes.length > total) {
          candidates.push(Buffer.from(window.subarray(at - prefixBytes, at)));
        }
      }
      total += count;
      tail = Buffer.from(window.subarray(Math.max(0, window.length - tailBytes)));
    }
  } finally {
    fs.closeSync(handle);
  }
  if (candidates.length !== 1) throw failure('trae_credential_profile_unknown');
  return { prefix: candidates[0], digest: hash.digest('hex') };
}

/**
 * Resolve the app directory for profile derivation.
 * @param {{appDir?: string, local?: string, env?: Record<string, string|undefined>}} options
 * @returns {string}
 */
function profileAppDir(options) {
  if (nonEmptyString(options.appDir)) return options.appDir;
  if (nonEmptyString(options.local)) return path.join(options.local, 'Programs', 'Trae', CLIENT_LAYOUT.appRoot);
  return resolveAppDir(options.env).appDir;
}

/**
 * Derive the AES-256-GCM profile from the installed Trae DLLs.
 * Steps: require allowlisted appVersion -> scan both DLLs with bounded memory
 * (1 MiB chunks) for DLL_MARKERS -> require exactly one candidate prefix each ->
 * require both whole-file SHA-256 values to match the allowlist -> require the
 * cross-file hex invariants -> key[0..8) ^= salt[0..8), wipe salt.
 * @param {ProfileOptions & {env?: Record<string,string|undefined>}} [options]
 * @returns {CredentialProfile}
 * @throws {Error} `trae_credential_version_unsupported` | `trae_credential_build_unsupported` |
 *   `trae_credential_profile_unknown` | `trae_installation_unavailable`.
 */
export function readNativeCredentialProfile(options = {}) {
  const appDir = profileAppDir(options);
  const version = readProduct(appDir).appVersion;
  const builds = options.builds ?? VERIFIED_BUILDS;
  if (!Object.hasOwn(builds, version)) throw failure('trae_credential_version_unsupported');
  const allowed = builds[version];
  if (!allowed || !nonEmptyString(allowed.harness) || !nonEmptyString(allowed.aiAgent)) {
    throw failure('trae_credential_build_unsupported');
  }

  const root = path.join(appDir, CLIENT_LAYOUT.aiAgentDir);
  const harnessFile = path.join(root, CLIENT_LAYOUT.harnessDll);
  const aiAgentFile = path.join(root, CLIENT_LAYOUT.aiAgentDll);
  let identity;
  try {
    identity = `${version}|${[harnessFile, aiAgentFile].map((file) => {
      const stat = fs.statSync(file);
      return `${file}:${stat.size}:${stat.mtimeMs}`;
    }).join('|')}`;
  } catch {
    throw failure('trae_installation_unavailable');
  }
  if (cachedProfile
    && cachedProfile.identity === identity
    && cachedProfile.harnessSha256 === allowed.harness
    && cachedProfile.aiAgentSha256 === allowed.aiAgent) {
    return cachedProfile;
  }

  const harness = inspect(harnessFile, DLL_MARKERS.harness, DLL_MARKERS.harnessPrefixBytes);
  const aiAgent = inspect(aiAgentFile, DLL_MARKERS.aiAgent, DLL_MARKERS.aiAgentPrefixBytes);
  if (harness.digest !== allowed.harness || aiAgent.digest !== allowed.aiAgent) {
    throw failure('trae_credential_build_unsupported');
  }

  const h = harness.prefix.toString('ascii');
  const a = aiAgent.prefix.toString('ascii');
  if (!HARNESS_SHAPE.test(h)) throw failure('trae_credential_profile_unknown');
  if (!AI_AGENT_SHAPE.test(a)) throw failure('trae_credential_profile_unknown');
  if (a.slice(0, 64) !== h.slice(0, 64) || a.slice(74, 94) !== h.slice(64, 84)) {
    throw failure('trae_credential_profile_unknown');
  }

  const key = Buffer.from(h.slice(0, 64), 'hex');
  const salt = Buffer.from(h.slice(64, 84), 'hex');
  for (let index = 0; index < CRYPTO.keyXorBytes; index++) key[index] ^= salt[index];
  salt.fill(0);
  const aad = Buffer.from(a.slice(64, 74), 'ascii');

  const profile = Object.freeze({
    id: `trae-intl-${version}:${harness.digest}`,
    identity,
    version,
    key,
    aad,
    harnessSha256: harness.digest,
    aiAgentSha256: aiAgent.digest,
  });
  cachedProfile = profile;
  return profile;
}

/** @param {unknown} profile @returns {boolean} */
function usableProfile(profile) {
  return Boolean(profile)
    && Buffer.isBuffer(profile.key)
    && profile.key.length === CRYPTO.keyBytes
    && Buffer.isBuffer(profile.aad);
}

/**
 * Encode a value as `base64(nonce[12] || ciphertext || tag[16])` with AAD.
 * @param {string} value
 * @param {CredentialProfile} profile
 * @param {Buffer} [nonce] 12 random bytes; a fresh random nonce when omitted.
 * @returns {string} Standard base64 (with padding).
 * @throws {Error} `trae_credential_input_invalid`.
 */
export function encodeCredential(value, profile, nonce) {
  if (typeof value !== 'string' || !usableProfile(profile)) {
    throw failure('trae_credential_input_invalid');
  }
  const iv = nonce === undefined ? randomBytes(CRYPTO.nonceBytes) : nonce;
  if (!Buffer.isBuffer(iv) || iv.length !== CRYPTO.nonceBytes) {
    throw failure('trae_credential_input_invalid');
  }
  const cipher = createCipheriv(CRYPTO.algorithm, profile.key, iv);
  cipher.setAAD(profile.aad);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64');
}

/**
 * Decode a native envelope.
 * @param {string} value
 * @param {CredentialProfile} profile
 * @returns {string}
 * @throws {Error} `trae_credential_invalid` on non-canonical base64, short input,
 *   or any GCM authentication failure. The message never includes input bytes.
 */
export function decodeCredential(value, profile) {
  if (typeof value !== 'string' || !value || !usableProfile(profile)) {
    throw failure('trae_credential_invalid');
  }
  // Canonical standard base64 only; Buffer.from would otherwise ignore junk.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw failure('trae_credential_invalid');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < CRYPTO.nonceBytes + CRYPTO.tagBytes) throw failure('trae_credential_invalid');
  if (bytes.toString('base64') !== value) throw failure('trae_credential_invalid');
  const nonce = bytes.subarray(0, CRYPTO.nonceBytes);
  const tag = bytes.subarray(-CRYPTO.tagBytes);
  const ciphertext = bytes.subarray(CRYPTO.nonceBytes, -CRYPTO.tagBytes);
  try {
    const decipher = createDecipheriv(CRYPTO.algorithm, profile.key, nonce);
    decipher.setAAD(profile.aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw failure('trae_credential_invalid');
  }
}

/**
 * Resolve the credential mode from the environment.
 * @returns {'native'|'plaintext'} Defaults to `native`.
 * @throws {Error} `trae_credential_mode_invalid` for an unknown value.
 */
export function credentialMode() {
  const value = process.env[ENV.credentialMode];
  if (value === undefined || value === '' || value === 'native') return 'native';
  if (value === 'plaintext') return 'plaintext';
  throw failure('trae_credential_mode_invalid');
}

/** Persist the local credential cache atomically (0700 dir, 0600 wx temp + rename). */
function writeCredentialCache(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch {
    throw failure('sync_file_unwritable');
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } catch {
    throw failure('sync_file_unwritable');
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /* Best effort: the temp name is unique and never holds a plaintext marker. */
    }
  }
}

/**
 * Return the AK value to register in Trae for the loopback marker.
 * `native` (default): cached envelope in local-credential.json, self-checked on
 * write and reuse. `plaintext`: the raw marker, only behind an explicit opt-in.
 * @param {string} file `local-credential.json` path.
 * @param {{ profile?: CredentialProfile, mode?: 'native'|'plaintext' }} [options]
 * @returns {string} Encoded AK (native) or the marker (plaintext).
 * @throws {Error} `trae_credential_cache_unreadable` | `trae_credential_self_check_failed` |
 *   `trae_credential_unavailable` | `trae_credential_mode_invalid` | `sync_file_unwritable`.
 */
export function localCredential(file, options = {}) {
  const mode = options.mode ?? credentialMode();
  if (mode === 'plaintext') return LOCAL_TOKEN;
  if (mode !== 'native') throw failure('trae_credential_mode_invalid');

  let profile = options.profile;
  if (!profile) {
    try {
      profile = readNativeCredentialProfile();
    } catch {
      throw failure('trae_credential_unavailable');
    }
  }
  if (!usableProfile(profile)) throw failure('trae_credential_unavailable');

  let stored;
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw failure('trae_credential_cache_unreadable');
  }
  if (stored && stored.version === CRYPTO.cacheVersion && stored.mode === 'native'
    && stored.profile === profile.id) {
    try {
      if (decodeCredential(stored.ak, profile) === LOCAL_TOKEN) return stored.ak;
    } catch {
      /* A stale or foreign envelope is regenerated below. */
    }
  }

  const ak = encodeCredential(LOCAL_TOKEN, profile);
  let verified = false;
  try {
    verified = decodeCredential(ak, profile) === LOCAL_TOKEN;
  } catch {
    verified = false;
  }
  if (!verified) throw failure('trae_credential_self_check_failed');
  writeCredentialCache(file, { version: CRYPTO.cacheVersion, mode: 'native', profile: profile.id, ak });
  return ak;
}