/**
 * Loads .env before any other module reads process.env.
 * Must be the first import in the entry point — modules that capture env vars
 * at import time (e.g. services/deltaExchange.ts) would otherwise see nothing.
 *
 * FIX: process.loadEnvFile was introduced in Node 20.6+. Running on Node 18 LTS
 * caused a TypeError crash before any market data loaded. This now uses a
 * manual parser as a cross-version fallback.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Manual .env parser — compatible with Node 18+, handles quoted values and comments. */
function loadEnvFileSafe(filePath: string): void {
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const rawVal = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes (single or double)
    const val = rawVal.replace(/^(['"])(.*)\1$/, '$2');
    // Never override a value already set in the OS environment (e.g. from Docker)
    if (!(key in process.env)) process.env[key] = val;
  }
}

// Use native if available (Node 20.6+), otherwise use the safe fallback.
const loaderFn: (p: string) => void =
  typeof (process as any).loadEnvFile === 'function'
    ? (p: string) => (process as any).loadEnvFile(p)
    : loadEnvFileSafe;

for (const candidate of [
  path.resolve(here, '../../.env'),
  path.resolve(here, '../.env'),
]) {
  if (!fs.existsSync(candidate)) continue;
  try {
    loaderFn(candidate);
    console.log(`[env] loaded ${candidate}`);
  } catch (error) {
    console.warn(`[env] failed to load ${candidate}:`, error);
  }
  break;
}

// Validation: warn if the .env didn't load correctly (e.g. UTF-16 on Windows)
if (!process.env.DELTA_EXCHANGE_API_KEY && !process.env.MONGODB_URI && !process.env.STARTING_EQUITY) {
  console.warn('[env] WARNING: No critical env vars found — .env may not have loaded correctly (check file encoding: must be UTF-8)');
}
