// input:  encoded subagent notices and hostile / malformed strings
// output: round-trip and strict-rejection specs for the PI child→server channel
// pos:    PI subagent notice codec tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';

import {
  decodeSubagentNotice, encodeSubagentNotice, type SubagentNotice,
} from '../../src/agent-adapter/pi/subagent-notice.js';

const BASE = { ref: 'tool-1#0', type: 'explore', description: 'survey', model: 'pi-model' };

test('every notice kind round-trips', () => {
  const notices: SubagentNotice[] = [
    { ...BASE, kind: 'tool_use', toolUseId: 'tool-1#0:c1', name: 'grep', input: { pattern: 'x' } },
    { ...BASE, kind: 'tool_result', toolUseId: 'tool-1#0:c1', ok: false, content: 'boom' },
    { ...BASE, kind: 'assistant_text', text: 'findings' },
  ];
  for (const notice of notices) {
    assert.deepEqual(decodeSubagentNotice(encodeSubagentNotice(notice)), notice);
  }
});

test('anything that is not our notice decodes to null', () => {
  // The channel is shared: real user notifications and the quota probe's readings ride it too.
  // Claiming one of those would put a fabricated subagent row in the transcript.
  for (const message of [
    'a plain user notification',
    'cortex:provider-quota:{"windows":[]}',
    '',
    null,
    undefined,
    42,
    'cortex:subagent-event:not json',
    'cortex:subagent-event:[]',
    'cortex:subagent-event:"a string"',
  ]) {
    assert.equal(decodeSubagentNotice(message as unknown), null, String(message));
  }
});

test('a notice missing what its kind needs is rejected, not half-built', () => {
  // A row attributed to a subagent that cannot be named is worse than no row: it would open an
  // unlabelled block that never fills in.
  const bad = [
    { ...BASE, kind: 'tool_use', toolUseId: 'c1' },                 // no name
    { ...BASE, kind: 'tool_use', name: 'grep' },                    // no toolUseId
    { ...BASE, kind: 'tool_result' },                               // no toolUseId
    { ...BASE, kind: 'assistant_text' },                            // no text
    { ...BASE, kind: 'assistant_text', text: '' },                  // empty text
    { ...BASE, kind: 'something_else', text: 'x' },                 // unknown kind
    { ref: '', kind: 'assistant_text', text: 'x' },                 // no block key
  ];
  for (const notice of bad) {
    assert.equal(
      decodeSubagentNotice('cortex:subagent-event:' + JSON.stringify(notice)),
      null,
      JSON.stringify(notice),
    );
  }
});

test('a notice with no model reports null rather than borrowing one', () => {
  // The child names its own model on its own messages. Until one arrives the field is unknown,
  // and the parent's model is NOT a stand-in — a subagent may run on a different one entirely.
  const decoded = decodeSubagentNotice(encodeSubagentNotice({
    ref: 'tool-1#0', type: 'explore', description: 'survey', model: null,
    kind: 'assistant_text', text: 'early words',
  }));
  assert.equal(decoded?.model, null);
});
