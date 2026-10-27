const path = require('node:path');
const { createRequire, registerHooks } = require('node:module');
const { pathToFileURL } = require('node:url');

// Node's ParseNodeOptionsEnvVar: spaces separate, double quotes group, backslash
// escapes only inside double quotes. Node itself rejects invalid quoting first.
function envArgs(value) {
  return [...value.matchAll(/(?:[^ "]+|"(?:[^"\\]|\\.)*")+/g)]
    .map(match => match[0].replace(/"((?:[^"\\]|\\.)*)"/g, (_, inner) => inner.replace(/\\(.)/gs, '$1')))
    .filter(Boolean);
}

function preloads(args) {
  const result = { require: [], import: [] };
  for (let i = 0; i < args.length; i++) {
    const match = /^(--import|--require|-r)(?:=(.*))?$/.exec(args[i]);
    if (!match) continue;
    const kind = match[1] === '--import' ? 'import' : 'require';
    result[kind].push(match[2] ?? args[++i]);
  }
  return result;
}

let importId = 0;
async function importFromCwd(name) {
  const marker = `cortex:preload/${importId++}`;
  const parentURL = pathToFileURL(path.join(process.cwd(), '__sea_preload.mjs')).href;
  const hook = registerHooks({ resolve(specifier, context, nextResolve) {
    return specifier === marker
      ? nextResolve(name, { ...context, parentURL })
      : nextResolve(specifier, context);
  } });
  try { await import(marker); } finally { hook.deregister(); }
}

async function loadPreloads(options) {
  const selected = preloads(envArgs(options));
  const requireFromCwd = createRequire(path.join(process.cwd(), '__sea_preload.cjs'));
  for (const name of selected.require) requireFromCwd(name);
  for (const name of selected.import) await importFromCwd(name);
}

module.exports = { envArgs, preloads, loadPreloads };
