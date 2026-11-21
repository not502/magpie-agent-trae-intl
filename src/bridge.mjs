// Loopback HTTP bridge for Trae's native custom-model client. Owner: implementer A.
//
// Contract: docs/design/interfaces.md §8.
// The bridge trusts only `connection.json`: it never talks to Trae's cloud, never
// derives keys and never reads the Trae session. Its whole job is to re-originate
// a chat-completions request towards the local Magpie gateway.

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { pipeline } from 'node:stream';
import {
  BRIDGE_HOST,
  BRIDGE_NAME,
  DEFAULT_PORT,
  LIMITS,
  LOCAL_TOKEN,
  PRODUCT,
  STATUS_STATES,
} from './constants.mjs';
import { resolvePaths } from './paths.mjs';
import { credentialMode, decodeCredential, readNativeCredentialProfile } from './credential.mjs';

export { DEFAULT_PORT, LOCAL_TOKEN };

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_GATEWAY_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const HOST_HEADER = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/;
const CONVERSATION = /^[A-Za-z0-9_.:-]{1,200}$/;
const NATIVE_ENVELOPE = /^[A-Za-z0-9+/]{40,}={0,2}$/;
const PRINTABLE_KEY = /^[\x21-\x7e]+$/;
const MACHINE_CODE = /^[a-z][a-z0-9_]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ROUTES = new Set(['/v1/models', '/v1/chat/completions']);
const USER_AGENT = `${PRODUCT.name}/${PRODUCT.version}`;

/**
 * @typedef {object} BridgeOptions
 * @property {string} [file]              connection.json path (default: resolvePaths().connection).
 * @property {number} [port]              Listen port; default DEFAULT_PORT.
 * @property {number} [maxBodyBytes]      Default LIMITS.maxBodyBytes.
 * @property {number} [upstreamTimeoutMs] Default LIMITS.upstreamIdleTimeoutMs (idle, not total).
 * @property {(event: object) => void} [onRequest] Metrics callback; exceptions are swallowed.
 * @property {boolean} [exposeModels]     Include model ids/names in unauthenticated /health. Default false.
 * @property {(value: string) => (string|null)} [decodeLocalToken] Optional native-envelope decoder.
 */

/**
 * @typedef {object} Bridge
 * @property {import('node:http').Server} server
 * @property {() => Promise<import('node:net').AddressInfo>} listen
 * @property {() => Promise<void>} close
 */

/**
 * connection.json path (single source of truth is resolvePaths).
 * @param {string} [home]
 * @returns {string}
 */
export function connectionPath(home) {
  if (typeof home === 'string' && home.length > 0) {
    return resolvePaths({ HOME: home, USERPROFILE: home }).connection;
  }
  return resolvePaths().connection;
}

function machineError(code) {
  return Object.assign(new Error(code), { code });
}

function json(res, status, data) {
  if (res.destroyed || res.headersSent) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function fail(res, status, message) {
  json(res, status, { error: { type: 'magpie_trae_error', message } });
}

function rejectionMessage(status) {
  switch (status) {
    case 400:
      return 'The request body is not a valid chat completion request.';
    case 401:
      return 'The local bridge marker is invalid.';
    case 403:
      return 'The bridge accepts only local clients without browser origins.';
    case 404:
      return 'The requested endpoint or model is not available.';
    case 405:
      return 'Method not allowed.';
    case 413:
      return 'The request body is too large.';
    case 502:
      return 'The Magpie gateway could not complete the request.';
    case 503:
      return 'Trae is not connected to a local Magpie gateway.';
    default:
      return 'The local bridge could not complete the request.';
  }
}

function deny(res, status, code) {
  fail(res, status, rejectionMessage(status));
  return code;
}

/**
 * Normalize sync-status.json for /health. Never returns file contents beyond the
 * documented fields, and never throws.
 * @param {string} file
 */
function readSyncStatus(file) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { state: 'pending', code: 'sync_status_unavailable' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { state: 'pending', code: 'sync_status_unavailable' };
  }
  const out = { state: STATUS_STATES.includes(value.state) ? value.state : 'unknown' };
  if (Number.isInteger(value.models) && value.models >= 0) out.models = value.models;
  if (typeof value.code === 'string' && MACHINE_CODE.test(value.code)) out.code = value.code;
  if (typeof value.revision === 'string' && SHA256.test(value.revision)) out.revision = value.revision;
  if (typeof value.updatedAt === 'string') out.updatedAt = value.updatedAt;
  out.warnings = Array.isArray(value.warnings)
    ? value.warnings
        .slice(0, 50)
        .filter(warning => warning && typeof warning.model === 'string' && typeof warning.code === 'string')
        .map(warning => ({ model: warning.model, code: warning.code }))
    : [];
  return out;
}

/**
 * Validate connection.json. Any deviation is reported as one generic 503; no
 * path, key or URL fragment may appear in the client-visible message.
 * @param {string} file
 * @param {number} bridgePort
 * @param {number} maxBytes
 */
function readConnection(file, bridgePort, maxBytes) {
  let raw;
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error();
    if (fs.statSync(file).size > maxBytes) throw new Error();
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw machineError('trae_connection_unavailable');
  }
  let control;
  try {
    control = JSON.parse(raw);
  } catch {
    throw machineError('trae_connection_unavailable');
  }
  if (
    !control ||
    typeof control !== 'object' ||
    Array.isArray(control) ||
    control.version !== 2 ||
    !Array.isArray(control.models) ||
    typeof control.gatewayKey !== 'string' ||
    !PRINTABLE_KEY.test(control.gatewayKey)
  ) {
    throw machineError('trae_connection_invalid');
  }
  for (const model of control.models) {
    if (!model || typeof model !== 'object' || typeof model.id !== 'string' || model.id.trim() === '') {
      throw machineError('trae_connection_invalid');
    }
  }
  let url;
  try {
    url = new URL(control.baseURL);
  } catch {
    throw machineError('trae_connection_invalid');
  }
  const defaultPort = url.protocol === 'https:' ? 443 : 80;
  const port = Number(url.port || defaultPort);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !LOOPBACK_GATEWAY_HOSTS.has(url.hostname) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.pathname.replace(/\/$/, '') !== '/v1' ||
    port === bridgePort
  ) {
    throw machineError('trae_connection_invalid');
  }
  url.pathname = '/v1/chat/completions';
  return { gatewayKey: control.gatewayKey, models: control.models, url };
}

function readMode() {
  try {
    const mode = credentialMode();
    return mode === 'plaintext' ? 'plaintext' : 'native';
  } catch {
    return 'native';
  }
}

function bearerValue(header) {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match ? match[1] : null;
}

function makeDefaultDecoder() {
  let attempted = false;
  let profile = null;
  return value => {
    // Cheap shape gate: never scan the client DLLs for an obviously invalid value.
    if (typeof value !== 'string' || !NATIVE_ENVELOPE.test(value)) return null;
    if (!attempted) {
      attempted = true;
      try {
        profile = readNativeCredentialProfile();
      } catch {
        profile = null;
      }
    }
    if (!profile) return null;
    try {
      return decodeCredential(value, profile);
    } catch {
      return null;
    }
  };
}

function bodySummary(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let images = 0;
  for (const message of messages) {
    if (!message || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part && part.type === 'image_url') images++;
    }
  }
  return {
    tools: Array.isArray(body.tools) ? body.tools.length : 0,
    images,
  };
}

/**
 * Read a request body up to `limit` bytes.
 * @returns {Promise<Buffer|null>} null when the limit was exceeded (caller sends 413).
 */
async function readBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    return null;
  }
  const chunks = [];
  let length = 0;
  let exceeded = false;
  for await (const chunk of req) {
    if (exceeded) continue;
    length += chunk.length;
    if (length > limit) {
      exceeded = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(chunk);
  }
  if (exceeded) return null;
  return Buffer.concat(chunks);
}

/**
 * Create (but do not listen on) the bridge.
 * Admission order: reject any request carrying an Origin header (403) -> require a
 * loopback socket peer (403) -> require a loopback Host header with a port (403) ->
 * allow GET /health (redacted) -> require the bearer marker (401) -> allow only
 * GET /v1/models and POST /v1/chat/completions (404) -> method check (405) ->
 * validate connection.json (503) -> body/model checks (400/404/413).
 * @param {BridgeOptions} [options]
 * @returns {Bridge}
 */
export function createBridge(options = {}) {
  const {
    file = resolvePaths().connection,
    port = DEFAULT_PORT,
    maxBodyBytes = LIMITS.maxBodyBytes,
    upstreamTimeoutMs = LIMITS.upstreamIdleTimeoutMs,
    onRequest = () => {},
    exposeModels = false,
    decodeLocalToken,
  } = options;

  const statusFile = path.join(path.dirname(file), 'sync-status.json');
  const decodeNative = typeof decodeLocalToken === 'function' ? decodeLocalToken : makeDefaultDecoder();

  let requests = 0;
  let lastRequest = null;
  let received = 0;
  let lastInbound = null;
  let rejected = 0;
  let lastRejection = null;
  const inFlight = new Set();

  const isAuthorized = req => {
    const token = bearerValue(req.headers.authorization);
    if (!token) return false;
    if (token === LOCAL_TOKEN) return true;
    try {
      return decodeNative(token) === LOCAL_TOKEN;
    } catch {
      return false;
    }
  };

  const report = (body, status, started) => {
    const summary = bodySummary(body);
    const event = {
      time: new Date().toISOString(),
      model: body.model,
      status,
      stream: Boolean(body.stream),
      tools: summary.tools,
      images: summary.images,
      durationMs: Date.now() - started,
    };
    if (typeof body.reasoning_effort === 'string') event.reasoningEffort = body.reasoning_effort.slice(0, 24);
    requests++;
    lastRequest = event;
    try {
      onRequest(lastRequest);
    } catch {
      /* Observers never affect requests. */
    }
  };

  const server = http.createServer(async (req, res) => {
    try {
      const pathname = (req.url || '').split('?')[0];

      if (pathname !== '/health') {
        received++;
        const inbound = {
          time: new Date().toISOString(),
          method: req.method,
          route: pathname.slice(0, 200),
          status: null,
        };
        lastInbound = inbound;
        const finish = () => {
          if (inbound.status === null) inbound.status = res.statusCode;
        };
        res.once('finish', finish);
        res.once('close', finish);
      }

      if (Object.hasOwn(req.headers, 'origin')) {
        deny(res, 403);
        return;
      }
      if (!LOOPBACK_PEERS.has(req.socket.remoteAddress)) {
        deny(res, 403);
        return;
      }
      if (!HOST_HEADER.test(String(req.headers.host || ''))) {
        deny(res, 403);
        return;
      }

      if (pathname === '/health') {
        if (req.method !== 'GET') {
          deny(res, 405);
          return;
        }
        const bridgePort = server.address()?.port ?? port;
        let connection = null;
        try {
          connection = readConnection(file, bridgePort, LIMITS.maxConnectionBytes);
        } catch {
          connection = null;
        }
        const health = {
          name: BRIDGE_NAME,
          version: PRODUCT.version,
          connected: Boolean(connection),
          sync: readSyncStatus(statusFile),
          credential: { mode: readMode() },
          requests,
          lastRequest,
          received,
          lastInbound,
          rejected,
          lastRejection,
        };
        if (exposeModels && connection) {
          health.models = connection.models.map(model => ({
            id: model.id,
            name: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
          }));
        }
        json(res, 200, health);
        return;
      }

      if (!isAuthorized(req)) {
        rejected++;
        lastRejection = { time: new Date().toISOString(), status: 401, code: 'local_auth_invalid' };
        deny(res, 401);
        return;
      }
      if (!ROUTES.has(pathname)) {
        deny(res, 404);
        return;
      }
      if (
        (pathname === '/v1/models' && req.method !== 'GET') ||
        (pathname === '/v1/chat/completions' && req.method !== 'POST')
      ) {
        deny(res, 405);
        return;
      }

      const bridgePort = server.address()?.port ?? port;
      let connection;
      try {
        connection = readConnection(file, bridgePort, LIMITS.maxConnectionBytes);
      } catch {
        deny(res, 503);
        return;
      }

      if (pathname === '/v1/models') {
        const data = connection.models.map(model => {
          const entry = {
            id: model.id,
            object: 'model',
            owned_by: 'magpie',
            name: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
            images: Boolean(model.images),
            efforts: Array.isArray(model.efforts) ? model.efforts.filter(value => typeof value === 'string') : [],
          };
          if (typeof model.context === 'number' && model.context > 0) entry.context_length = model.context;
          if (typeof model.output === 'number' && model.output > 0) entry.max_output_tokens = model.output;
          return entry;
        });
        json(res, 200, { object: 'list', data });
        return;
      }

      const encodedBody = await readBody(req, maxBodyBytes);
      if (encodedBody === null) {
        deny(res, 413);
        return;
      }
      let body;
      try {
        body = JSON.parse(encodedBody.toString('utf8'));
      } catch {
        deny(res, 400);
        return;
      }
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        typeof body.model !== 'string' ||
        body.model.length === 0 ||
        !Array.isArray(body.messages)
      ) {
        deny(res, 400);
        return;
      }
      if (!connection.models.some(model => model.id === body.model)) {
        deny(res, 404);
        return;
      }
      if (res.destroyed) return;

      const encoded = Buffer.from(JSON.stringify(body));
      const started = Date.now();
      const headers = {
        authorization: `Bearer ${connection.gatewayKey}`,
        'content-type': 'application/json',
        'content-length': encoded.length,
        'user-agent': USER_AGENT,
        accept: body.stream ? 'text/event-stream' : 'application/json',
      };
      const conversationHeader = req.headers['x-magpie-conversation'];
      const conversation = Array.isArray(conversationHeader) ? conversationHeader[0] : conversationHeader;
      if (typeof conversation === 'string' && CONVERSATION.test(conversation)) {
        headers['x-magpie-conversation'] = conversation;
      }

      const transport = connection.url.protocol === 'https:' ? https : http;
      let reported = false;
      const settle = status => {
        if (reported) return;
        reported = true;
        report(body, status, started);
      };

      const upstream = transport.request(connection.url, { method: 'POST', headers }, response => {
        try {
          if (res.destroyed) {
            response.destroy();
            settle(499);
            return;
          }
          const out = { 'cache-control': 'no-store', 'x-accel-buffering': 'no' };
          for (const name of ['content-type', 'content-encoding', 'retry-after']) {
            if (response.headers[name]) out[name] = response.headers[name];
          }
          res.writeHead(response.statusCode || 502, out);
          // Raw byte relay: streamed tool arguments, images and usage survive intact.
          pipeline(response, res, error => {
            settle(error ? 499 : response.statusCode || 502);
          });
        } catch {
          response.destroy();
          settle(502);
          if (!res.destroyed && !res.headersSent) fail(res, 502, rejectionMessage(502));
          else if (!res.destroyed) res.destroy();
        }
      });

      inFlight.add(upstream);
      upstream.once('close', () => inFlight.delete(upstream));
      upstream.setTimeout(upstreamTimeoutMs, () => {
        upstream.destroy(machineError('trae_upstream_timeout'));
      });
      upstream.once('error', () => {
        settle(res.destroyed ? 499 : 502);
        if (!res.destroyed && !res.headersSent) fail(res, 502, rejectionMessage(502));
        else if (!res.destroyed) res.destroy();
      });
      res.once('close', () => {
        if (!res.writableFinished) upstream.destroy();
      });
      upstream.end(encoded);
    } catch {
      if (!res.destroyed && !res.headersSent) fail(res, 500, rejectionMessage(500));
      else if (!res.destroyed) res.destroy();
    }
  });

  server.headersTimeout = LIMITS.headersTimeoutMs;
  server.requestTimeout = LIMITS.requestTimeoutMs;

  return {
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        const onError = error => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve(server.address());
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, BRIDGE_HOST);
      }),
    close: () =>
      new Promise(resolve => {
        for (const upstream of inFlight) upstream.destroy();
        inFlight.clear();
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/**
 * Start the resident host and retry on listen failure (including EADDRINUSE)
 * every LIMITS.bridgeRetryMs. A successful server is unref()'d.
 * @param {BridgeOptions & { retryMs?: number }} [options]
 * @returns {{ready: Promise<void>, stop: () => Promise<void>}}
 * @throws {Error} `trae_bridge_port_invalid` for a non-integer/out-of-range port.
 */
export function startHost(options = {}) {
  const port = options.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw machineError('trae_bridge_port_invalid');
  const retryMs = Number.isInteger(options.retryMs) && options.retryMs > 0 ? options.retryMs : LIMITS.bridgeRetryMs;

  let bridge;
  let retry;
  let warned = false;
  let stopped = false;
  let resolveReady;
  let settled = false;
  const ready = new Promise(resolve => {
    resolveReady = resolve;
  });
  const settle = () => {
    if (settled) return;
    settled = true;
    resolveReady();
  };

  const attempt = async () => {
    if (stopped) return;
    try {
      bridge = createBridge({ ...options, port });
      await bridge.listen();
      if (stopped) {
        await bridge.close();
        settle();
        return;
      }
      bridge.server.unref();
      settle();
    } catch (error) {
      if (!warned && error?.code !== 'EADDRINUSE') {
        warned = true;
        process.stderr.write('magpie-trae-intl: local bridge could not listen; will retry.\n');
      }
      if (!stopped) {
        retry = setTimeout(attempt, retryMs);
        retry.unref?.();
      }
    }
  };

  void attempt();

  return {
    ready,
    stop: async () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      retry = undefined;
      await bridge?.close();
      settle();
    },
  };
}
