// Trae account API client (catalog + custom-model CRUD). Owner: implementer B.
//
// Contract: docs/design/interfaces.md §5.
// The only module that talks to Trae's cloud. It never receives a Magpie key:
// the `ak` it sends is the native envelope of the loopback marker, and the
// bridge (not this module) holds `gatewayKey`.

import http from 'node:http';
import https from 'node:https';
import {
  API_METHODS,
  API_PREFIX,
  BATCH_DEFAULTS,
  CALLABLE_METHODS,
  DEFAULT_REGION,
  LIMITS,
  PROVIDER,
  TRAE_HOSTS,
} from './constants.mjs';
import { buildHeaders } from './session.mjs';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Normalized catalog entry. Both `model_list` (flat) and
 * `batch_get_detail_param` (nested) responses are reduced to this shape.
 * @typedef {object} CatalogEntry
 * @property {string} id          `custom_model_id` as a string.
 * @property {string} model       `model_name` / `name`.
 * @property {string} provider
 * @property {string} name        Display name.
 * @property {string} [ak]        Native envelope as returned by the server.
 * @property {string} [sk]        Usually "".
 * @property {string} [baseURL]   `base_url`.
 * @property {boolean} status
 * @property {number} [authType]
 * @property {number} [configSource]
 * @property {string} [customModelType]
 * @property {boolean} [clientConnect] True means Trae's native client calls base_url locally.
 * @property {Record<string, unknown>} config Parsed `custom_config` object (never a raw string).
 * @property {{multimodal: boolean, model_hyper_params: Record<string, unknown>, max_turn: number}} detail
 * @property {Record<string, unknown>} [raw] Server subset kept only for unparseable custom_config.
 */

/**
 * @typedef {object} ApiOptions
 * @property {(url: string, init: object) => Promise<Response>} [request] fetch-compatible transport.
 * @property {string} [origin] `https://<host>`; resolved from the session region when omitted.
 * @property {import('./paths.mjs').Product} [product] Product descriptor for request headers.
 * @property {'batch'|'model_list'|'auto'} [catalog] Defaults to `batch` (see architecture §9).
 * @property {boolean} [envelope] Add the `Request: {}` envelope to catalog calls.
 *   Default false: the international endpoint rejects the envelope with HTTP 400
 *   (verified live 2026-11-21); `true` is kept for probes against other builds.
 * @property {string[]} [functions] Batch function list (default BATCH_DEFAULTS.functions).
 * @property {number} [timeoutMs]
 * @property {() => string} [encodeEmptySecret] Envelope encoder for an empty SK.
 * @property {'string'|'number'} [idType] Wire type for model ids. Default
 *   `'number'` (verified live 2026-11-21: update rejects string ids with HTTP 400).
 * @property {(url: string, init: {headers: Record<string,string>, body: string, timeoutMs: number}) => Promise<{status: number, text: string}>} [httpGet]
 *   GET-with-body transport used by the `model_list` strategy (tests).
 */

/** @param {string} code @returns {Error} */
function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/** Make an upstream code safe for an error message (`^[a-z][a-z0-9_]*$`). */
function machineCode(value) {
  const text = String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return text || 'unknown';
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Remove a trailing slash from the resolved origin. */
function trimOrigin(value) {
  return String(value).replace(/\/+$/, '');
}

/**
 * GET with a JSON body over `node:http`/`node:https`. WHATWG fetch refuses a
 * body on GET, so the `model_list` fallback uses this dedicated transport.
 * @param {string} url
 * @param {{headers: Record<string,string>, body: string, timeoutMs: number}} options
 * @returns {Promise<{status: number, text: string}>}
 */
function httpGetJson(url, { headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(failure('trae_origin_invalid'));
      return;
    }
    const transport = target.protocol === 'http:' ? http : https;
    const payload = typeof body === 'string' ? body : '';
    const request = transport.request(target, {
      method: 'GET',
      headers: { ...headers, 'content-length': Buffer.byteLength(payload) },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
      response.on('error', reject);
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(failure('trae_api_timeout'));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function parseCustomConfig(value) {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return isObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isObject(value) ? value : {};
}

/** Assemble `detail` from flat or nested sources, omitting absent fields. */
function buildDetail(multimodal, hyper, maxTurn) {
  const params = {};
  for (const key of ['max_tokens', 'prompt_max_tokens', 'thinking_enable', 'reasoning_param']) {
    if (hyper[key] !== undefined && hyper[key] !== null) params[key] = hyper[key];
  }
  return {
    multimodal: Boolean(multimodal),
    model_hyper_params: params,
    max_turn: typeof maxTurn === 'number' && Number.isFinite(maxTurn) ? maxTurn : 500,
  };
}

/** First entry wins; later duplicates only fill empty fields. */
function mergeEntries(entries, entry) {
  const existing = entries.get(entry.id);
  if (!existing) {
    entries.set(entry.id, entry);
    return;
  }
  for (const [key, value] of Object.entries(entry)) {
    const current = existing[key];
    if (current === undefined || current === null || current === '') existing[key] = value;
  }
}

/** Trim a successful response to the documented `{code, message}` shape. */
function acknowledgement(result) {
  const code = result && typeof result.code === 'number' ? result.code : 0;
  if (result && typeof result.message === 'string') return { code, message: result.message };
  return { code };
}

export class TraeAPI {
  /**
   * @param {import('./session.mjs').TraeSession} session
   * @param {ApiOptions} [options]
   */
  constructor(session, options = {}) {
    this.session = session;
    this.product = options.product;
    this.request = options.request ?? fetch;
    this.origin = trimOrigin(options.origin ?? resolveOrigin({ session, product: options.product }));
    this.catalog = options.catalog ?? 'batch';
    this.envelope = options.envelope === true;
    this.functions = Array.isArray(options.functions) ? [...options.functions] : [...BATCH_DEFAULTS.functions];
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : LIMITS.apiTimeoutMs;
    this.encodeEmptySecret = options.encodeEmptySecret;
    // Verified live (2026-11-21): international update_custom_model answers 400
    // to a string id and 200 {code:0} to a number. 'string' stays available for
    // probes against other builds.
    this.idType = options.idType === 'string' ? 'string' : 'number';
    this.httpGet = options.httpGet ?? httpGetJson;
  }

  /** Fresh header record for one request (never cached, never mutated). */
  headers() {
    const product = this.product ?? {
      appVersion: this.session?.productVersion,
      ideVersionCode: undefined,
    };
    return buildHeaders(this.session, product);
  }

  /** Catalog request body for `batch_get_detail_param`. */
  batchBody() {
    const body = {
      functions: [...this.functions],
      access_type: BATCH_DEFAULTS.access_type,
      ab_force_vids: BATCH_DEFAULTS.ab_force_vids,
      ab_autotest_advanced_mode: BATCH_DEFAULTS.ab_autotest_advanced_mode,
      agent_type: BATCH_DEFAULTS.agent_type,
      current_config_info: { ...BATCH_DEFAULTS.current_config_info },
      mode_type: BATCH_DEFAULTS.mode_type,
      show_custom_model: BATCH_DEFAULTS.show_custom_model,
    };
    // Verified live (2026-11-21): the international endpoint rejects a `Request`
    // envelope with HTTP 400. `envelope: true` keeps the legacy shape available
    // for probes against other builds.
    if (this.envelope) body.Request = {};
    return body;
  }

  /**
   * Authoritative catalog.
   * @param {{ strategy?: 'batch'|'model_list'|'auto' }} [options]
   * @returns {Promise<CatalogEntry[]>} Deduplicated by id, stable order.
   * @throws {Error} `trae_catalog_unknown` | `trae_catalog_<error_code>` |
   *   `trae_api_<code|status>` | `trae_response_<status>` | `trae_catalog_strategy_unsupported`.
   */
  async list(options = {}) {
    const strategy = options.strategy ?? this.catalog ?? 'batch';
    if (strategy === 'batch') return this.parseBatch(await this.call(API_METHODS.batchDetail, this.batchBody()));
    if (strategy === 'model_list') return this.modelList();
    if (strategy === 'auto') {
      try {
        return this.parseBatch(await this.call(API_METHODS.batchDetail, this.batchBody()));
      } catch (error) {
        if (error?.code === 'trae_catalog_unknown') return this.modelList();
        throw error;
      }
    }
    throw failure('trae_catalog_strategy_unsupported');
  }

  /** Flat `model_list` strategy (GET with a `Request` body). */
  async modelList() {
    const url = `${this.origin}${API_PREFIX}/model_list?type=`;
    const response = await this.httpGet(url, {
      headers: this.headers(),
      body: JSON.stringify({ Request: {} }),
      timeoutMs: this.timeoutMs,
    });
    const status = Number(response?.status ?? 0);
    if (!Number.isInteger(status) || status < 200 || status >= 300) {
      throw failure(`trae_api_${machineCode(status || 'unknown')}`);
    }
    let payload;
    try {
      payload = JSON.parse(String(response?.text ?? ''));
    } catch {
      throw failure(`trae_response_${status}`);
    }
    if (payload?.code !== undefined && payload.code !== 0) {
      throw failure(`trae_api_${machineCode(payload.code)}`);
    }
    return this.parseModelList(payload);
  }

  /**
   * Normalize a `batch_get_detail_param` payload. Accepts both an object keyed by
   * function name and an array of groups, as the international client emits both.
   * @param {unknown} payload
   * @returns {CatalogEntry[]}
   */
  parseBatch(payload) {
    const data = isObject(payload) && payload.data !== undefined ? payload.data : payload;
    if (!isObject(data)) throw failure('trae_catalog_unknown');
    const configs = data.function_configs;
    if (!isObject(configs) && !Array.isArray(configs)) throw failure('trae_catalog_unknown');
    const groups = Array.isArray(configs)
      ? configs
      : Object.entries(configs).map(([name, group]) => (
        isObject(group) ? { function: name, ...group } : { function: name }
      ));

    const entries = new Map();
    for (const group of groups) {
      if (group === null || group === undefined) continue;
      if (!isObject(group)) continue;
      const errorCode = group.error_code;
      if (errorCode !== undefined && errorCode !== null && errorCode !== ''
        && errorCode !== 0 && errorCode !== '0') {
        throw failure(`trae_catalog_${machineCode(errorCode)}`);
      }
      const infos = Array.isArray(group.config_info_list) ? group.config_info_list : [];
      for (const info of infos) {
        if (!isObject(info)) continue;
        const details = Array.isArray(info.model_detail_list) ? info.model_detail_list : [];
        for (const detail of details) {
          if (!isObject(detail)) continue;
          const rawConfig = detail.custom_config;
          const config = parseCustomConfig(rawConfig);
          const id = String(config.custom_model_id ?? detail.custom_model_id ?? '');
          if (!id) continue;
          const model = detail.model_name ?? detail.name ?? '';
          const display = info.display_config;
          const entry = {
            id,
            model,
            provider: detail.provider ?? PROVIDER,
            name: (isObject(display) && display.display_name !== undefined ? display.display_name : undefined)
              ?? info.config_name ?? model,
            status: config.status !== false,
            config,
            detail: buildDetail(
              isObject(display) && display.multimodal !== undefined ? display.multimodal : detail.multimodal,
              {
                max_tokens: detail.max_tokens,
                prompt_max_tokens: detail.prompt_max_tokens,
                thinking_enable: config.thinking_enable,
                reasoning_param: config.reasoning_param,
              },
              detail.max_turn,
            ),
          };
          if (config.ak !== undefined) entry.ak = config.ak;
          entry.sk = config.sk ?? '';
          if (config.base_url !== undefined) entry.baseURL = config.base_url;
          if (config.auth_type !== undefined) entry.authType = config.auth_type;
          if (config.config_source !== undefined) entry.configSource = config.config_source;
          if (config.custom_model_type !== undefined) entry.customModelType = config.custom_model_type;
          const clientConnect = config.client_connect ?? detail.client_connect;
          if (clientConnect !== undefined) entry.clientConnect = Boolean(clientConnect);
          if (typeof rawConfig === 'string' && !Object.keys(config).length && rawConfig) {
            entry.raw = { custom_config: rawConfig };
          }
          mergeEntries(entries, entry);
        }
      }
    }
    return [...entries.values()];
  }

  /**
   * Normalize a `model_list` payload (flat top-level entries).
   * @param {unknown} payload
   * @returns {CatalogEntry[]}
   */
  parseModelList(payload) {
    const data = isObject(payload) && payload.data !== undefined ? payload.data : payload;
    if (!isObject(data) || !Array.isArray(data.model_list)) throw failure('trae_catalog_unknown');
    const entries = new Map();
    for (const raw of data.model_list) {
      if (!isObject(raw)) continue;
      const id = String(raw.custom_model_id ?? '');
      if (!id) continue;
      const config = parseCustomConfig(raw.custom_config);
      const entry = {
        id,
        model: raw.model_name ?? raw.name ?? '',
        provider: raw.provider ?? PROVIDER,
        name: raw.display_name ?? raw.name ?? raw.model_name ?? '',
        status: raw.status !== false,
        config,
        detail: buildDetail(
          raw.multimodal ?? config.multimodal,
          {
            max_tokens: raw.max_tokens,
            prompt_max_tokens: raw.prompt_max_tokens,
            thinking_enable: raw.thinking_enable ?? config.thinking_enable,
            reasoning_param: raw.reasoning_param ?? config.reasoning_param,
          },
          raw.max_turn,
        ),
      };
      if (raw.ak !== undefined) entry.ak = raw.ak;
      entry.sk = raw.sk ?? '';
      if (raw.base_url !== undefined) entry.baseURL = raw.base_url;
      if (raw.auth_type !== undefined) entry.authType = raw.auth_type;
      if (raw.config_source !== undefined) entry.configSource = raw.config_source;
      if (raw.custom_model_type !== undefined) entry.customModelType = raw.custom_model_type;
      if (raw.client_connect !== undefined) entry.clientConnect = Boolean(raw.client_connect);
      if (typeof raw.custom_config === 'string' && !Object.keys(config).length && raw.custom_config) {
        entry.raw = { custom_config: raw.custom_config };
      }
      mergeEntries(entries, entry);
    }
    return [...entries.values()];
  }

  /**
   * Register one custom model (`add_custom_model`).
   * The response carries no id; the catalog is the source of truth.
   * @param {import('./sync.mjs').ModelRequest} request
   * @returns {Promise<{code: number, message?: string}>}
   * @throws {Error} `trae_model_invalid` when the request is not an object.
   */
  async add(request) {
    if (!isObject(request)) throw failure('trae_model_invalid');
    return acknowledgement(await this.call(API_METHODS.add, request));
  }

  /**
   * Update or restore one custom model (`update_custom_model`).
   * @param {import('./sync.mjs').ModelUpdateRequest} body
   * @returns {Promise<{code: number, message?: string}>}
   * @throws {Error} `trae_model_id_invalid` when a numeric id is required but invalid.
   */
  async update(body) {
    if (!isObject(body)) throw failure('trae_model_invalid');
    const payload = { ...body, action: 'update' };
    if (this.idType === 'number') {
      if (body.id === undefined || body.id === null || body.id === '') throw failure('trae_model_id_invalid');
      const numeric = Number(body.id);
      if (!Number.isSafeInteger(numeric) || numeric < 0) throw failure('trae_model_id_invalid');
      payload.id = numeric;
    } else {
      const id = body.id === undefined || body.id === null ? '' : String(body.id);
      if (!id) throw failure('trae_model_id_invalid');
      payload.id = id;
    }
    return acknowledgement(await this.call(API_METHODS.update, payload));
  }

  /**
   * Delete one custom model (reuses update_custom_model with action=delete).
   * The id follows `idType` (numeric on international, verified live 2026-11-21).
   * @param {{id: string|number}} entry
   * @returns {Promise<{code: number, message?: string}>}
   * @throws {Error} `trae_model_id_invalid` when the id is missing.
   */
  async remove(entry) {
    const raw = entry && entry.id !== undefined && entry.id !== null ? entry.id : '';
    if (raw === '' || raw === null || raw === undefined) throw failure('trae_model_id_invalid');
    const id = this.idType === 'number' ? this.numericId(raw) : String(raw);
    return acknowledgement(await this.call(API_METHODS.update, { action: 'delete', id }));
  }

  /** Coerce a catalog id to the wire type; invalid input fails loudly. */
  numericId(value) {
    const numeric = Number(value);
    if (value === '' || value === null || value === undefined
      || !Number.isSafeInteger(numeric) || numeric < 0) {
      throw failure('trae_model_id_invalid');
    }
    return numeric;
  }

  /**
   * POST one whitelisted method.
   * Rules: reject methods outside CALLABLE_METHODS; for add/update replace a
   * plaintext empty `sk` with the native empty envelope (when the caller injected
   * an encoder) without mutating the caller's object; 15 s timeout;
   * `redirect:'error'`; non-JSON -> `trae_response_<status>`; non-2xx or
   * code !== 0 -> `trae_api_<code|status>`.
   * @param {string} method
   * @param {Record<string, unknown>} body
   * @returns {Promise<Record<string, unknown>>} Raw parsed response.
   * @throws {Error} `unsupported_trae_operation` | `trae_response_<status>` | `trae_api_<code>`.
   */
  async call(method, body) {
    if (!CALLABLE_METHODS.includes(method)) throw failure('unsupported_trae_operation');
    let payload = body;
    if ((method === API_METHODS.add || method === API_METHODS.update)
      && isObject(payload) && payload.sk === '' && typeof this.encodeEmptySecret === 'function') {
      payload = { ...payload, sk: this.encodeEmptySecret() };
    }
    const response = await this.request(`${this.origin}${API_PREFIX}/${method}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const status = Number(response?.status ?? 0);
    let result;
    try {
      result = await response.json();
    } catch {
      throw failure(`trae_response_${status || 'unknown'}`);
    }
    const business = isObject(result) ? result.code : undefined;
    if (!response?.ok) {
      throw failure(`trae_api_${machineCode(business !== undefined && business !== 0 ? business : status)}`);
    }
    // International 3.6.20 answers 2xx without a `code` field (verified live,
    // 2026-11-21); a present, nonzero `code` stays the CN-style business failure.
    if (business !== undefined && business !== 0) {
      throw failure(`trae_api_${machineCode(business)}`);
    }
    return result;
  }
}

/**
 * Resolve `https://<model-api-host>` from the session region and product table.
 * Unknown region -> `normal`; missing bootConfig -> TRAE_HOSTS. `session.authHost`
 * is never used.
 * @param {{ session?: {region?: string}, product?: {hosts?: Record<string, Record<string,string>>}, override?: string }} [options]
 * @returns {string}
 * @throws {Error} `trae_origin_unavailable` when no host can be selected;
 *   `trae_origin_invalid` for an illegal override.
 */
export function resolveOrigin(options = {}) {
  const override = options.override;
  if (override !== undefined && override !== null && override !== '') {
    let url;
    try {
      url = new URL(String(override));
    } catch {
      throw failure('trae_origin_invalid');
    }
    const loopback = LOOPBACK_HOSTS.has(url.hostname);
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) {
      throw failure('trae_origin_invalid');
    }
    if (url.username || url.password || url.search || url.hash) throw failure('trae_origin_invalid');
    return `${url.protocol}//${url.host}`;
  }
  const region = options.session?.region ?? DEFAULT_REGION;
  const table = options.product?.hosts?.agent ?? TRAE_HOSTS.agent;
  const selected = table?.[region] ?? table?.normal;
  if (typeof selected !== 'string' || !selected.trim()) throw failure('trae_origin_unavailable');
  let host = selected.trim();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) host = new URL(host).host;
  } catch {
    throw failure('trae_origin_unavailable');
  }
  host = host.split('/')[0];
  if (!host) throw failure('trae_origin_unavailable');
  return `https://${host}`;
}