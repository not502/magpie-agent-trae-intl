#!/usr/bin/env node
// CLI. Contract + argument semantics: docs/design/interfaces.md §13.
// This is a bin entry: it must not export anything.
//
// Privacy rule: every command prints machine codes, versions, host names and
// booleans only. Tokens, user/device ids, gatewayKey, model ak/sk, full storage
// files and absolute installation paths never reach stdout/stderr.

import fs from 'node:fs';
import path from 'node:path';
import {
  BRIDGE_NAME,
  DEFAULT_PORT,
  DEFAULT_REGION,
  ENV,
  LOCAL_TOKEN,
  MAIN_SHA256_TABLE,
  STATUS_STATES,
  VERIFIED_BUILDS,
} from './src/constants.mjs';
import { createBridge } from './src/bridge.mjs';
import { restoreClient } from './src/client-refresh.mjs';
import { syncModels } from './src/sync.mjs';
import { resolveAppDir, resolvePaths, readProduct } from './src/paths.mjs';
import { readSession } from './src/session.mjs';
import { credentialMode, readNativeCredentialProfile } from './src/credential.mjs';
import { resolveOrigin } from './src/api.mjs';
import { readJson } from './src/state.mjs';

const COMMANDS = ['status', 'models', 'sync', 'doctor', 'setup', 'serve', 'restore-client'];
const MACHINE_CODE = /^[a-z][a-z0-9_]*$/;
const SHA256 = /^[a-f0-9]{64}$/;

function usage(stream = process.stdout) {
  stream.write([
    'Usage: magpie-trae-intl <command> [--port <n>]',
    '',
    '  status          Bridge + catalog sync status',
    '  models          Model catalog (GET /v1/models with the local marker)',
    '  sync            Run one catalog synchronization pass',
    '  doctor          Redacted environment/protocol report (no token, no key)',
    '  setup           Human setup instructions',
    '  serve           Run the loopback bridge in the foreground',
    '  restore-client  Revert the optional client refresh hook',
    '',
    `Port: --port <n> or ${ENV.port}; default ${DEFAULT_PORT}.`,
    '',
  ].join('\n'));
}

function parseArgs(argv) {
  const named = argv[0] && !argv[0].startsWith('-');
  const command = named ? argv[0] : 'status';
  const rest = named ? argv.slice(1) : argv;
  let port = Number(process.env[ENV.port] || DEFAULT_PORT);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--port' && rest[i + 1]) port = Number(rest[++i]);
    else if (rest[i].startsWith('--port=')) port = Number(rest[i].slice(7));
    else if (rest[i] === '--help' || rest[i] === '-h') return { help: true, command, port };
  }
  return { help: false, command, port };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function codeOf(error, fallback = 'trae_cli_failed') {
  const code = error && typeof error.code === 'string' ? error.code : error && typeof error.message === 'string' ? error.message : '';
  return MACHINE_CODE.test(code) ? code : fallback;
}

async function getJson(url, init = {}, timeoutMs = 2000) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  let value;
  try {
    value = await response.json();
  } catch {
    throw Object.assign(new Error('trae_cli_bad_response'), { code: 'trae_cli_bad_response' });
  }
  return { response, value };
}

async function commandStatus(port) {
  try {
    const { response, value } = await getJson(`http://127.0.0.1:${port}/health`);
    if (!response.ok || !value || value.name !== BRIDGE_NAME) throw new Error('trae_bridge_unavailable');
    printJson(value);
    return 0;
  } catch {
    process.stderr.write(`magpie-trae-intl: the local bridge on 127.0.0.1:${port} is not answering.\n`);
    return 1;
  }
}

async function commandModels(port) {
  try {
    const { response, value } = await getJson(`http://127.0.0.1:${port}/v1/models`, {
      headers: { authorization: `Bearer ${LOCAL_TOKEN}` },
    });
    if (!response.ok || !value || !Array.isArray(value.data)) throw new Error('trae_bridge_unavailable');
    printJson(value.data);
    return 0;
  } catch {
    process.stderr.write(`magpie-trae-intl: the local bridge on 127.0.0.1:${port} is not answering.\n`);
    return 1;
  }
}

function sanitizeWarnings(warnings) {
  if (!Array.isArray(warnings)) return [];
  return warnings
    .slice(0, 50)
    .filter(warning => warning && typeof warning === 'object' && typeof warning.model === 'string' && typeof warning.code === 'string')
    .map(warning => ({ model: warning.model, code: warning.code }));
}

function sanitizeSyncResult(result) {
  return {
    state: STATUS_STATES.includes(result?.state) ? result.state : 'unknown',
    models: Number.isInteger(result?.models) && result.models >= 0 ? result.models : 0,
    warnings: sanitizeWarnings(result?.warnings),
    revision: typeof result?.revision === 'string' && SHA256.test(result.revision) ? result.revision : '',
    updatedAt: typeof result?.updatedAt === 'string' ? result.updatedAt : '',
    ...(typeof result?.origin === 'string' && /^[A-Za-z0-9.-]{1,253}$/.test(result.origin) ? { origin: result.origin } : {}),
  };
}

async function commandSync(port) {
  try {
    printJson(sanitizeSyncResult(await syncModels({ port })));
    return 0;
  } catch (error) {
    printJson({ error: codeOf(error, 'trae_sync_failed') });
    return 1;
  }
}

function tryCall(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function readJsonFile(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function clientRefreshState(product, paths) {
  if (!paths || typeof paths.clientBackups !== 'string') return 'off';
  const status = readJsonFile(paths.clientRefreshStatus);
  if (status && status.state === 'unsupported' && typeof status.code === 'string') return 'unsupported';
  if (!product || typeof product.appVersion !== 'string') return 'off';
  if (!Object.hasOwn(MAIN_SHA256_TABLE, product.appVersion)) return 'unsupported';
  const manifest = readJsonFile(path.join(paths.clientBackups, product.appVersion, 'manifest.json'));
  if (manifest && manifest.state === 'installed') return 'installed';
  return 'off';
}

function doctorReport() {
  const paths = tryCall(() => resolvePaths(), null);
  const app = tryCall(() => resolveAppDir(), null);
  const product = app ? tryCall(() => readProduct(app.appDir), null) : null;

  let session = null;
  let sessionCode = null;
  try {
    session = readSession();
  } catch (error) {
    sessionCode = codeOf(error, 'trae_session_unreadable');
  }

  const expiresAtPassed = session
    ? Number.isNaN(Date.parse(session.expiresAt))
      ? false
      : Date.parse(session.expiresAt) <= Date.now()
    : sessionCode === 'trae_sign_in_expired';

  const mode = tryCall(() => credentialMode(), null);
  const profile = tryCall(() => readNativeCredentialProfile(), null);

  let host = null;
  const origin = tryCall(() => resolveOrigin({ session, product }), null);
  if (typeof origin === 'string') {
    try {
      host = new URL(origin).hostname;
    } catch {
      host = null;
    }
  }

  const syncRaw = paths ? tryCall(() => readJson(paths.status, null), null) : null;
  const sync =
    syncRaw && typeof syncRaw === 'object'
      ? {
          state: STATUS_STATES.includes(syncRaw.state) ? syncRaw.state : 'unknown',
          models: Number.isInteger(syncRaw.models) ? syncRaw.models : 0,
          revision: typeof syncRaw.revision === 'string' && SHA256.test(syncRaw.revision) ? syncRaw.revision : '',
        }
      : { state: 'unknown', models: 0, revision: '' };

  return {
    product: {
      appVersion: product?.appVersion ?? null,
      providerCode: product?.providerCode ?? null,
    },
    paths: {
      // Fixed by the agent descriptor; not overridable (README §9).
      config: '~/.config/magpie-trae-intl',
      configSource: 'default',
      appSource: app?.source ?? null,
    },
    region: session?.region ?? DEFAULT_REGION,
    host,
    session: {
      signedIn: Boolean(session),
      expiresAtPassed,
      deviceKeys: session ? 1 : 0,
    },
    credential: {
      mode: mode === 'plaintext' ? 'plaintext' : mode === 'native' ? 'native' : null,
      profileAvailable: Boolean(profile),
      buildAllowed: Boolean(product) && Object.hasOwn(VERIFIED_BUILDS, product.appVersion),
    },
    catalog: 'batch',
    clientRefresh: clientRefreshState(product, paths),
    sync,
  };
}

function commandDoctor() {
  try {
    printJson(doctorReport());
    return 0;
  } catch {
    printJson({ error: 'trae_doctor_failed' });
    return 1;
  }
}

function commandSetup() {
  process.stdout.write([
    'magpie-trae-intl setup',
    '',
    '1. In Magpie, open the Agent page and enable the Trae (International) connection.',
    '2. Keep Magpie running; the plugin synchronizes the model catalog automatically.',
    '3. Restart Trae once after the first installation, then reload the window to see catalog changes.',
    '4. In Trae, select a model whose name ends with " · Magpie".',
    '5. Diagnostics: `magpie-trae-intl status`, `models`, `doctor`; revert the optional client hook with `restore-client`.',
    '',
    '1. 在 Magpie 的 Agent 页面启用 Trae (International) 接入。',
    '2. 保持 Magpie 运行，插件会自动同步模型目录。',
    '3. 首次安装后重启 Trae 一次；之后目录变化只需重新加载窗口。',
    '4. 在 Trae 的模型菜单中选择名称以 " · Magpie" 结尾的模型。',
    '5. 诊断：`magpie-trae-intl status`、`models`、`doctor`；用 `restore-client` 撤销可选的客户端刷新补丁。',
    '',
  ].join('\n'));
  return 0;
}

async function commandServe(port) {
  let bridge;
  try {
    bridge = createBridge({ port });
    const address = await bridge.listen();
    process.stdout.write(`listening on 127.0.0.1:${address?.port ?? port}\n`);
  } catch {
    process.stderr.write('magpie-trae-intl: the local bridge could not listen on the requested port.\n');
    return 1;
  }
  return new Promise(resolve => {
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      try {
        await bridge.close();
      } catch {
        /* Closing is best effort. */
      }
      resolve(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

function commandRestoreClient() {
  try {
    printJson(restoreClient());
    return 0;
  } catch (error) {
    printJson({ error: codeOf(error, 'trae_client_refresh_install_failed') });
    return 1;
  }
}

const { help, command, port } = parseArgs(process.argv.slice(2));

if (help) {
  usage();
} else if (!Number.isInteger(port) || port < 1 || port > 65535) {
  process.stderr.write(`magpie-trae-intl: invalid port "${port}" (expected 1..65535)\n`);
  process.exitCode = 1;
} else if (!COMMANDS.includes(command)) {
  usage(process.stderr);
  process.exitCode = 1;
} else {
  let code;
  switch (command) {
    case 'status':
      code = await commandStatus(port);
      break;
    case 'models':
      code = await commandModels(port);
      break;
    case 'sync':
      code = await commandSync(port);
      break;
    case 'doctor':
      code = commandDoctor();
      break;
    case 'setup':
      code = commandSetup();
      break;
    case 'serve':
      code = await commandServe(port);
      break;
    case 'restore-client':
      code = commandRestoreClient();
      break;
    default:
      code = 1;
  }
  process.exitCode = code;
}
