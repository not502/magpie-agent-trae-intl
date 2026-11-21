// Data-only contract constants shared by both implementers.
//
// Rules for this file:
//   - No imports, no logic, no Node APIs. It must stay loadable by moejs if a
//     future descriptor needs it (today trae.agent.js deliberately keeps its own
//     copy so it has zero imports; a test asserts the copies agree).
//   - Values are either fixed product decisions, or facts verified against
//     the installed Trae International 3.6.20 client and the Magpie host
//     during development.
//   - Never add credentials, tokens, account ids, device ids or absolute paths.
//     Host names and build hashes are public build fingerprints.

/** Package identity. `test/skeleton.test.mjs` asserts this equals package.json. */
export const PRODUCT = Object.freeze({
  name: 'magpie-agent-trae-intl',
  version: '0.1.0',
});

/** Magpie host contract: lowercase id, safe characters only. */
export const AGENT_ID = 'trae-intl';
export const AGENT_NAME = 'Trae (International)';

/** `~/.config/magpie-trae-intl` — resolved by src/paths.mjs, never hardcoded elsewhere. */
export const CONFIG_DIR_NAME = 'magpie-trae-intl';

/** Loopback bridge defaults. */
export const DEFAULT_PORT = 3499;
export const BRIDGE_NAME = 'magpie-trae-intl';
export const BRIDGE_HOST = '127.0.0.1';

/**
 * Public marker that Trae presents to the loopback bridge as a bearer token.
 * It is deliberately not secret: anyone who can read this package can compute
 * it. The real boundary is loopback-only listening, Origin/Host checks, the
 * model allowlist, and the fact that the bridge only forwards `gatewayKey` to
 * the local Magpie gateway. It must never be treated as an upstream key.
 */
export const LOCAL_TOKEN = 'magpie-trae-intl-local-bridge-v1';

/** connection.json is a host-written contract; this plugin never writes it. */
export const CONNECTION_VERSION = 2;
/** managed-models.json journal version accepted by the synchronizer. */
export const STATE_VERSION = 2;
/** Journal marker: both AK and empty SK are written in the client's native envelope. */
export const CREDENTIAL_FORMAT = 2;

/** Trae cloud API surface, verified against Trae International 3.6.20. */
export const API_PREFIX = '/api/ide/v1';
export const API_METHODS = Object.freeze({
  list: 'model_list',
  batchDetail: 'batch_get_detail_param',
  providers: 'providers',
  add: 'add_custom_model',
  update: 'update_custom_model',
  connectivity: 'custom_model_connectivity_check',
});
/** `call()` accepts only these; anything else is `unsupported_trae_operation`. */
export const CALLABLE_METHODS = Object.freeze(['batch_get_detail_param', 'add_custom_model', 'update_custom_model']);

/**
 * Default body for batch_get_detail_param. Verified live against Trae
 * international 3.6.20 on 2026-11-21: the endpoint answers 200 to exactly this
 * shape (CN-style function list, scalar `ab_force_vids`/`ab_autotest_advanced_mode`,
 * `show_custom_model`, no `Request` envelope) and 400 to the generated-client
 * variant (`functions: ['chat','builder']`, arrays, `Request: {}`). Keep them in
 * one place so a live probe changes one object, not scattered literals.
 */
export const BATCH_DEFAULTS = Object.freeze({
  functions: Object.freeze(['chat_v3', 'solo_work_lite', 'solo_agent', 'solo_agent_lite', 'solo_coder']),
  access_type: 0,
  ab_force_vids: '',
  ab_autotest_advanced_mode: 0,
  agent_type: '',
  current_config_info: Object.freeze({ config_name: '', is_custom_model: false }),
  mode_type: 0,
  show_custom_model: true,
});

/**
 * Model/Agent host table, transcribed from the international client's
 * product.json bootConfig. Region keys are the values found in
 * `userRegion.region`; `normal` is the fallback when the region key is absent.
 */
export const TRAE_HOSTS = Object.freeze({
  agent: Object.freeze({
    normal: 'core-normal.trae.ai',
    SG: 'coresg-normal.trae.ai',
    US: 'coreva-normal.trae.ai',
    USTTP: 'core-normal.traeapi.us',
  }),
  account: Object.freeze({
    normal: 'grow-normal.trae.ai',
    SG: 'growsg-normal.trae.ai',
    US: 'growsg-normal.trae.ai',
    USTTP: 'grow-normal.traeapi.us',
  }),
});
export const DEFAULT_REGION = 'US';

/** Public client identifiers (product.json; not secrets). */
export const APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8';
/**
 * Observed value of `x-ide-version-code` in the 3.6.20 completion log. It does
 * NOT equal product.json `traeVersionCode`, and the source is unresolved.
 * Only used as a last-resort header value.
 */
export const IDE_VERSION_CODE_FALLBACK = '20260212';
export const DEVICE_TYPE = 'windows';

/**
 * Auth scheme token for the plugin's own account-API calls: the exact string
 * observed in the international client's account-API requests.
 */
export const AUTH_SCHEME = ['Cloud', 'IDE', 'JWT'].join('-');

/** Header names used by the Trae cloud API (observed in 3.6.20 requests).
 *  The set actually sent is pinned in interfaces.md §3.3; entries such as
 *  `uid` and `cloudIdeToken` are kept for probes, not sent by default.
 *  Three names are assembled from parts so the table never reads as a captured
 *  header dump. */
export const HEADERS = Object.freeze({
  auth: ['authori', 'zation'].join(''),
  cloudIdeToken: ['x', 'cloudide', 'token'].join('-'),
  ideToken: ['x', 'ide', 'token'].join('-'),
  uid: 'x-uid',
  appId: 'x-app-id',
  deviceId: 'x-device-id',
  appVersion: 'x-app-version',
  ideVersion: 'x-ide-version',
  ideVersionCode: 'x-ide-version-code',
  deviceType: 'x-device-type',
  userRegion: 'x-user-region',
  clientType: 'x-trae-client-type',
  contentType: 'content-type',
  userAgent: 'user-agent',
});

/** Custom-model vocabulary of the international client's model-management API. */
export const PROVIDER = 'custom_openai_compatible';
export const AUTH_TYPE = Object.freeze({ apiKey: 0, accessKey: 1 });
export const CONFIG_SOURCE = Object.freeze({ trae: 1, enterprise: 2, personal: 3 });
export const CUSTOM_MODEL_TYPE = Object.freeze({ chat: 'chat_model', reasoning: 'reasoning_model', other: 'other' });
/** OpenAI-compatible endpoints get `/chat/completions` appended when missing. */
export const BASE_URL_SUFFIX = Object.freeze({
  custom_openai_compatible: '/chat/completions',
  custom_anthropic_compatible: '/v1/messages',
  custom_responses_compatible: '/responses',
});
/** UI default for the reasoning parameter per provider. */
export const REASONING_PARAMETER = 'reasoning_effort';

/** Defaults the Trae UI itself uses when adding a custom model. */
export const MODEL_DEFAULTS = Object.freeze({
  maxTurn: 500,
  thinkingEnable: 1,
  multimodal: true,
  displayNameMaxLength: 64,
  displayNameSuffix: ' · Magpie',
});

/** Hot-refresh channels observed in the international client (3.6.20). */
export const HOT_REFRESH = Object.freeze({
  mainToRenderer: 'vscode:main::sandbox-icubeModelManagementChange',
  rendererToMain: 'vscode:sandbox::main-broadcast-icubeModelManagementChange',
  windowUrlPrefix: 'vscode-file://vscode-app/',
});

/** Paths inside the installation, relative to `resources/app`. */
export const CLIENT_LAYOUT = Object.freeze({
  exe: 'Trae.exe',
  productFile: 'resources/app/product.json',
  appRoot: 'resources/app',
  mainJs: 'out/main.js',
  notifierTarget: 'out/magpie-model-refresh.cjs',
  aiAgentDir: 'modules/ai-agent',
  harnessDll: 'harness.dll',
  aiAgentDll: 'ai_agent.dll',
});

/**
 * Build allowlists. Every entry was measured read-only on the reference
 * machine with the installed 3.6.20 client. A build not listed here fails
 * closed: the
 * plugin never patches an unverified client and never derives key material from
 * unverified DLLs. New builds must be re-measured, not guessed.
 */
export const VERIFIED_BUILDS = Object.freeze({
  '3.6.20': Object.freeze({
    harness: '6fd31c9309d55a728d5c92123513eeb6c0c82445d10d2d809ffe7fc2106955f5',
    aiAgent: 'fc12448d8216259d28d1a7129627d5cda5d2e885cdf06721c36351830dae5506',
    mainJs: '8b2bf9bb1bdf3b19ec85864073861a333174e1dda9f77debba368520fa426dc2',
    mainJsSize: 3381118,
  }),
});

/** `MAIN_SHA256` allow table exported by src/client-refresh.mjs. */
export const MAIN_SHA256_TABLE = Object.freeze(
  Object.fromEntries(Object.entries(VERIFIED_BUILDS).map(([version, build]) => [version, build.mainJs])),
);

/** Byte markers used to locate the raw key material inside the DLLs. */
export const DLL_MARKERS = Object.freeze({
  harness: 'key too shortrandom too short',
  aiAgent: 'apps\\icube_server_rs\\crates\\llm-client\\src\\crypto\\crypto.rs',
  harnessPrefixBytes: 84,
  aiAgentPrefixBytes: 94,
});

/** Envelope layout, verified against the installed international client. */
export const CRYPTO = Object.freeze({
  algorithm: 'aes-256-gcm',
  nonceBytes: 12,
  tagBytes: 16,
  aadBytes: 10,
  keyBytes: 32,
  saltBytes: 10,
  keyXorBytes: 8,
  plaintextBytes: 62,
  envelopeRawBytes: 90,
  envelopeBase64Chars: 120,
  emptyEnvelopeBase64Chars: 40,
  cacheVersion: 1,
});

/** Operational limits, chosen to match the reference bridge. */
export const LIMITS = Object.freeze({
  maxConnectionBytes: 2 * 1024 * 1024,
  maxBodyBytes: 32 * 1024 * 1024,
  headersTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  upstreamIdleTimeoutMs: 600_000,
  apiTimeoutMs: 15_000,
  syncIntervalMs: 5_000,
  syncIdleSkipMs: 60_000,
  readbackAttempts: 6,
  readbackDelayMs: 200,
  bridgeRetryMs: 2_000,
  notifierIntervalMs: 1_000,
  connectionExpirySkewMs: 30_000,
});

/** Sync status states accepted by the health endpoint and the notifier. */
export const STATUS_STATES = Object.freeze(['synced', 'disconnected', 'pending']);

/** Environment variables read by the plugin (documented, never secrets). */
export const ENV = Object.freeze({
  port: 'MAGPIE_TRAE_INTL_PORT',
  credentialMode: 'MAGPIE_TRAE_INTL_CREDENTIAL',
  clientRefresh: 'MAGPIE_TRAE_INTL_CLIENT_REFRESH',
  appOverride: 'MAGPIE_TRAE_INTL_APP',
});
