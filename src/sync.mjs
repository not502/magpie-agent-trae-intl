// Catalog synchronizer + recovery journal state machine. Owner: implementer B.
//
// Contract: docs/design/interfaces.md §7, architecture.md §5.3, §7.
// Invariant: journal first, then the cloud call, then read-back, then commit.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import {
  API_METHODS,
  CREDENTIAL_FORMAT,
  DEFAULT_PORT,
  ENV,
  LIMITS,
  MODEL_DEFAULTS,
  PROVIDER,
  REASONING_PARAMETER,
  STATE_VERSION,
} from './constants.mjs';
import { TraeAPI } from './api.mjs';
import { credentialMode, encodeCredential, localCredential, readNativeCredentialProfile } from './credential.mjs';
import { readProduct, resolveAppDir } from './paths.mjs';
import { readSession } from './session.mjs';
import { readJson, syncPaths, withLock, writeJsonAtomic } from './state.mjs';

/**
 * @typedef {object} Model One entry of connection.json `models`.
 * @property {string} id
 * @property {string} [name]
 * @property {number} [context]
 * @property {number} [output]
 * @property {boolean} [images]
 * @property {string[]} [efforts]
 */

/**
 * Request body for `add_custom_model` (11 fields, all always present).
 * @typedef {object} ModelRequest
 * @property {string} provider                  Always PROVIDER.
 * @property {string} model_name
 * @property {string} ak                        Native envelope of the loopback marker.
 * @property {true} is_custom
 * @property {0} auth_type
 * @property {string} sk                        Always "" on the wire; call() encodes it.
 * @property {string} region                    Provider region, never the user region.
 * @property {string} base_url                  `http://127.0.0.1:<port>/v1/chat/completions`.
 * @property {string} custom_model_type         "" (the UI's `other`).
 * @property {{multimodal: boolean, model_hyper_params: Record<string, unknown>, max_turn: number}} config_detail
 * @property {string} display_name              `"<name> · Magpie"`, at most 64 chars.
 */

/**
 * Request body for `update_custom_model` (13 fields when ak is included).
 * @typedef {object} ModelUpdateRequest
 * @property {'update'} action
 * @property {string} id
 * @property {string} [ak]                      Omitted when unchanged.
 * @property {string} provider
 * @property {string} model_name
 * @property {boolean} status
 * @property {0|1} auth_type
 * @property {string} sk                       "" for managed writes (call() encodes it); omitted by
 *                                             restore bodies when the adopted original SK is unknown.
 * @property {string} region
 * @property {string} base_url
 * @property {string} custom_model_type
 * @property {{multimodal: boolean, model_hyper_params: Record<string, unknown>, max_turn: number}} config_detail
 * @property {string} display_name
 */

/**
 * @typedef {object} SyncResult
 * @property {'synced'|'disconnected'} state
 * @property {number} models         Number of desired models.
 * @property {{model: string, code: string}[]} warnings
 * @property {string} revision       64-char lowercase hex; `''` only on the early disconnected return.
 * @property {string} updatedAt      ISO timestamp.
 * @property {string} [origin]       Host only (no scheme credentials, no key).
 */

/**
 * @typedef {object} SyncOptions
 * @property {import('./state.mjs').SyncPaths} [paths]
 * @property {() => (import('./api.mjs').TraeAPI|Promise<import('./api.mjs').TraeAPI>)} [apiFactory]
 * @property {(file: string, options?: object) => (string|Promise<string>)} [credentialFactory]
 * @property {number} [port]                 Bridge port; default DEFAULT_PORT.
 * @property {string} [endpoint]             Override the derived chat endpoint (tests only).
 * @property {number} [interval]             startModelSync polling interval.
 * @property {(ms: number) => Promise<void>} [sleep] Read-back delay (tests).
 * @property {() => string} [now]            ISO clock (tests).
 * @property {'batch'|'model_list'|'auto'} [catalog] Catalog strategy passed to the API.
 */

/** @param {string} code @returns {Error} */
function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/** @param {unknown} value @returns {string} */
function text(value) {
  return typeof value === 'string' ? value : '';
}

/** Journal snapshots must not alias the transport's mutable catalog objects. */
function snapshot(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Build one add request.
 * Rules: `ak` must be a non-empty string (`trae_credential_required`);
 * `prompt_max_tokens` only when context > 0; `max_tokens` only when output > 0;
 * `thinking_enable` 1 only when there is at least one effort other than
 * "default" (and then `reasoning_param` is present); `multimodal` boolean;
 * `max_turn` 500; `display_name` truncated to 64.
 * @param {Model} model
 * @param {string} endpoint
 * @param {string} ak
 * @returns {ModelRequest}
 * @throws {Error} `trae_credential_required` | `trae_model_invalid`
 */
export function modelRequest(model, endpoint, ak) {
  if (typeof ak !== 'string' || !ak) throw failure('trae_credential_required');
  if (!model || typeof model.id !== 'string' || !model.id) throw failure('trae_model_invalid');
  const levels = [...new Set(Array.isArray(model.efforts) ? model.efforts : [])]
    .filter((value) => typeof value === 'string' && value !== 'default');
  const hyper = { thinking_enable: levels.length ? 1 : 0 };
  if (typeof model.context === 'number' && model.context > 0) hyper.prompt_max_tokens = model.context;
  if (typeof model.output === 'number' && model.output > 0) hyper.max_tokens = model.output;
  if (levels.length) hyper.reasoning_param = { parameter: REASONING_PARAMETER, values: ['default', ...levels] };
  const label = text(model.name) || model.id;
  return {
    ak,
    provider: PROVIDER,
    model_name: model.id,
    is_custom: true,
    auth_type: 0,
    region: '',
    sk: '',
    base_url: endpoint,
    custom_model_type: '',
    config_detail: {
      multimodal: Boolean(model.images),
      model_hyper_params: hyper,
      max_turn: MODEL_DEFAULTS.maxTurn,
    },
    display_name: `${label}${MODEL_DEFAULTS.displayNameSuffix}`.slice(0, MODEL_DEFAULTS.displayNameMaxLength),
  };
}

/** Strip credential-shaped keys before hashing catalog configuration. */
function sanitizeConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
  const copy = {};
  for (const [key, value] of Object.entries(config)) {
    if (key === 'ak' || key === 'sk') continue;
    copy[key] = value;
  }
  return copy;
}

/** Coerce a catalog id to the numeric wire type the international API requires. */
function numericId(value) {
  const numeric = Number(value);
  if (value === '' || value === null || value === undefined
    || !Number.isSafeInteger(numeric) || numeric < 0) {
    throw failure('trae_model_id_invalid');
  }
  return numeric;
}

/** Version-2 fingerprint: configuration + a one-way credential marker, no raw ak/sk. */
function fingerprint(entry) {
  return JSON.stringify({
    configuration: {
      model: entry.model,
      name: entry.name,
      baseURL: entry.baseURL,
      status: entry.status,
      provider: entry.provider,
      authType: entry.authType,
      configSource: entry.configSource,
      customModelType: entry.customModelType,
      detail: entry.detail,
      config: sanitizeConfig(entry.config),
    },
    // Cover the SK too: when the catalog returns it, a user SK edit must be
    // detected like any other manual change. `last` is always recomputed from
    // the post-write read-back, so our own writes stay stable.
    credential: createHash('sha256')
      .update(`${String(entry.ak || '')}\u0000${String(entry.sk ?? '')}`)
      .digest('hex'),
  });
}

/** Version-1 fingerprint, used only to migrate an old journal in place. */
function legacyFingerprint(entry) {
  return JSON.stringify({
    model: entry.model,
    name: entry.name,
    baseURL: entry.baseURL,
    status: entry.status,
    detail: entry.detail,
  });
}

/** The (model, provider, base_url) tuple written by `modelRequest`. */
function matching(entry, request) {
  return entry.model === request.model_name
    && entry.provider === request.provider
    && entry.baseURL === request.base_url;
}

/** JSON-normalized deep equality (the wire cannot carry `undefined`). */
function sameJson(left, right) {
  return isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)));
}

/**
 * Compare only the hyper parameters the catalog echoes back. The international
 * catalog (verified live, 2026-11-21) returns `thinking_enable`,
 * `reasoning_param`, `multimodal` and `max_turn` for a custom model but never
 * `max_tokens`/`prompt_max_tokens`, so unechoed request fields cannot be
 * verified, and a field the server keeps without echoing cannot be corrected
 * from here — fighting it would loop forever.
 */
function hyperParamsMatch(entryParams, requestParams) {
  for (const [key, value] of Object.entries(entryParams ?? {})) {
    const wanted = requestParams?.[key];
    if (wanted === undefined) continue;
    if (!sameJson(value, wanted)) {
      // `thinking_enable` 0 may be echoed as absent; only a leftover 1 against
      // a requested 0 is a real divergence.
      if (key === 'thinking_enable' && wanted === 0 && (value === 0 || value === undefined)) continue;
      return false;
    }
  }
  if (requestParams?.thinking_enable === 1 && (entryParams?.thinking_enable ?? 0) !== 1) return false;
  if (requestParams?.reasoning_param !== undefined
    && (entryParams?.reasoning_param === undefined
      || !sameJson(entryParams.reasoning_param, requestParams.reasoning_param))) {
    return false;
  }
  return true;
}

/** Whether the server entry already reflects the desired request. */
function desiredMatches(entry, request, status = true) {
  return matching(entry, request)
    && entry.ak === request.ak
    && entry.name === request.display_name
    && entry.status === status
    && Boolean(entry.detail?.multimodal) === Boolean(request.config_detail?.multimodal)
    && (entry.detail?.max_turn ?? 500) === (request.config_detail?.max_turn ?? 500)
    && hyperParamsMatch(entry.detail?.model_hyper_params, request.config_detail?.model_hyper_params);
}

/**
 * Update body; `ak` is included only when the server value differs.
 * `omitUnknownSecret` is used when restoring an adopted entry: the catalog does
 * not return the SK, so an unknown original SK must be omitted from the body
 * (mirroring the native editor's ak omission) instead of being overwritten
 * with an empty string. Managed updates always send `sk` so the empty-SK
 * envelope reaches the server and the journal's credentialFormat stays true.
 */
function updateBody(entry, request, status = true, options = {}) {
  const body = {
    action: 'update',
    // The international update endpoint rejects string ids (verified live,
    // 2026-11-21); CN accepted both, so always send the numeric form.
    id: numericId(entry.id),
    ...(entry.ak !== request.ak ? { ak: request.ak } : {}),
    provider: request.provider,
    model_name: request.model_name,
    status,
    auth_type: request.auth_type || 0,
    region: request.region || '',
    base_url: request.base_url,
    custom_model_type: request.custom_model_type || '',
    config_detail: request.config_detail,
    display_name: request.display_name,
  };
  if (!options.omitUnknownSecret || request.sk) body.sk = request.sk || '';
  return body;
}

/** Restore the configuration captured before this plugin adopted an entry. */
function originalRequest(entry) {
  const config = entry && typeof entry.config === 'object' && entry.config ? entry.config : {};
  return {
    ak: entry.ak,
    provider: entry.provider,
    model_name: entry.model,
    base_url: entry.baseURL,
    auth_type: config.auth_type ?? entry.authType ?? 0,
    // "" means "unknown": updateBody({omitUnknownSecret:true}) then omits the
    // field so the server keeps whatever SK the adopted entry really had.
    sk: config.sk ?? entry.sk ?? '',
    region: config.region ?? '',
    custom_model_type: config.custom_model_type ?? entry.customModelType ?? '',
    config_detail: entry.detail,
    display_name: entry.name,
  };
}

/** Host-only origin for the status file (no scheme, no credentials, no key). */
function originHost(api) {
  const origin = api && typeof api.origin === 'string' ? api.origin : '';
  if (!origin) return '';
  try {
    return new URL(origin).host;
  } catch {
    return '';
  }
}

/**
 * Run one full synchronization pass under the cross-process lock.
 * Ordering: lock -> read control -> read journal -> account check -> list ->
 * journal v1->v2 upgrade -> recover pending (add, update, delete) -> desired loop
 * (adopt/create/update/skip/warn) -> release loop (delete/restore/drop) ->
 * revision -> write status.
 * @param {SyncOptions} [options]
 * @returns {Promise<SyncResult>}
 * @throws {Error} Any documented sync code; callers must whitelist before logging.
 */
export async function syncModels(options = {}) {
  const paths = options.paths ?? syncPaths();
  const now = options.now ?? (() => new Date().toISOString());
  const sleep = options.sleep ?? ((ms) => delay(ms));
  // Explicit option wins; otherwise honour the documented bridge port variable
  // so `magpie-trae-intl sync` and background polls agree with the running
  // bridge instead of silently rewriting base_url to the default port.
  const envPort = Number(process.env[ENV.port]);
  const fallbackPort = Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535
    ? envPort
    : DEFAULT_PORT;
  const port = Number.isInteger(options.port) ? options.port : fallbackPort;
  const catalog = options.catalog ?? 'batch';
  // Production wiring: the journal records credentialFormat 2, which claims
  // that the AK *and* the otherwise-empty SK are native envelopes, so add and
  // update calls must actually encode the empty SK. Plaintext mode keeps the
  // plaintext marker (journal format 0) and never encodes.
  let emptySecret;
  const encodeEmptySecret = () => {
    if (emptySecret === undefined) {
      emptySecret = credentialMode() === 'native'
        ? encodeCredential('', readNativeCredentialProfile())
        : '';
    }
    return emptySecret;
  };
  const apiFactory = options.apiFactory ?? (async () => {
    const product = readProduct(resolveAppDir().appDir);
    return new TraeAPI(readSession({ product }), { product, catalog, encodeEmptySecret });
  });
  const credentialFactory = options.credentialFactory ?? localCredential;

  return withLock(paths.lock, async () => {
    const control = readJson(paths.control, null);
    const connected = Boolean(control)
      && control.version === 2
      && typeof control.gatewayKey === 'string'
      && control.gatewayKey !== ''
      && Array.isArray(control.models);
    let state = readJson(paths.state, null);
    if (!connected && !state) {
      return {
        state: 'disconnected',
        models: 0,
        warnings: [],
        revision: '',
        updatedAt: now(),
      };
    }

    const api = await apiFactory();
    if (state && state.account !== api.session.account) throw failure('trae_account_changed');

    let remote = await api.list({ strategy: catalog });
    let dirty = false;
    if (!state) {
      state = { version: STATE_VERSION, account: api.session.account, entries: {}, pending: null };
      dirty = true;
    } else if (![1, 2].includes(state.version)) {
      throw failure('sync_state_version_unknown');
    }
    if (!state.entries || typeof state.entries !== 'object' || Array.isArray(state.entries)) state.entries = {};
    if (state.pending === undefined) state.pending = null;

    // Upgrade v1 journals only when no pending write is in flight.
    if (!state.pending) {
      for (const managed of Object.values(state.entries)) {
        const entry = remote.find((candidate) => candidate.id === managed.id);
        if (entry && managed.last === legacyFingerprint(entry)) {
          managed.last = fingerprint(entry);
          dirty = true;
        }
      }
      if (state.version !== STATE_VERSION) {
        state.version = STATE_VERSION;
        dirty = true;
      }
    }
    const save = () => writeJsonAtomic(paths.state, state);
    if (dirty) save();

    const endpoint = text(options.endpoint)
      || `http://127.0.0.1:${port}/v1/chat/completions`;
    const ak = connected ? await credentialFactory(paths.credential) : undefined;
    const desired = connected ? control.models.map((model) => modelRequest(model, endpoint, ak)) : [];
    const format = credentialMode() === 'native' ? CREDENTIAL_FORMAT : 0;
    const active = new Set(desired.map((request) => request.model_name));
    const warnings = [];

    const refresh = async (verified) => {
      for (let attempt = 0; attempt < LIMITS.readbackAttempts; attempt++) {
        remote = await api.list({ strategy: catalog });
        if (verified(remote)) return true;
        if (attempt < LIMITS.readbackAttempts - 1) await sleep(LIMITS.readbackDelayMs);
      }
      return false;
    };

    const remove = async (model, entry) => {
      state.pending = { kind: 'delete', model, before: snapshot(entry) };
      save();
      await api.call(API_METHODS.update, { action: 'delete', id: numericId(entry.id) });
      await refresh((list) => !list.some((candidate) => candidate.id === entry.id));
      if (remote.some((candidate) => candidate.id === entry.id)) {
        throw failure('trae_model_delete_unverified');
      }
      delete state.entries[model];
      state.pending = null;
      save();
    };

    // Recover a response lost after a successful create using its exact tuple.
    if (state.pending?.kind === 'add') {
      const pending = state.pending;
      const findMatches = (list) => list.filter((entry) => matching(entry, pending.request)
        && entry.name === pending.request.display_name);
      let found = findMatches(remote);
      if (found.length > 1) throw failure('ambiguous_managed_model');
      if (found.length === 0) {
        // The create response may have been lost while the catalog is still
        // eventually consistent: re-read through the full read-back window
        // before concluding that the add never landed, otherwise the same
        // model would be created twice and the journal would orphan one copy.
        await refresh((list) => findMatches(list).length > 0);
        found = findMatches(remote);
        if (found.length > 1) throw failure('ambiguous_managed_model');
      }
      if (found.length === 1) {
        state.entries[pending.model] = {
          id: found[0].id,
          created: true,
          last: fingerprint(found[0]),
          credentialFormat: pending.credentialFormat,
        };
      }
      state.pending = null;
      save();
    }

    if (state.pending?.kind === 'update') {
      const pending = state.pending;
      const entry = remote.find((candidate) => candidate.id === String(pending.body.id));
      if (!entry) throw failure('trae_pending_model_missing');
      const expected = pending.body;
      const target = { ...expected, ak: expected.ak ?? pending.before.ak };
      const applied = desiredMatches(entry, target, expected.status);
      if (!applied && fingerprint(entry) !== fingerprint(pending.before)) {
        throw failure('trae_pending_model_edited');
      }
      // SK is not returned by the catalog, so a format-repair replay is always
      // issued; the write is idempotent and proves the credential format.
      if (!applied || pending.credentialFormat === CREDENTIAL_FORMAT) {
        await api.call(API_METHODS.update, expected);
        await refresh((list) => list.some((candidate) => candidate.id === entry.id
          && desiredMatches(candidate, target, expected.status)));
      }
      const current = remote.find((candidate) => candidate.id === entry.id);
      if (!current || !desiredMatches(current, target, expected.status)) {
        throw failure('trae_model_update_unverified');
      }
      const managed = state.entries[pending.model];
      if (managed) {
        managed.last = fingerprint(current);
        if (pending.credentialFormat !== undefined) managed.credentialFormat = pending.credentialFormat;
      }
      if (pending.release) delete state.entries[pending.model];
      state.pending = null;
      save();
    }

    if (state.pending?.kind === 'delete') {
      const pending = state.pending;
      const entry = remote.find((candidate) => candidate.id === pending.before.id);
      if (entry) {
        if (fingerprint(entry) !== fingerprint(pending.before)) {
          throw failure('trae_pending_model_edited');
        }
        await remove(pending.model, entry);
      } else {
        delete state.entries[pending.model];
        state.pending = null;
        save();
      }
    }

    for (const request of desired) {
      let managed = state.entries[request.model_name];
      let entry = managed && remote.find((candidate) => candidate.id === managed.id);
      if (!managed) {
        const same = remote.filter((candidate) => matching(candidate, request));
        if (same.length > 1) throw failure('ambiguous_model_configuration');
        entry = same[0];
        if (entry) {
          // Adoptions are journaled before any write so disconnect can restore
          // the user's original configuration exactly.
          managed = { id: entry.id, created: false, before: snapshot(entry), last: fingerprint(entry) };
          state.entries[request.model_name] = managed;
          save();
        } else {
          state.pending = {
            kind: 'add',
            model: request.model_name,
            request,
            credentialFormat: format,
          };
          save();
          await api.call(API_METHODS.add, request);
          await refresh((list) => list.some((candidate) => matching(candidate, request)
            && candidate.name === request.display_name));
          entry = remote.find((candidate) => matching(candidate, request)
            && candidate.name === request.display_name);
          if (!entry) throw failure('trae_model_create_unverified');
          managed = {
            id: entry.id,
            created: true,
            last: fingerprint(entry),
            credentialFormat: format,
          };
          state.entries[request.model_name] = managed;
          state.pending = null;
          save();
        }
      }
      if (!entry) {
        warnings.push({ model: request.model_name, code: 'managed_model_removed_in_trae' });
        continue;
      }
      if (managed.last && managed.last !== fingerprint(entry)) {
        warnings.push({ model: request.model_name, code: 'model_edited_in_trae' });
        continue;
      }
      if (!desiredMatches(entry, request) || managed.credentialFormat !== format) {
        const body = updateBody(entry, request);
        state.pending = {
          kind: 'update',
          model: request.model_name,
          before: snapshot(entry),
          body,
          credentialFormat: format,
        };
        save();
        await api.call(API_METHODS.update, body);
        await refresh((list) => list.some((candidate) => candidate.id === managed.id
          && desiredMatches(candidate, request)));
        entry = remote.find((candidate) => candidate.id === managed.id);
        if (!entry || !desiredMatches(entry, request)) throw failure('trae_model_update_unverified');
        managed.last = fingerprint(entry);
        managed.credentialFormat = format;
        state.pending = null;
        save();
      }
    }

    // Release only journaled entries: delete our additions, restore adoptions.
    for (const [model, managed] of Object.entries(state.entries)) {
      if (active.has(model)) continue;
      const entry = remote.find((candidate) => candidate.id === managed.id);
      if (!entry) {
        delete state.entries[model];
        save();
        continue;
      }
      if (managed.last && managed.last !== fingerprint(entry)) {
        warnings.push({ model, code: 'model_edited_in_trae' });
        continue;
      }
      if (managed.created) {
        await remove(model, entry);
        continue;
      }
      const request = originalRequest(managed.before);
      const status = Boolean(managed.before && managed.before.status);
      if (!desiredMatches(entry, request, status)) {
        // Restoring must not clobber a server-side SK the catalog never showed
        // us: omit the field unless the adopted original carried one.
        const body = updateBody(entry, request, status, { omitUnknownSecret: true });
        state.pending = { kind: 'update', model, before: snapshot(entry), body, release: true };
        save();
        await api.call(API_METHODS.update, body);
        await refresh((list) => list.some((candidate) => candidate.id === managed.id
          && desiredMatches(candidate, request, status)));
        const restored = remote.find((candidate) => candidate.id === managed.id);
        if (!restored || !desiredMatches(restored, request, status)) {
          throw failure('trae_model_restore_unverified');
        }
      }
      delete state.entries[model];
      state.pending = null;
      save();
    }

    // A credential-free revision lets the open client invalidate its own cache.
    const revision = createHash('sha256')
      .update(JSON.stringify(remote.map((entry) => [entry.id, fingerprint(entry)]).sort()))
      .digest('hex');
    const result = {
      state: connected ? 'synced' : 'disconnected',
      models: desired.length,
      warnings,
      revision,
      updatedAt: now(),
      origin: originHost(api),
    };
    writeJsonAtomic(paths.status, result);
    return result;
  });
}

/**
 * Background poller.
 * A tick runs when the control file changed, or 60 s passed since the last check.
 * Failures are deduplicated, whitelisted and written as
 * `{state:'pending', code, updatedAt}`; `sync_busy` is silent.
 * @param {SyncOptions} [options]
 * @returns {{ready: Promise<void>, stop: () => Promise<void>}}
 */
export function startModelSync(options = {}) {
  let busy = null;
  let stopped = false;
  let lastCode = '';
  let previous = '';
  let checkedAt = 0;
  const now = options.now ?? (() => new Date().toISOString());

  const tick = () => {
    if (stopped || busy) return busy;
    const paths = options.paths ?? syncPaths();
    let content = '';
    try {
      content = readFileSync(paths.control, 'utf8');
    } catch {
      content = '';
    }
    if (content === previous && Date.now() - checkedAt < LIMITS.syncIdleSkipMs) return busy;
    checkedAt = Date.now();
    busy = syncModels(options)
      .then(() => {
        lastCode = '';
        previous = content;
      })
      .catch((error) => {
        const message = typeof error?.code === 'string' && error.code ? error.code : text(error?.message);
        if (message === 'sync_busy') return;
        const code = /^[a-z][a-z0-9_]*$/.test(message) ? message : 'trae_sync_failed';
        if (code !== lastCode) {
          console.error(`Trae model sync: ${code}`);
          lastCode = code;
        }
        try {
          writeJsonAtomic(paths.status, { state: 'pending', code, updatedAt: now() });
        } catch {
          /* Leave recoverable state alone. */
        }
      })
      .finally(() => {
        busy = null;
      });
    return busy;
  };

  const ready = Promise.resolve(tick()).then(() => undefined, () => undefined);
  const timer = setInterval(tick, options.interval ?? LIMITS.syncIntervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    ready,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await busy;
    },
  };
}