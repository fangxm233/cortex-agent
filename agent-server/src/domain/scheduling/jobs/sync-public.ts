// input:  CORTEX_REPO, sync-public script, PlatformAdapter
// output: sync-public path resolver and registered job runner
// pos:    Pulls public/main changes into a source checkout
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { execFileSync } from 'child_process';
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
    const output = execFileSync('bash', [syncScript], {
      timeout: 30_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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
