// input:  hook declarations across every event namespace
// output: mount-target, result-capability and apply-time derivation tests
// pos:    Verifies the UI-facing derived view of a hook declaration
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  hookAppliesAt,
  hookMountTargets,
  legalResultModes,
} from '../../src/domain/hooks/hook-view.js';
import type { HookEntry } from '../../src/store/hook-registry.js';

function entry(partial: Partial<HookEntry> & Pick<HookEntry, 'event'>): HookEntry {
  return { id: 'x', run: { script: 'x.mjs' }, ...partial } as HookEntry;
}

// ── mount targets ─────────────────────────────────────────────────

test('a tool-phase agent event mounts on both backends', () => {
  assert.deepEqual(hookMountTargets(entry({ event: 'agent:pre-tool' })), ['claude', 'pi']);
  assert.deepEqual(hookMountTargets(entry({ event: 'agent:post-tool' })), ['claude', 'pi']);
  assert.deepEqual(hookMountTargets(entry({ event: 'agent:session-start' })), ['claude', 'pi']);
});

test('the four PI-only agent events do not claim a Claude mount point', () => {
  // These compile to PI only; the Claude mount point must be declared as cc:* instead.
  for (const event of ['agent:session-end', 'agent:pre-compact', 'agent:user-prompt', 'agent:turn-end']) {
    assert.deepEqual(hookMountTargets(entry({ event: event as HookEntry['event'] })), ['pi'], event);
  }
});

test('scope.backends narrows the mount targets', () => {
  const claudeOnly = entry({ event: 'agent:pre-tool', scope: { backends: ['claude'] } });
  assert.deepEqual(hookMountTargets(claudeOnly), ['claude']);

  const piOnly = entry({ event: 'agent:pre-tool', scope: { backends: ['pi'] } });
  assert.deepEqual(hookMountTargets(piOnly), ['pi']);
});

test('passthrough namespaces mount on their own backend only', () => {
  assert.deepEqual(hookMountTargets(entry({ event: 'cc:PermissionRequest' })), ['claude']);
  assert.deepEqual(hookMountTargets(entry({ event: 'pi:before_provider_headers' })), ['pi']);
});

test('cortex events mount on the server, never on a backend', () => {
  assert.deepEqual(hookMountTargets(entry({ event: 'cortex:thread.end' })), ['server']);
  assert.deepEqual(hookMountTargets(entry({ event: 'cortex:session.new' })), ['server']);
});

test('a disabled declaration still reports where it would mount', () => {
  assert.deepEqual(hookMountTargets(entry({ event: 'agent:pre-tool', enabled: false })), ['claude', 'pi']);
});

test('scope.backends that excludes the only implicit backend leaves no target', () => {
  const impossible = entry({ event: 'cc:SessionEnd', scope: { backends: ['pi'] } });
  assert.deepEqual(hookMountTargets(impossible), []);
});

// ── result capability ─────────────────────────────────────────────

test('thread lifecycle events allow hook-result', () => {
  for (const event of ['cortex:thread.start', 'cortex:thread.transition', 'cortex:thread.end']) {
    assert.deepEqual(legalResultModes(event as HookEntry['event']), ['none', 'hook-result'], event);
  }
});

test('session events allow stdout-as-prompt', () => {
  assert.deepEqual(legalResultModes('cortex:session.new'), ['none', 'stdout-as-prompt']);
  assert.deepEqual(legalResultModes('cortex:session.messageEnd'), ['none', 'stdout-as-prompt']);
});

test('every other event is limited to none', () => {
  assert.deepEqual(legalResultModes('agent:pre-tool'), ['none']);
  assert.deepEqual(legalResultModes('cortex:task.completed'), ['none']);
  assert.deepEqual(legalResultModes('cc:Stop'), ['none']);
});

// ── apply time ────────────────────────────────────────────────────

test('cortex events need a server restart because the bus snapshots at startup', () => {
  assert.equal(hookAppliesAt('cortex:task.completed'), 'server-restart');
});

test('agent-facing events apply to the next agent that spawns', () => {
  assert.equal(hookAppliesAt('agent:pre-tool'), 'next-agent');
  assert.equal(hookAppliesAt('cc:PermissionRequest'), 'next-agent');
  assert.equal(hookAppliesAt('pi:tool_call'), 'next-agent');
});
