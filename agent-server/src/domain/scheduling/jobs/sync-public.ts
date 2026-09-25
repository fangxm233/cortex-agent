import { runFile } from '@core/exec-async.js';
import * as path from 'path';
import { register, ctx } from '../job-registry.js';
import { Icons } from '../../../core/icons.js';

export function resolveSyncPublicScript(agentServerDir = process.env.CORTEX_REPO ?? ''): string | null {
  const checkout = agentServerDir.trim();
  if (!checkout) return null;
  return path.resolve(checkout, '..', 'scripts', 'sync-pull-from-public.sh');
}

// Self-register
register('sync-public', async (payload: unknown) => {
  const { channel } = payload as { channel: string; scheduleTaskId: string };
  const adapter = ctx.adapter!;
  try {
    const syncScript = resolveSyncPublicScript();
    if (!syncScript) throw new Error('CORTEX_REPO is unset; public sync requires a source checkout');
    // Async: this is a scheduled job inside the long-lived server process.
    const synced = await runFile('bash', [syncScript], { timeoutMs: 30_000 });
    if (!synced.ok) throw new Error((synced.stderr || synced.error || 'sync script failed').trim());
    const output = synced.stdout;
    const lines = output.trim().split('\n');
    const lastLine = lines[lines.length - 1] || '';
    if (lastLine.includes('0 failed') || lastLine.includes('everything in sync') || lastLine.includes('OK:') || lastLine.includes('SKIP:')) {
      // Quiet success — no message needed unless there were actual syncs
      const countLine = lines.find(l => l.includes('cherry-picked'));
      if (countLine && !countLine.includes('0 cherry-picked')) {
        await adapter.postMessage({ type: 'interactive-reply', conduit: channel }, { text: `${Icons.refresh} Public sync: ${countLine.trim()}` });
      }
    } else {
      await adapter.postMessage({ type: 'interactive-reply', conduit: channel }, { text: `${Icons.warning} Public sync issue:\n\`\`\`\n${output.slice(-500)}\n\`\`\`` });
    }
  } catch (err: any) {
    const msg = err?.stderr || err?.message || String(err);
    await adapter.postMessage({ type: 'interactive-reply', conduit: channel }, { text: `${Icons.warning} Public sync error: ${msg.slice(0, 500)}` });
  }
});
