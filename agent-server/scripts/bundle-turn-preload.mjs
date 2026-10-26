// Real-turn tests only: relocate the otherwise fixed gateway port in memory, never on disk.
import { registerHooks } from 'node:module';
import { isAbsolute } from 'node:path';
const port = Number(process.env.CORTEX_BUNDLE_SMOKE_GATEWAY_PORT);
if (!isAbsolute(process.env.CORTEX_HOME ?? '') || !Number.isInteger(port) || port < 1024 || port === 9880) {
  throw new Error('Bundle turn preload requires an isolated home and gateway port');
}
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (result.format !== 'module' || !url.includes('/dist/chunks/')) return result;
    const source = String(result.source);
    if (!source.includes('"gateway-mgr"')) return result;
    const pattern = /(="127\.0\.0\.1",\w+=)9880\b/g;
    if ([...source.matchAll(pattern)].length !== 1) throw new Error('Gateway port layout changed');
    return { ...result, source: source.replace(pattern, `$1${port}`) };
  },
});
