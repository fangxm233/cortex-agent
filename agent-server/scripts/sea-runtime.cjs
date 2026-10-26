const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = __dirname;
const bins = require('./package.json').bin;
const entries = {
  ...bins, app: 'dist/entry/app.js', supervisor: 'dist/entry/daemon.js',
  mcp: 'dist/domain/mcp/bundled-server.js', gateway: 'vendor/aistatus/gateway-cli.js',
  'remote-mcp': 'dist/agent-adapter/claude/remote-mcp-proxy.js',
};

function writeChanged(file, content, mode) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return;
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, { mode });
  fs.renameSync(temporary, file);
}

function writeAliases() {
  const directory = path.join(root, 'bin');
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, entry] of Object.entries(bins)) {
    const quoted = process.execPath.replaceAll('\\', '/').replace(/'/g, `'\\''`);
    writeChanged(path.join(directory, name), `#!/bin/sh\nexec '${quoted}' --entry=${entry} "$@"\n`, 0o755);
    writeChanged(path.join(directory, `${name}.cmd`), `@echo off\r\n"${process.execPath}" --entry=${entry} %*\r\n`, 0o644);
  }
  process.env.PATH = directory + path.delimiter + (process.env.PATH || '');
}

async function main() {
  writeAliases();
  await require('./sea-preload.cjs').loadPreloads(process.env.NODE_OPTIONS || '');
  const args = process.argv.slice(2);
  while (args[0] === '--import') { args.shift(); await import(args.shift()); }
  let entry = entries.cortex;
  if (args[0]?.startsWith('--entry=')) entry = args.shift().slice('--entry='.length);
  else if (args[0] === '--entry') { args.shift(); entry = args.shift(); }
  else if (path.isAbsolute(args[0] || '') && fs.existsSync(args[0])) entry = args.shift();
  entry = entries[entry] || entry;
  const file = path.resolve(root, entry);
  process.argv = [process.execPath, file, ...args];
  await import(pathToFileURL(file).href);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
