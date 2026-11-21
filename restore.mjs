#!/usr/bin/env node
// Exit-compensation worker. Contract: docs/design/interfaces.md §14.
// Spawned detached by index.mjs when the host exits; argv[2] is the bridge port.
// It only finishes a pending release that the cloud call could not complete while
// the host was running. Every failure is swallowed: the journal is retried on the
// next plugin start.

import fs from 'node:fs';
import { DEFAULT_PORT } from './src/constants.mjs';
import { syncPaths } from './src/state.mjs';
import { syncModels } from './src/sync.mjs';

const requested = Number(process.argv[2] || DEFAULT_PORT);
const port = Number.isInteger(requested) && requested >= 1 && requested <= 65535 ? requested : DEFAULT_PORT;

try {
  const paths = syncPaths();
  // `undefined` means "unreadable/corrupt": leave the journal for the next start.
  let control = null;
  try {
    control = JSON.parse(fs.readFileSync(paths.control, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') control = undefined;
  }

  if (control !== undefined) {
    const connected =
      Boolean(control) &&
      typeof control === 'object' &&
      typeof control.gatewayKey === 'string' &&
      control.gatewayKey.length > 0;
    let hasJournal = false;
    try {
      hasJournal = fs.statSync(paths.state).isFile();
    } catch {
      hasJournal = false;
    }
    if (!connected && hasJournal) await syncModels({ port });
  }
} catch {
  /* The pending journal is retried when the plugin starts again. */
}

process.exitCode = 0;
