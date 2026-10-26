const path = require('node:path');
const { createRequire } = require('node:module');
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

async function loadPreloads(options) {
  const selected = preloads(envArgs(options));
  const requireFromCwd = createRequire(path.join(process.cwd(), '__sea_preload.cjs'));
  for (const name of selected.require) requireFromCwd(name);
  for (const name of selected.import) {
    const url = /^(?:node|data|file):/.test(name) ? name : pathToFileURL(requireFromCwd.resolve(name)).href;
    await import(url);
  }
}

module.exports = { envArgs, preloads, loadPreloads };
