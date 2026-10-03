import * as path from 'node:path';
import { CONFIG_DIR, DEFAULTS_DIR } from '@core/paths.js';

/** Where execution environments live: one `<name>.json` per environment. */
export const ENVIRONMENTS_DIRNAME = 'environments';
export const ENVIRONMENTS_DIR = path.join(CONFIG_DIR, ENVIRONMENTS_DIRNAME);
/** The environments a fresh install starts with. */
export const DEFAULT_ENVIRONMENTS_DIR = path.join(DEFAULTS_DIR, 'config', ENVIRONMENTS_DIRNAME);

/** The environment a conversation falls back to when nothing anywhere names one. */
export const FALLBACK_ENVIRONMENT = 'main';
