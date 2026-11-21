// Trae login session + account-API request headers. Owner: implementer B.
//
// Contract: docs/design/interfaces.md §3.
// Read-only: this module never signs in, refreshes a token or writes storage.json.

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import {
  APP_ID,
  AUTH_SCHEME,
  DEFAULT_REGION,
  DEVICE_TYPE,
  HEADERS,
  IDE_VERSION_CODE_FALLBACK,
  LIMITS,
  PRODUCT,
} from './constants.mjs';
import { readProduct, resolveAppDir, resolveDataDirs } from './paths.mjs';
import { clientDecode } from './vendor/trae-client-codec.mjs';

/** storage.json key holding the (possibly encoded) auth blob. */
const AUTH_KEY = 'iCubeAuthInfo://icube.cloudide';
/** Device key shape; exactly one must exist. */
const DEVICE_KEY = /^iCubeAuthInfo:\/\/icube-dc:\d+$/;
const ALLOWED_REGIONS = new Set(['CN', 'SG', 'US', 'USTTP']);
/** Host names Trae signs in against (public; not used for model API calls). */
const AUTH_HOST_SUFFIXES = ['.trae.ai', '.trae.com'];

/**
 * @typedef {object} TraeSession
 * @property {string} account     Lowercase hex SHA-256 of String(userId). Safe to persist.
 * @property {string} token       Confidential JWT. Never persisted, logged or returned by /health.
 * @property {string} userId      Confidential account id. Never persisted or logged.
 * @property {string} deviceId    Confidential device id. Never persisted or logged.
 * @property {'CN'|'SG'|'US'|'USTTP'|'UNKNOWN'} region
 * @property {string} aiRegion
 * @property {string} authHost    Account API host from the decoded auth blob (not the model API host).
 * @property {string} expiresAt   ISO timestamp from the JWT `exp` claim.
 * @property {string} storageFile Source file (for diagnostics; contains no secret itself).
 * @property {string} productVersion
 */

/**
 * @typedef {object} SessionOptions
 * @property {string} [storageFile] Explicit storage.json path (tests).
 * @property {import('./paths.mjs').Product} [product] Product descriptor; re-read from disk when omitted.
 * @property {{ decode(value: string): string }} [codec] Injectable client codec (tests).
 */

/** @param {string} code @returns {Error} */
function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/**
 * Decode the `exp` claim from a JWT without keeping the payload around.
 * A malformed token cannot prove freshness, so it is reported as expired.
 * @param {string} token
 * @returns {number}
 */
function jwtExpiry(token) {
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) throw failure('trae_sign_in_expired');
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw failure('trae_sign_in_expired');
  }
  const exp = payload?.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) throw failure('trae_sign_in_expired');
  return exp;
}

/**
 * Validate the account `host` field when present: https only, and the hostname
 * must belong to the Trae domains. A bare hostname is accepted; an explicit
 * `http://` is not. An absent host yields '' (it is never used for model API
 * calls; only `authHost` diagnostics read it).
 * @param {unknown} value
 * @returns {string} Bare hostname.
 */
function normalizeAuthHost(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !value.trim()) throw failure('trae_session_invalid');
  const text = value.trim();
  if (/^http:\/\//i.test(text)) throw failure('trae_session_invalid');
  let url;
  try {
    url = new URL(/^https:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw failure('trae_session_invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw failure('trae_session_invalid');
  }
  const hostname = url.hostname.toLowerCase();
  if (!AUTH_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw failure('trae_session_invalid');
  }
  return hostname;
}

/** @param {unknown} value @returns {string} */
function regionValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Read the signed-in Trae account from storage.json.
 * Steps: read `iCubeAuthInfo://icube.cloudide` -> plaintext JSON or client codec ->
 * require token/userId -> decode JWT payload -> require exp > now + 30s ->
 * require exactly one `iCubeAuthInfo://icube-dc:<digits>` device key.
 * @param {SessionOptions} [options]
 * @returns {TraeSession}
 * @throws {Error} `trae_session_unreadable` | `trae_not_signed_in` |
 *   `trae_sign_in_expired` | `trae_device_unavailable` | `trae_codec_unsupported` |
 *   `trae_session_invalid`.
 */
export function readSession(options = {}) {
  const storageFile = options.storageFile ?? resolveDataDirs().storage;
  const codec = options.codec ?? { decode: clientDecode };
  const product = options.product ?? readProduct(resolveAppDir().appDir);

  let storage;
  try {
    storage = JSON.parse(fs.readFileSync(storageFile, 'utf8'));
  } catch {
    throw failure('trae_session_unreadable');
  }
  if (!storage || typeof storage !== 'object' || Array.isArray(storage)) {
    throw failure('trae_session_unreadable');
  }

  const raw = storage[AUTH_KEY];
  if (typeof raw !== 'string' || !raw.trim()) throw failure('trae_not_signed_in');

  const trimmed = raw.trim();
  let auth;
  if (trimmed.startsWith('{')) {
    try {
      auth = JSON.parse(trimmed);
    } catch {
      throw failure('trae_session_unreadable');
    }
  } else {
    let decoded;
    try {
      decoded = codec.decode(trimmed);
    } catch {
      throw failure('trae_codec_unsupported');
    }
    if (typeof decoded !== 'string') throw failure('trae_codec_unsupported');
    try {
      auth = JSON.parse(decoded.trim());
    } catch {
      throw failure('trae_session_unreadable');
    }
  }
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) throw failure('trae_not_signed_in');

  const { token, userId } = auth;
  if (typeof token !== 'string' || !token) throw failure('trae_not_signed_in');
  if (userId === undefined || userId === null || String(userId) === '') throw failure('trae_not_signed_in');

  const expiresAtSeconds = jwtExpiry(token);
  if (expiresAtSeconds * 1000 <= Date.now() + LIMITS.connectionExpirySkewMs) {
    throw failure('trae_sign_in_expired');
  }

  const deviceKeys = Object.keys(storage).filter((key) => DEVICE_KEY.test(key));
  if (deviceKeys.length !== 1) throw failure('trae_device_unavailable');
  const deviceId = deviceKeys[0].split(':').pop();
  if (typeof deviceId !== 'string' || !deviceId) throw failure('trae_device_unavailable');

  const authHost = normalizeAuthHost(auth.host);

  const accountRegion = auth.account && typeof auth.account === 'object' ? auth.account : {};
  const userRegion = auth.userRegion && typeof auth.userRegion === 'object' ? auth.userRegion : {};
  const declaredRegion = typeof auth.userRegion === 'string'
    ? regionValue(auth.userRegion)
    : regionValue(userRegion.region);
  const storeRegion = regionValue(accountRegion.storeRegion);
  const rawRegion = declaredRegion || storeRegion || DEFAULT_REGION;
  const region = ALLOWED_REGIONS.has(rawRegion) ? rawRegion : 'UNKNOWN';
  const aiRegion = regionValue(userRegion._aiRegion) || storeRegion || region;

  return {
    account: createHash('sha256').update(String(userId)).digest('hex'),
    token,
    userId: String(userId),
    deviceId,
    region,
    aiRegion,
    authHost,
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
    storageFile,
    productVersion: typeof product?.appVersion === 'string' ? product.appVersion : '',
  };
}

/**
 * Build the header record for the plugin's own `/api/ide/v1/*` calls.
 * Header names come from HEADERS; the auth scheme is the recorded account-API
 * scheme. `x-uid`, `x-cloudide-token`, cookies and forwarding headers are
 * deliberately not sent (interfaces §3.3).
 * @param {TraeSession} session
 * @param {import('./paths.mjs').Product} [product]
 * @returns {Record<string, string>} Lowercase header names; includes the JWT.
 * @throws {Error} `trae_session_invalid` when the session is incomplete.
 */
export function buildHeaders(session, product = {}) {
  if (!session || typeof session !== 'object') throw failure('trae_session_invalid');
  if (typeof session.token !== 'string' || !session.token) throw failure('trae_session_invalid');
  if (typeof session.deviceId !== 'string' || !session.deviceId) throw failure('trae_session_invalid');
  const descriptor = product && typeof product === 'object' ? product : {};
  const version = typeof descriptor.appVersion === 'string' && descriptor.appVersion
    ? descriptor.appVersion
    : (typeof session.productVersion === 'string' ? session.productVersion : '');
  return {
    [HEADERS.auth]: `${AUTH_SCHEME} ${session.token}`,
    [HEADERS.ideToken]: session.token,
    [HEADERS.appId]: typeof descriptor.agentAppId === 'string' && descriptor.agentAppId
      ? descriptor.agentAppId
      : APP_ID,
    [HEADERS.deviceId]: session.deviceId,
    [HEADERS.deviceType]: DEVICE_TYPE,
    [HEADERS.appVersion]: version,
    [HEADERS.ideVersion]: version,
    [HEADERS.ideVersionCode]: typeof descriptor.ideVersionCode === 'string' && descriptor.ideVersionCode
      ? descriptor.ideVersionCode
      : IDE_VERSION_CODE_FALLBACK,
    [HEADERS.userRegion]: typeof session.region === 'string' && session.region ? session.region : DEFAULT_REGION,
    [HEADERS.clientType]: 'ide',
    [HEADERS.contentType]: 'application/json',
    [HEADERS.userAgent]: `${PRODUCT.name}/${PRODUCT.version}`,
  };
}