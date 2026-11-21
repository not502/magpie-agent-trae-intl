// In-memory stand-in for `TraeAPI`, used only by sync tests. It models the
// catalog as a mutable array so the synchronizer's read-back loop observes its
// own writes. No network, no credentials: `ak` values are obvious test strings.

import { PROVIDER } from '../../src/constants.mjs';

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, any>}
 */
export function remoteEntry(overrides = {}) {
  return {
    id: '101',
    model: 'model-a',
    provider: PROVIDER,
    name: 'Model A',
    ak: 'test-only-envelope-a',
    sk: '',
    baseURL: 'http://127.0.0.1:3499/v1/chat/completions',
    status: true,
    authType: 0,
    config: {},
    detail: { multimodal: false, model_hyper_params: { thinking_enable: 0 }, max_turn: 500 },
    ...overrides,
  };
}

export class FakeTraeAPI {
  /**
   * @param {{ account?: string, origin?: string, remote?: Record<string, any>[] }} [options]
   */
  constructor(options = {}) {
    this.session = { account: options.account ?? 'a'.repeat(64) };
    this.origin = options.origin ?? 'https://core-normal.trae.ai';
    this.remote = (options.remote ?? []).map((entry) => structuredClone(entry));
    this.calls = [];
    this.listCalls = 0;
    this.nextId = 900;
  }

  /** @param {{strategy?: string}} [options] */
  async list(options = {}) {
    this.listCalls += 1;
    this.calls.push({ method: 'list', strategy: options.strategy });
    return this.snapshot();
  }

  /**
   * @param {string} method
   * @param {Record<string, any>} body
   */
  async call(method, body) {
    this.calls.push({ method, body: structuredClone(body) });
    if (method === 'add_custom_model') {
      const entry = {
        id: String(this.nextId++),
        model: body.model_name,
        provider: body.provider,
        name: body.display_name,
        ak: body.ak,
        sk: body.sk ?? '',
        baseURL: body.base_url,
        status: true,
        authType: body.auth_type,
        config: {},
        detail: structuredClone(body.config_detail),
      };
      this.remote.push(entry);
      return { code: 0 };
    }
    if (method === 'update_custom_model') {
      if (body.action === 'delete') {
        this.remote = this.remote.filter((entry) => entry.id !== String(body.id));
        return { code: 0 };
      }
      const entry = this.remote.find((candidate) => candidate.id === String(body.id));
      if (!entry) return { code: 404, message: 'missing' };
      if (body.ak !== undefined) entry.ak = body.ak;
      if (body.provider !== undefined) entry.provider = body.provider;
      if (body.model_name !== undefined) entry.model = body.model_name;
      if (body.display_name !== undefined) entry.name = body.display_name;
      if (body.status !== undefined) entry.status = body.status;
      if (body.base_url !== undefined) entry.baseURL = body.base_url;
      if (body.auth_type !== undefined) entry.authType = body.auth_type;
      if (body.sk !== undefined) entry.sk = body.sk;
      if (body.config_detail !== undefined) entry.detail = structuredClone(body.config_detail);
      return { code: 0 };
    }
    return { code: 400, message: 'unsupported' };
  }

  /** @param {string} method */
  count(method) {
    return this.calls.filter((call) => call.method === method).length;
  }

  /** Clear recorded calls without touching the catalog. */
  resetCalls() {
    this.calls.length = 0;
    this.listCalls = 0;
  }

  /** @param {string} method */
  lastCall(method) {
    return [...this.calls].reverse().find((call) => call.method === method);
  }

  snapshot() {
    return this.remote.map((entry) => structuredClone(entry));
  }
}
