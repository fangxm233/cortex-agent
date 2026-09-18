import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requestLoopbackJson } from '@core/loopback-http.js';
import { webhookAuthHeaders, type CortexToolContext } from './context.js';

/** Everything the caller needs to paste somewhere, built once so the model never composes it. */
interface SignalRecipe {
  /** Which of the lines below fits the situation the caller described. */
  recommended: 'cli' | 'shell';
  env: string;
  cli: string;
  curl: string;
  shell: string;
}

async function proxy(ctx: CortexToolContext, action: string, payload: Record<string, unknown>): Promise<any> {
  const { body } = await requestLoopbackJson(
    'POST',
    `${ctx.webhookBaseUrl}/webhook/waitpoint`,
    { action, sessionId: ctx.sessionId, channel: ctx.channel, threadId: ctx.threadId, project: ctx.taskProject || ctx.project, ...payload },
    webhookAuthHeaders(ctx),
  );
  if (!body.success) throw new Error(body.error || `waitpoint ${action} failed`);
  return body.data;
}

function ok(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function fail(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true as const };
}

/**
 * The three forms a signal can take, filled in with a real id and secret.
 *
 * `shell` is the one that matters for a remote machine: it needs no Cortex binary and no route
 * back to the daemon — it drops a file the daemon comes and collects.
 */
function buildRecipe(id: string, secret: string, port: number, device: string | null): SignalRecipe {
  const env = `export CORTEX_SIGNAL_ID=${id} CORTEX_SIGNAL_SECRET=${secret}`;
  const cli = `cortex-signal --exit-code $?`;
  const curl = `curl -sS -XPOST http://127.0.0.1:${port}/webhook/signal `
    + `-H 'content-type: application/json' `
    + `-d '{"id":"${id}","secret":"${secret}","status":"ok","message":"done"}'`;
  // Write-then-rename: a same-directory rename is atomic, so the drain never reads a half file.
  const shell = [
    `s=$?; d=~/.cortex/tmp/signals; mkdir -p "$d"`,
    `printf '{"id":"${id}","secret":"${secret}","status":"%s","message":"exit=%s"}' `
      + `"$([ $s -eq 0 ] && echo ok || echo fail)" "$s" > "$d/$$.tmp" && mv "$d/$$.tmp" "$d/$$.json"`,
  ].join('\n');
  // On a device the daemon cannot be reached over HTTP at all, so the file drop is the only
  // form that works there; on this machine the CLI is shorter and reports failures immediately.
  return { recommended: device ? 'shell' : 'cli', env, cli, curl, shell };
}

export function registerWaitpointTools(server: McpServer, ctx: CortexToolContext): void {
  server.tool(
    'wait_create',
    'Arm a waitpoint: a durable "wake me when this finishes" object for something running outside '
    + 'Cortex (a training run, a build, an evaluation). You get back an id and a one-time secret, '
    + 'plus ready-to-paste lines to append to whatever you are running. Then END YOUR TURN — the '
    + 'wait costs nothing while you are idle, and when the signal arrives this session is woken with '
    + 'a message carrying the result and the `intent` you record here. Use `members` + `quorum` to '
    + 'wait on several jobs at once; by default the first failure wakes you immediately.',
    {
      label: z.string().describe('Short human name, e.g. "arm2 training". Appears in the wake message.'),
      intent: z.string().describe(
        'What you are waiting for and what you will do when woken, in your own words. You will read '
        + 'this hours later in a fresh turn with none of the current context, so write it for a stranger.',
      ),
      members: z.array(z.string()).optional().describe(
        'Names of the jobs you expect to report, e.g. ["arm2","arm6","arm8"]. Each one signals with its own name.',
      ),
      quorum: z.union([z.number(), z.literal('all')]).optional().describe(
        'How many terminal signals resolve this waitpoint. Defaults to "all" when members are given, else 1.',
      ),
      fail_fast: z.boolean().optional().describe(
        'Wake on the first failure even if the quorum is unmet. Default true.',
      ),
      max_signals: z.number().optional().describe(
        'How many times it may wake you before closing. Default 1 (one-shot). >1 turns it into a mailbox.',
      ),
      expires_in_hours: z.number().optional().describe(
        'Deadline. If nothing signals by then you are told so instead of waiting forever. Default 168h (7d), max 720h.',
      ),
      device: z.string().optional().describe(
        'Name of the connected device the job runs on. Set this when the job is NOT on this machine: '
        + 'the daemon then collects signals from that device instead of expecting an HTTP call it cannot make.',
      ),
    },
    async (args: any) => {
      try {
        const data = await proxy(ctx, 'create', {
          label: args.label,
          intent: args.intent,
          quorum: { need: args.quorum, members: args.members },
          failFast: args.fail_fast,
          maxSignals: args.max_signals,
          ttlMs: typeof args.expires_in_hours === 'number' ? args.expires_in_hours * 3600_000 : undefined,
          device: args.device,
        });
        const port = Number(new URL(ctx.webhookBaseUrl).port || 3001);
        const recipe = buildRecipe(data.id, data.secret, port, args.device ?? null);
        return ok({
          ...data,
          how_to_signal: recipe,
          next: 'Hand one of the how_to_signal lines to the job, then end your turn. You will be woken.',
        });
      } catch (e) {
        return fail(`wait_create failed: ${(e as Error).message}`);
      }
    },
  );

  server.tool(
    'wait_check',
    'Inspect a waitpoint you armed: its state, which members have reported, and what they said. '
    + 'Pass an id, or omit it to list every waitpoint this session owns. Read-only — you do not need '
    + 'to poll this to be woken.',
    {
      id: z.string().optional().describe('Waitpoint id (wp_…). Omit to list all of this session\'s waitpoints.'),
    },
    { readOnlyHint: true },
    async (args: any) => {
      try {
        return ok(await proxy(ctx, 'check', { id: args.id }));
      } catch (e) {
        return fail(`wait_check failed: ${(e as Error).message}`);
      }
    },
  );

  server.tool(
    'wait_cancel',
    'Disarm a waitpoint you no longer care about. Its secret stops working and you will not be woken. '
    + 'Use this when you gave up on the job or finished the work another way — an abandoned waitpoint '
    + 'otherwise wakes you days later about something nobody remembers.',
    {
      id: z.string().describe('Waitpoint id (wp_…) to cancel.'),
    },
    async (args: any) => {
      try {
        return ok(await proxy(ctx, 'cancel', { id: args.id }));
      } catch (e) {
        return fail(`wait_cancel failed: ${(e as Error).message}`);
      }
    },
  );
}
