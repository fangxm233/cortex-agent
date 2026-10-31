import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadPiSdk, type PiSdkModule } from '@core/pi-sdk.js';

// PI's bash takes a command and a timeout. Claude Code's Bash also takes a `description` — what the
// command does, in a few words — which the chat shows as what the agent is doing. This extension
// gives PI's bash the same optional argument; running the command stays PI's own.

type BashDefinition = ReturnType<PiSdkModule['createBashToolDefinition']>;
type BashFactory = PiSdkModule['createBashToolDefinition'];

/** A plain JSON Schema property. PI validates with its own TypeBox, which reads plain schemas but
 *  not `@sinclair/typebox` ones: rebuilt with those, `timeout` loses its optional mark. */
const DESCRIPTION_PROPERTY = {
  type: 'string',
  description: 'Clear, concise description of what this command does in active voice, in 5-10 words.',
} as const;

/** PI's bash, also taking an optional `description` that running the command ignores. */
export function withDescription(base: BashDefinition): BashDefinition {
  const parameters = base.parameters;
  const properties = { ...parameters.properties, description: DESCRIPTION_PROPERTY };
  return { ...base, parameters: { ...parameters, properties } as typeof parameters };
}

async function loadBashFactory(): Promise<BashFactory> {
  return (await loadPiSdk()).createBashToolDefinition;
}

/** Replace the session's bash with the described one, built the way PI builds its own. A session
 *  without bash active gets none: registering a tool would activate it. */
export function installDescribedBash(pi: ExtensionAPI, load: () => Promise<BashFactory> = loadBashFactory): void {
  pi.on('session_start', async (_event, ctx) => {
    if (!pi.getActiveTools().includes('bash')) return;
    const { shellCommandPrefix, shellPath } = pi.getSettings();
    const createBash = await load();
    pi.registerTool(withDescription(createBash(ctx.cwd, { commandPrefix: shellCommandPrefix, shellPath })));
  });
}
