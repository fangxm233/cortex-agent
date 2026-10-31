// Side-effect import for tests that run the startup migrations: import it FIRST, before any src
// module. Some steps resolve files under the OS home rather than CORTEX_HOME (the connections step
// reads ~/.aistatus/gateway.yaml and rewrites PI's ~/.pi/agent/models.json), so this points HOME
// and CORTEX_GATEWAY_HOME at a directory inside the per-file test home.
//
// atomic-write is imported first so its real-~/.cortex tripwire is computed from the real HOME.
import '../../src/core/atomic-write.js';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';

const cortexHome = process.env.CORTEX_HOME;
if (!cortexHome) throw new Error('isolate-os-home requires the vitest setup file (CORTEX_HOME unset)');

export const ISOLATED_OS_HOME = path.join(cortexHome, 'os-home');
mkdirSync(ISOLATED_OS_HOME, { recursive: true });
process.env.HOME = ISOLATED_OS_HOME;
process.env.USERPROFILE = ISOLATED_OS_HOME;
process.env.CORTEX_GATEWAY_HOME = ISOLATED_OS_HOME;
