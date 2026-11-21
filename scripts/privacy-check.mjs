#!/usr/bin/env node
// Privacy gate. Scans every text file in the project for credentials, personal
// data and machine-specific paths.
//
// Two conventions keep this file from flagging itself:
//   - literal prefixes are assembled at runtime (`AUTH_SCHEME`, key prefixes), so
//     the source never contains the exact form the rule rejects;
//   - findings print file, line and rule id only, never the matched text, so a
//     real secret accidentally committed cannot leak further through CI logs.
//
// Fixture policy: an obvious fake value is allowed when the matched value
// contains a marker such as `test`, `fake`, `fixture`, `example`, `placeholder`,
// `synthetic` or `dummy`. Matches inside `test/`, `tests/`, `fixtures/` and
// `testdata/` are treated as fixture material too; they are counted and reported
// as allowed, never as clean silence.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.zcode', '.reference',
  'coverage', 'dist', '.cache', '.vite', 'artifacts',
]);
const FIXTURE_MARKERS = ['test', 'fake', 'fixture', 'example', 'placeholder', 'synthetic', 'dummy', 'mock'];
const FIXTURE_DIRS = new Set(['test', 'tests', 'fixtures', 'testdata', '__fixtures__']);
const MAX_BYTES = 2 * 1024 * 1024;

// Assembled pieces: see the header note. The scheme is the public wire label
// already recorded in src/constants.mjs (AUTH_SCHEME); composing it here keeps
// the literal out of this file while still scanning for the real value.
const AUTH_SCHEME = ['Cloud', 'IDE', 'JWT'].join('-');
const GITHUB_PREFIX = ['gh', 'p_'].join('');
const GITHUB_PAT_PREFIX = ['github_', 'pat_'].join('');
const OPENAI_PREFIX = ['s', 'k-'].join('');
const AWS_PREFIX = ['AK', 'IA'].join('');
const SLACK_PREFIX = ['xox', 'b-'].join('');

function isFixtureText(value) {
  const lower = String(value).toLowerCase();
  return FIXTURE_MARKERS.some(marker => lower.includes(marker));
}

/**
 * A rule: `pattern` finds the candidate; `valueOf` selects the part that must
 * look fake; `allowValue` optionally overrides the fixture test (e.g. e-mail
 * domains reserved for examples).
 */
const RULES = [
  {
    id: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  },
  {
    id: 'trae-auth-scheme-token',
    pattern: new RegExp(`\\b${AUTH_SCHEME}\\s+[A-Za-z0-9._~+/=-]{20,}`),
  },
  {
    id: 'github-token',
    pattern: new RegExp(`\\b(?:${GITHUB_PREFIX}|${GITHUB_PAT_PREFIX})[A-Za-z0-9_]{20,}`),
  },
  {
    id: 'openai-style-key',
    pattern: new RegExp(`\\b${OPENAI_PREFIX}[A-Za-z0-9_-]{20,}`),
  },
  {
    id: 'aws-access-key',
    pattern: new RegExp(`\\b${AWS_PREFIX}[0-9A-Z]{16}\\b`),
  },
  {
    id: 'slack-token',
    pattern: new RegExp(`\\b${SLACK_PREFIX}[A-Za-z0-9-]{10,}`),
  },
  {
    id: 'gateway-key-literal',
    pattern: /gatewayKey["']?\s*[:=]\s*["']([^"']{16,})["']/i,
    valueOf: match => match[1],
    allowValue: value => /^[<$]/.test(value) || value.includes('${'),
  },
  {
    id: 'refresh-token-literal',
    pattern: /refreshToken["']?\s*[:=]\s*["']([^"']{16,})["']/i,
    valueOf: match => match[1],
    allowValue: value => /^[<$]/.test(value) || value.includes('${'),
  },
  {
    id: 'windows-user-path',
    pattern: /[A-Za-z]:[\\/]{1,2}(?:Users|Documents and Settings)[\\/]([^\\/\s"'<>|:]+)/i,
    valueOf: match => match[1],
  },
  {
    id: 'posix-user-path',
    pattern: new RegExp('(?:\\/Users|\\/home)\\/([A-Za-z0-9._-]+)'),
    valueOf: match => match[1],
  },
  {
    id: 'email-address',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
    allowValue: value => /@(?:example\.(?:com|org|net)|test\.invalid|users\.noreply\.github\.com)$/i.test(value),
  },
  {
    id: 'device-id-key',
    pattern: /iCubeAuthInfo:\/\/icube-dc:\d{6,}/,
  },
  {
    id: 'device-id-literal',
    pattern: /"deviceId"\s*:\s*"(\d{6,})"/i,
    valueOf: match => match[1],
  },
  {
    id: 'device-id-header',
    pattern: /\bx-icube-did\s*:\s*(\d{6,})/i,
    valueOf: match => match[1],
  },
  {
    id: 'private-key-block',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
];

function walk(directory, segments, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(directory, entry.name), [...segments, entry.name], found);
    } else if (entry.isFile()) {
      found.push({ file: path.join(directory, entry.name), segments });
    }
  }
  return found;
}

const findings = [];
const allowed = [];
let scanned = 0;

for (const { file, segments } of walk(ROOT, []).sort((a, b) => (a.file < b.file ? -1 : 1))) {
  let bytes;
  try {
    if (statSync(file).size > MAX_BYTES) continue;
    bytes = readFileSync(file);
  } catch {
    continue;
  }
  if (bytes.includes(0)) continue; // binary
  const text = bytes.toString('utf8');
  if (text.includes('\uFFFD')) continue; // not UTF-8 text
  scanned++;
  const fixtureDir = segments.some(segment => FIXTURE_DIRS.has(segment.toLowerCase()));
  const lines = text.split(/\r?\n/);
  for (const rule of RULES) {
    for (let index = 0; index < lines.length; index++) {
      const match = lines[index].match(rule.pattern);
      if (!match) continue;
      const value = rule.valueOf ? rule.valueOf(match) : match[0];
      const fake = (rule.allowValue && rule.allowValue(value)) || isFixtureText(value);
      const record = {
        file: path.relative(ROOT, file).split(path.sep).join('/'),
        line: index + 1,
        rule: rule.id,
      };
      if (fake || fixtureDir) allowed.push(record);
      else findings.push(record);
    }
  }
}

for (const finding of findings) {
  console.error(`privacy: ${finding.file}:${finding.line} [${finding.rule}]`);
}

if (allowed.length) {
  console.log(`privacy: ${allowed.length} fixture match(es) allowed (test/fake/example/placeholder values)`);
  if (process.env.PRIVACY_VERBOSE === '1') {
    for (const record of allowed) console.log(`privacy: allowed ${record.file}:${record.line} [${record.rule}]`);
  }
}
if (findings.length) {
  console.error(`privacy: ${findings.length} real finding(s) in ${scanned} file(s); values are intentionally not printed`);
  process.exitCode = 1;
} else {
  console.log(`privacy: ok (${scanned} file(s), ${RULES.length} rule(s))`);
}
