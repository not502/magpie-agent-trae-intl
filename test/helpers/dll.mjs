// Synthetic DLL buffers for credential-profile tests. These are plain byte
// arrays built in a temp directory; they contain no real key material and are
// never copied outside the test process. The layout follows the documented
// marker search: 84 (harness) / 94 (ai_agent) ASCII bytes immediately before a
// public marker string.

import { createHash } from 'node:crypto';

export const HARNESS_MARKER = 'key too shortrandom too short';
export const AI_AGENT_MARKER = 'apps\\icube_server_rs\\crates\\llm-client\\src\\crypto\\crypto.rs';

export const KEY_HEX = 'a'.repeat(64);
export const SALT_HEX = 'b'.repeat(20);
export const AI_SALT_HEX = 'c'.repeat(20);
export const AAD = '0123456789';

/**
 * @param {{ keyHex?: string, saltHex?: string, aad?: string, aiSaltHex?: string }} [options]
 * @returns {{ harnessPrefix: string, aiAgentPrefix: string }}
 */
export function keyMaterial(options = {}) {
  const keyHex = options.keyHex ?? KEY_HEX;
  const saltHex = options.saltHex ?? SALT_HEX;
  const aad = options.aad ?? AAD;
  const aiSaltHex = options.aiSaltHex ?? saltHex;
  return {
    harnessPrefix: `${keyHex}${saltHex}`,
    aiAgentPrefix: `${keyHex}${aad}${aiSaltHex}`,
  };
}

/**
 * @param {string} prefix ASCII prefix of exactly `prefixBytes` characters
 * @param {string} marker Public marker string
 * @param {{ before?: string, after?: string, repeat?: number }} [options]
 * @returns {Buffer}
 */
export function dllBytes(prefix, marker, options = {}) {
  const repeat = options.repeat ?? 1;
  const parts = [
    Buffer.from(options.before ?? '', 'utf8'),
    Buffer.from(prefix, 'ascii'),
  ];
  for (let index = 0; index < repeat; index++) {
    parts.push(Buffer.from(marker, 'ascii'));
    if (index < repeat - 1) parts.push(Buffer.from('gap-between-markers', 'ascii'));
  }
  parts.push(Buffer.from(options.after ?? '', 'utf8'));
  return Buffer.concat(parts);
}

/** @param {Buffer} bytes @returns {string} */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
