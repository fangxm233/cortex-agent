// input:  Node module registration API and fake agent loader URL
// output: loader hook installed before Cortex module imports
// pos:    Pre-import registrar for the fake thread-runner agent
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { register } from 'node:module';

register(new URL('./fake-run-agent-loader.mjs', import.meta.url), import.meta.url);
