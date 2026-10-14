// Preloaded (`node --import`) into a hook script that runs from the user's hooks dir. A script
// copied there from the shipped hooks keeps its relative imports of the shipped helpers
// (./cortex-context-lib.mjs, ./cortex-hook-api.mjs, …): an import that finds nothing next to the
// script is retried next to the shipped hooks. A helper the user copied as well is used as it is.

import { register } from 'node:module';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const script = process.argv[1];
if (script) {
  const userDirUrl = pathToFileURL(`${dirname(script)}/`).href;
  register('./resolve.mjs', import.meta.url, { data: { userDirUrl } });
}
