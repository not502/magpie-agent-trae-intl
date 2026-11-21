// Path resolution. Owner: implementer A (runtime/bridge).
//
// Contract: docs/design/interfaces.md §2. Every path the plugin touches is
// derived here; no other module may join config-dir names by hand. Discovery is
// read-only: the registry is queried through the built-in `reg.exe`, never
// modified, and candidate paths are validated before use.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  APP_ID,
  CONFIG_DIR_NAME,
  ENV,
  IDE_VERSION_CODE_FALLBACK,
  TRAE_HOSTS,
} from './constants.mjs';

/** Package root, derived from this module's URL (never hardcoded). */
const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const REGION_KEYS = Object.freeze(['normal', 'SG', 'US', 'USTTP']);
const EXPECTED_APPLICATION_NAME = 'trae';
const EXPECTED_PROVIDER_CODE = 'i18n';
const EXPECTED_PACKAGE_TYPE = 'TRAE_I18N';

const UNINSTALL_ROOTS = Object.freeze([
  ['HKCU', 'Software', 'Microsoft', 'Windows', 'CurrentVersion', 'Uninstall'],
  ['HKLM', 'Software', 'Microsoft', 'Windows', 'CurrentVersion', 'Uninstall'],
  ['HKLM', 'Software', 'WOW6432Node', 'Microsoft', 'Windows', 'CurrentVersion', 'Uninstall'],
]);

/**
 * @typedef {object} PluginPaths
 * @property {string} home        User home directory (no trailing separator).
 * @property {string} configDir   `<home>/.config/magpie-trae-intl` (fixed; host-written).
 * @property {string} connection  Host-written connection.json (read-only for this plugin).
 * @property {string} state       managed-models.json recovery journal.
 * @property {string} credential  local-credential.json encoded loopback marker.
 * @property {string} lock        model-sync.lock cross-process mutex.
 * @property {string} status      sync-status.json diagnostic revision.
 * @property {string} clientRefreshStatus client-refresh-status.json notifier receipts.
 * @property {string} clientBackups `client-backups/` per-version originals + manifest.
 * @property {string} notifier    Absolute path of the packaged refresh-notifier.cjs.
 * @property {string} restore     Absolute path of restore.mjs.
 */

/**
 * @typedef {object} DataDirs
 * @property {string} home        Resolved user home.
 * @property {string} roaming     `%APPDATA%/Trae` (Trae's user data root).
 * @property {string} data        `~/.trae` (Trae's extension/user data root).
 * @property {string} globalStorage `<roaming>/User/globalStorage`.
 * @property {string} storage     `<globalStorage>/storage.json`.
 */

/**
 * @typedef {object} AppLocation
 * @property {string} appDir      `<install>/resources/app`.
 * @property {string} installDir  `<install>`.
 * @property {string} exe         `<install>/Trae.exe`.
 * @property {string} productFile `<install>/resources/app/product.json`.
 * @property {'env'|'registry'|'fallback'} source How the directory was found.
 * @property {string[]} rejected  Candidate directories rejected by validation (no path values in logs).
 */

/**
 * @typedef {object} Product
 * @property {string} appVersion       e.g. "3.6.20" (never product.json `version`).
 * @property {string} vscodeVersion
 * @property {string} providerCode     Must be "i18n"; anything else is `trae_product_not_international`.
 * @property {string} packageType      Expected "TRAE_I18N".
 * @property {string} quality
 * @property {string} dataFolderName   e.g. ".trae".
 * @property {string} traeVersionCode
 * @property {string} ideVersionCode   Header value; falls back to IDE_VERSION_CODE_FALLBACK when absent.
 * @property {string} agentAppId
 * @property {Readonly<Record<string, Readonly<Record<string,string>>>>} hosts `agent` and `account` region tables.
 * @property {string} appDir
 * @property {string} productFile
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
 * Resolve the user home directory. Order: USERPROFILE, HOME, os.homedir().
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
function resolveHome(env) {
  let home;
  try {
    home = env.USERPROFILE || env.HOME || os.homedir();
  } catch {
    home = env.USERPROFILE || env.HOME;
  }
  if (!nonEmptyString(home)) throw failure('trae_home_unavailable');
  if (!path.isAbsolute(home)) throw failure('trae_home_invalid');
  return path.resolve(home);
}

/**
 * Resolve the plugin's configuration paths.
 * @param {Record<string, string | undefined>} [env] Injectable environment (defaults to process.env).
 * @returns {PluginPaths}
 * @throws {Error} `trae_home_unavailable` when no home is available;
 *   `trae_home_invalid` when a configured path is not absolute.
 */
export function resolvePaths(env = process.env) {
  const home = resolveHome(env);
  // The connection file is written by the Magpie host at the fixed path in the
  // agent descriptor (which cannot read environment variables), so this path is
  // deliberately not overridable: letting it move would make the bridge read a
  // directory the host never writes.
  const configDir = path.join(home, '.config', CONFIG_DIR_NAME);
  return {
    home,
    configDir,
    connection: path.join(configDir, 'connection.json'),
    state: path.join(configDir, 'managed-models.json'),
    credential: path.join(configDir, 'local-credential.json'),
    lock: path.join(configDir, 'model-sync.lock'),
    status: path.join(configDir, 'sync-status.json'),
    clientRefreshStatus: path.join(configDir, 'client-refresh-status.json'),
    clientBackups: path.join(configDir, 'client-backups'),
    notifier: path.join(PACKAGE_ROOT, 'src', 'refresh-notifier.cjs'),
    restore: path.join(PACKAGE_ROOT, 'restore.mjs'),
  };
}

/**
 * Trae user-data locations: `%APPDATA%/Trae` and `~/.trae`.
 * The storage.json path is the only login-state file this plugin reads.
 * @param {Record<string, string | undefined>} [env]
 * @returns {DataDirs}
 * @throws {Error} `trae_home_unavailable` | `trae_home_invalid`
 */
export function resolveDataDirs(env = process.env) {
  const home = resolveHome(env);
  const appData = nonEmptyString(env.APPDATA) && path.isAbsolute(env.APPDATA)
    ? env.APPDATA
    : path.join(home, 'AppData', 'Roaming');
  const roaming = path.join(appData, 'Trae');
  const globalStorage = path.join(roaming, 'User', 'globalStorage');
  return {
    home,
    roaming,
    data: path.join(home, '.trae'),
    globalStorage,
    storage: path.join(globalStorage, 'storage.json'),
  };
}

/** Strip quotes/whitespace/trailing separators from a registry value. */
function cleanCandidate(value) {
  return value.trim().replace(/^"+|"+$/g, '').replace(/[\\/]+$/, '');
}

/** True when `file` exists and is a regular file. */
function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Map a candidate (install dir or `resources/app`) to concrete layout paths.
 * @param {string} candidate
 * @returns {{appDir:string, installDir:string, exe:string, productFile:string}}
 */
function layoutOf(candidate) {
  const resolved = path.resolve(cleanCandidate(candidate));
  if (path.basename(resolved).toLowerCase() === 'app'
    && path.basename(path.dirname(resolved)).toLowerCase() === 'resources') {
    const installDir = path.dirname(path.dirname(resolved));
    return {
      appDir: resolved,
      installDir,
      exe: path.join(installDir, 'Trae.exe'),
      productFile: path.join(resolved, 'product.json'),
    };
  }
  const appDir = path.join(resolved, 'resources', 'app');
  return {
    appDir,
    installDir: resolved,
    exe: path.join(resolved, 'Trae.exe'),
    productFile: path.join(appDir, 'product.json'),
  };
}

/**
 * Validate one candidate directory. Throws when any check fails.
 * Checks: Trae.exe is a file, product.json parses, applicationName is "trae",
 * providerCode is "i18n", and packageType (when present) is "TRAE_I18N".
 * @param {{appDir:string, installDir:string, exe:string, productFile:string}} layout
 */
function validateLayout(layout) {
  if (!isFile(layout.exe)) throw failure('trae_installation_unavailable');
  if (!isFile(layout.productFile)) throw failure('trae_installation_unavailable');
  let product;
  try {
    product = JSON.parse(fs.readFileSync(layout.productFile, 'utf8'));
  } catch {
    throw failure('trae_product_unreadable');
  }
  if (!product || typeof product !== 'object' || Array.isArray(product)) throw failure('trae_product_unreadable');
  if (String(product.applicationName ?? '').toLowerCase() !== EXPECTED_APPLICATION_NAME) {
    throw failure('trae_product_not_international');
  }
  if (product.providerCode !== EXPECTED_PROVIDER_CODE) throw failure('trae_product_not_international');
  if (product.packageType !== undefined && product.packageType !== EXPECTED_PACKAGE_TYPE) {
    throw failure('trae_product_not_international');
  }
  if (!nonEmptyString(product.appVersion)) throw failure('trae_product_unreadable');
}

/**
 * Parse `reg.exe query ... /s /v DisplayName` output and return subkeys whose
 * DisplayName mentions TRAE. Output parsing is line-based and tolerant of a
 * non-UTF-8 console code page: only ASCII names matter here.
 * @param {string} output
 * @returns {string[]}
 */
function parseTraeUninstallKeys(output) {
  const keys = [];
  let current = '';
  let displayName = '';
  const flush = () => {
    if (current && displayName && /TRAE/i.test(displayName)) keys.push(current);
    current = '';
    displayName = '';
  };
  for (const line of output.split(/\r?\n/)) {
    const keyMatch = line.match(/^(HKEY_[^\r\n]+)$/);
    if (keyMatch) {
      flush();
      current = keyMatch[1].trim();
      continue;
    }
    const valueMatch = line.match(/^\s*DisplayName\s+REG_\w+\s+(.*)$/);
    if (valueMatch) displayName = valueMatch[1].trim();
  }
  flush();
  return keys;
}

/** Extract a named string value from `reg.exe query` output. */
function parseRegValue(output, name) {
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`));
    if (match) return match[1].trim();
  }
  return '';
}

/**
 * Read uninstall entries from HKCU/HKLM/WOW6432Node and return their
 * InstallLocation values. Any failure (reg.exe missing, access denied, malformed
 * output) is swallowed so discovery continues with the next source.
 * @returns {string[]}
 */
function registryInstallLocations() {
  const separator = String.fromCharCode(92);
  const locations = [];
  for (const parts of UNINSTALL_ROOTS) {
    const root = parts.join(separator);
    let listing;
    try {
      listing = execFileSync('reg.exe', ['query', root, '/s', '/v', 'DisplayName'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      continue;
    }
    for (const key of parseTraeUninstallKeys(listing)) {
      let value;
      try {
        value = execFileSync('reg.exe', ['query', key, '/v', 'InstallLocation'], {
          encoding: 'utf8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        continue;
      }
      const location = parseRegValue(value, 'InstallLocation');
      if (nonEmptyString(location)) locations.push(cleanCandidate(location));
    }
  }
  return [...new Set(locations)];
}

/**
 * Environment-provided install candidates. `MAGPIE_TRAE_INTL_APP` is the
 * documented override (interfaces §2.2); `TRAE_APP_DIR` / `TRAE_INSTALL_DIR` are
 * accepted as compatibility aliases for the same purpose.
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
function environmentCandidates(env) {
  return [ENV.appOverride, 'TRAE_APP_DIR', 'TRAE_INSTALL_DIR']
    .map((name) => env[name])
    .filter(nonEmptyString);
}

/**
 * Documented fallback directories, each expanded only through the injected env.
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
function fallbackCandidates(env) {
  const candidates = [];
  if (nonEmptyString(env.LOCALAPPDATA)) candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'Trae'));
  if (nonEmptyString(env.ProgramFiles)) candidates.push(path.join(env.ProgramFiles, 'Trae'));
  if (nonEmptyString(env['ProgramFiles(x86)'])) candidates.push(path.join(env['ProgramFiles(x86)'], 'Trae'));
  return [...new Set(candidates)];
}

/**
 * Locate the Trae (International) installation.
 * Order: env override(s) -> Windows uninstall registry -> documented fallback dirs.
 * Validation: `<install>/Trae.exe` exists, product.json parses, applicationName is
 * "trae", providerCode is "i18n".
 * @param {Record<string, string | undefined>} [env]
 * @param {{ platform?: NodeJS.Platform, registry?: () => string[] }} [options]
 *   `registry` is injectable so tests never read the real registry.
 * @returns {AppLocation}
 * @throws {Error} `trae_installation_unavailable` | `trae_platform_unsupported`.
 */
export function resolveAppDir(env = process.env, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') throw failure('trae_platform_unsupported');
  const registry = options.registry ?? registryInstallLocations;
  const rejected = [];
  const candidates = [];
  for (const candidate of environmentCandidates(env)) candidates.push({ candidate, source: 'env' });
  let registryCandidates = [];
  try {
    const listed = registry();
    if (Array.isArray(listed)) registryCandidates = listed;
  } catch {
    registryCandidates = [];
  }
  for (const candidate of registryCandidates) candidates.push({ candidate, source: 'registry' });
  for (const candidate of fallbackCandidates(env)) candidates.push({ candidate, source: 'fallback' });

  for (const { candidate, source } of candidates) {
    if (!nonEmptyString(candidate)) continue;
    let layout;
    try {
      layout = layoutOf(candidate);
      validateLayout(layout);
    } catch {
      try {
        rejected.push(layout ? layout.appDir : cleanCandidate(String(candidate)));
      } catch {
        rejected.push('<invalid>');
      }
      continue;
    }
    return { ...layout, source, rejected };
  }
  throw failure('trae_installation_unavailable');
}

/** Convert a bootConfig host value to a bare hostname (no scheme/path). */
function hostOnly(value) {
  if (!nonEmptyString(value)) return '';
  let text = value.trim();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = new URL(text).host;
  } catch {
    return '';
  }
  const host = text.split('/')[0].trim();
  return host;
}

/**
 * Normalize one bootConfig region table. `bootConfig.agent` nests the table
 * under `trae`; older/other shapes may already be flat. Missing entries fall
 * back to `TRAE_HOSTS`; only the four documented region keys are kept.
 * @param {unknown} table
 * @param {Readonly<Record<string,string>>} fallback
 */
function normalizeHosts(table, fallback) {
  const source = table && typeof table === 'object' && !Array.isArray(table)
    ? (table.trae && typeof table.trae === 'object' ? table.trae : table)
    : {};
  const hosts = {};
  for (const key of REGION_KEYS) {
    const value = hostOnly(source[key]);
    hosts[key] = value || fallback[key];
  }
  return Object.freeze(hosts);
}

/**
 * Read and normalize product.json.
 * @param {string} appDir `<install>/resources/app`.
 * @returns {Product}
 * @throws {Error} `trae_product_unreadable` | `trae_product_not_international`.
 */
export function readProduct(appDir) {
  if (!nonEmptyString(appDir)) throw failure('trae_product_unreadable');
  const productFile = path.join(appDir, 'product.json');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(productFile, 'utf8'));
  } catch {
    throw failure('trae_product_unreadable');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure('trae_product_unreadable');
  if (data.providerCode !== EXPECTED_PROVIDER_CODE) throw failure('trae_product_not_international');
  if (!nonEmptyString(data.appVersion)) throw failure('trae_product_unreadable');
  if (data.packageType !== undefined && data.packageType !== EXPECTED_PACKAGE_TYPE) {
    throw failure('trae_product_not_international');
  }
  const boot = data.bootConfig && typeof data.bootConfig === 'object' ? data.bootConfig : {};
  return {
    appVersion: data.appVersion,
    vscodeVersion: nonEmptyString(data.vscodeVersion) ? data.vscodeVersion
      : (nonEmptyString(data.version) ? data.version : ''),
    providerCode: data.providerCode,
    packageType: nonEmptyString(data.packageType) ? data.packageType : '',
    quality: nonEmptyString(data.quality) ? data.quality : '',
    dataFolderName: nonEmptyString(data.dataFolderName) ? data.dataFolderName : '',
    traeVersionCode: nonEmptyString(data.traeVersionCode) ? data.traeVersionCode : '',
    ideVersionCode: nonEmptyString(data.ideVersionCode) ? data.ideVersionCode : IDE_VERSION_CODE_FALLBACK,
    agentAppId: nonEmptyString(data.agentAppId) ? data.agentAppId
      : (nonEmptyString(boot.agent?.appId) ? boot.agent.appId : APP_ID),
    hosts: {
      agent: normalizeHosts(boot.agent, TRAE_HOSTS.agent),
      account: normalizeHosts(boot.account, TRAE_HOSTS.account),
    },
    appDir,
    productFile,
  };
}

/**
 * Create the configuration directory with mode 0700 (no-op when present).
 * @param {PluginPaths} [paths]
 * @returns {string} The configuration directory.
 * @throws {Error} `sync_file_unreadable` when the directory cannot be created.
 */
export function ensureConfigDir(paths = resolvePaths()) {
  try {
    fs.mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  } catch {
    throw failure('sync_file_unreadable');
  }
  return paths.configDir;
}