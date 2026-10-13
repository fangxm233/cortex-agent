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
  /** For a job that is ALREADY running: nothing can be appended to its command line any more, so
   *  watch its pid from the side (replace `PID`). The only form that works when the waitpoint is
   *  armed too late. */
  attach_to_pid: string;
  /** Present when members were declared: every line above carries a `MEMBER` placeholder. */
  member_note?: string;
}

async function proxy(ctx: CortexToolContext, action: string, payload: Record<string, unknown>): Promise<any> {
  const { body } = await requestLoopbackJson(
    'POST',
    `${ctx.webhookBaseUrl}/webhook/waitpoint`,
    { action, sessionId: ctx.sessionId, channel: ctx.channel, project: ctx.project, ...payload },
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
 * back to the daemon — it drops a file the daemon comes and collects. Every file gets a fresh name:
 * the drain treats the name as the signal's identity, so a monitor reporting twice from one shell
 * must not reuse `$$` alone.
 */
export function buildSignalRecipe(
  id: string,
  secret: string,
  port: number,
  device: string | null,
  members: string[] = [],
): SignalRecipe {
  // A bare word, not `<MEMBER>`: pasted unreplaced, angle brackets are shell redirections, while a
  // word is just a member name the server refuses with a clear error.
  const member = members.length > 0 ? 'MEMBER' : null;
  const env = `export CORTEX_SIGNAL_ID=${id} CORTEX_SIGNAL_SECRET=${secret}`;
  const memberFlag = member ? `--member ${member} ` : '';
  const memberField = member ? `"member":"${member}",` : '';
  const cli = `cortex-signal ${memberFlag}--exit-code $?`;
  const curl = `curl -sS -XPOST http://127.0.0.1:${port}/webhook/signal `
    + `-H 'content-type: application/json' `
    + `-d '{"id":"${id}","secret":"${secret}",${memberField}"status":"ok","message":"done"}'`;
  // Write-then-rename: a same-directory rename is atomic, so the drain never reads a half file.
  const shell = [
    `s=$?; d=~/.cortex/tmp/signals; f="$d/$(date +%s%N)-$$-$RANDOM"; mkdir -p "$d"`,
    `printf '{"id":"${id}","secret":"${secret}",${memberField}"status":"%s","message":"exit=%s"}' `
      + `"$([ $s -eq 0 ] && echo ok || echo fail)" "$s" > "$f.tmp" && mv "$f.tmp" "$f.json"`,
  ].join('\n');
  // On a device the daemon cannot be reached over HTTP at all, so the file drop is the only
  // form that works there; on this machine the CLI is shorter and reports failures immediately.
  // `PID` is a bare word for the same reason as `MEMBER`: `<PID>` pasted unreplaced is a pair of
  // redirections that would create stray files.
  const attachToPid = `(while kill -0 PID 2>/dev/null; do sleep 5; done; `
    + `cortex-signal ${memberFlag}--status ok --message "pid PID exited") &`;
  return {
    recommended: device ? 'shell' : 'cli', env, cli, curl, shell, attach_to_pid: attachToPid,
    ...(member ? { member_note: `Replace MEMBER with the job's own name, one of: ${members.join(', ')}.` } : {}),
  };
}

export function registerWaitpointTools(server: McpServer, ctx: CortexToolContext): void {
  server.tool(
    'wait_create',
    'Arm an external callback that wakes this session with a result. Returns an ID, secret, and cortex-signal commands. Cortex launches nothing and watches nothing: arm BEFORE starting the job and install the returned callback in its command (or attach_to_pid for an existing job). Then END YOUR TURN; do not poll. Unsignaled waits expire.',
    {
      label: z.string().describe('Short name shown on wake.'),
      intent: z.string().describe('Briefly state what you are waiting for and what to do next.'),
      members: z.array(z.string()).optional().describe(
        'Expected job names. If set, each signal must name a listed member.',
      ),
      quorum: z.union([z.number(), z.literal('all')]).optional().describe(
        'How many terminal signals resolve this waitpoint. Defaults to "all" when members are given, else 1.',
      ),
      fail_fast: z.boolean().optional().describe(
        'Wake on the first failure even if the quorum is unmet. Default true.',
      ),
      max_signals: z.number().optional().describe(
        'Wake limit (default 1). Higher values allow repeated reports; cancel when done. '
        + 'Send --status progress to record without waking.',
      ),
      expires_in_hours: z.number().optional().describe(
        'Expiry notification deadline in hours (default 168, max 720).',
      ),
      device: z.string().optional().describe(
        'Connected device running the job; required for remote jobs so signals are collected there.',
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
        const members: string[] = Array.isArray(data.quorum?.members) ? data.quorum.members : [];
        const recipe = buildSignalRecipe(data.id, data.secret, port, args.device ?? null, members);
        return ok({
          ...data,
          how_to_signal: recipe,
          next: 'Nothing will signal this waitpoint unless you put one of the how_to_signal lines '
            + 'where the job runs it (start the job with it, or attach_to_pid if it is already '
            + 'running). Do that first, then end your turn — you will be woken.',
        });
      } catch (e) {
        return fail(`wait_create failed: ${(e as Error).message}`);
      }
    },
  );

  server.tool(
    'wait_check',
    'Inspect session-owned waitpoints and member reports. Read-only; wakes arrive automatically, so do not poll.',
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
    'Disarm an unneeded waitpoint. Invalidates its secret and prevents future wakes; cancel abandoned waits.',
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
