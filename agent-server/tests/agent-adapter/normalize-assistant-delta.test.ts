// input:  NormalizedEvent union + Capability matrix + runWithAdapter event loop
// output: spec for the `assistant_delta` normalized event and its facade dispatch
// pos:    Token-level assistant streaming — the backend-agnostic middle of the vertical
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, test } from 'vitest';
import assert from 'node:assert/strict';

import type { NormalizedEvent } from '../../src/agent-adapter/normalize/event-types.js';
import { Capability, CAPABILITIES_BY_BACKEND } from '../../src/agent-adapter/capabilities.js';

describe('assistant_delta normalized event', () => {
  test('is part of the NormalizedEvent union with text + blockId', () => {
    const ev: NormalizedEvent = { type: 'assistant_delta', text: 'chunk', blockId: 'msg_1:0' };
    assert.equal(ev.type, 'assistant_delta');
    // `text` is the INCREMENT, never the accumulated total — enforced by the producers, asserted
    // end-to-end in claude-stream-deltas.test.ts ("sum of the deltas equals the finalizing text").
    assert.equal(ev.text, 'chunk');
    assert.equal(ev.blockId, 'msg_1:0');
  });
});

describe('Capability.StreamingDeltas', () => {
  test('Claude declares it (print mode emits stream_event lines)', () => {
    assert.ok(CAPABILITIES_BY_BACKEND.claude.has(Capability.StreamingDeltas));
  });

  test('Codex does not — it is out of scope for streaming', () => {
    assert.ok(!CAPABILITIES_BY_BACKEND.codex.has(Capability.StreamingDeltas));
  });

  test('the enum value is the stable wire string', () => {
    assert.equal(Capability.StreamingDeltas, 'streaming-deltas');
  });
});
