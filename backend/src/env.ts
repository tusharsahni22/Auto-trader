/**
 * Loads .env before any other module reads process.env.
 * Must be the first import in the entry point — modules that capture env vars
 * at import time (e.g. services/deltaExchange.ts) would otherwise see nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

for (const candidate of [
  path.resolve(here, '../../.env'),
  path.resolve(here, '../.env'),
]) {
  if (!fs.existsSync(candidate)) continue;
  try {
    process.loadEnvFile(candidate);
    console.log(`[env] loaded ${candidate}`);
  } catch (error) {
    console.warn(`[env] failed to load ${candidate}:`, error);
  }
  break;
}
