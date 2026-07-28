// input:  vitest, session-activity-tracker hook module
// output: Path-only Read/Edit/Write/Skill activity regressions
// pos:    Session activity hook behavioral tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

function mkTemp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function moduleUrl(rel: string): string {
  return pathToFileURL(path.join(process.cwd(), rel)).href + `?t=${Date.now()}-${Math.random()}`;
}

test('session activity tracker logs Read/Edit/Skill to session file', async () => {
  const root = mkTemp('session-activity-');
  const sessionId = '11111111-2222-4333-8444-555555555555';

  try {
    process.env.CORTEX_SESSION_ID = sessionId;
    process.env.CORTEX_HOME = root;

    const tracker = await import(moduleUrl('defaults/hooks/session-activity-tracker.mjs'));

    const readPayload = {
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/a.md' },
      tool_response: { success: true },
    };
    const editPayload = {
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/b.md' },
      tool_response: { success: true },
    };
    const skillPayload = {
      tool_name: 'Skill',
      tool_input: { skill: 'develop' },
      tool_response: { success: true },
    };

    tracker.processPayload(readPayload);
    tracker.processPayload(editPayload);
    tracker.processPayload(skillPayload);

    const logPath = path.join(root, 'logs', 'session-activity', `${sessionId}.jsonl`);
    assert.equal(fs.existsSync(logPath), true);

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(lines.length, 3);

    assert.equal(lines[0].event, 'read_file');
    assert.equal(lines[0].tool, 'Read');
    assert.equal(lines[0].file_path, '/tmp/a.md');
    assert.equal(lines[0].session_id, sessionId);

    assert.equal(lines[1].event, 'edit_file');
    assert.equal(lines[1].tool, 'Edit');
    assert.equal(lines[1].file_path, '/tmp/b.md');

    assert.equal(lines[2].event, 'skill_use');
    assert.equal(lines[2].tool, 'Skill');
    assert.equal(lines[2].skill, 'develop');
    assert.equal(lines[2].success, true);
  } finally {
    delete process.env.CORTEX_HOME;
    delete process.env.CORTEX_SESSION_ID;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('session activity tracker only logs successful Skill uses', async () => {
  const root = mkTemp('session-activity-skill-');
  const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  try {
    process.env.CORTEX_SESSION_ID = sessionId;
    process.env.CORTEX_HOME = root;

    const tracker = await import(moduleUrl('defaults/hooks/session-activity-tracker.mjs'));

    tracker.processPayload({
      tool_name: 'Skill',
      tool_input: { skill: 'develop' },
      tool_response: { success: false },
    });

    tracker.processPayload({
      tool_name: 'Skill',
      tool_input: { skill: 'develop' },
      tool_response: { success: true },
    });

    const logPath = path.join(root, 'logs', 'session-activity', `${sessionId}.jsonl`);
    const lines = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];

    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, 'skill_use');
    assert.equal(lines[0].success, true);
  } finally {
    delete process.env.CORTEX_HOME;
    delete process.env.CORTEX_SESSION_ID;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('session activity tracker records local mutations without file contents', async () => {
  const root = mkTemp('session-activity-local-mutations-');
  const sessionId = 'cccccccc-1111-4222-8333-444444444444';
  try {
    process.env.CORTEX_SESSION_ID = sessionId;
    process.env.CORTEX_HOME = root;
    const tracker = await import(moduleUrl('defaults/hooks/session-activity-tracker.mjs'));
    tracker.processPayload({
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/edited.md' },
      tool_response: {
        originalFile: 'private-before\n',
        structuredPatch: [{ lines: ['-private-before', '+private-after'] }],
      },
    });
    tracker.processPayload({
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/created.md', content: 'private-after\n' },
      tool_response: { originalFile: null, content: 'private-after\n' },
    });

    const logPath = path.join(root, 'logs', 'session-activity', `${sessionId}.jsonl`);
    const records = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(records.map(({ ts: _ts, ...record }) => record), [
      { session_id: sessionId, tool: 'Edit', event: 'edit_file', file_path: '/tmp/edited.md' },
      { session_id: sessionId, tool: 'Write', event: 'write_file', file_path: '/tmp/created.md' },
    ]);
  } finally {
    delete process.env.CORTEX_HOME;
    delete process.env.CORTEX_SESSION_ID;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('session activity tracker records remote mutations without response payloads', async () => {
  const root = mkTemp('session-activity-remote-mutations-');
  const sessionId = 'eeeeeeee-1111-4222-8333-666666666666';
  try {
    process.env.CORTEX_SESSION_ID = sessionId;
    process.env.CORTEX_HOME = root;
    const tracker = await import(moduleUrl('defaults/hooks/session-activity-tracker.mjs'));
    const privatePayload = JSON.stringify({
      originalFile: 'private-before\n',
      structuredPatch: [{ lines: ['-private-before', '+private-after'] }],
    });
    tracker.processPayload({
      tool_name: 'mcp__cortex__remote_edit',
      tool_input: { device: 'lab', file_path: '/srv/x.md', old_string: 'before', new_string: 'after' },
      tool_response: [
        { type: 'text', text: 'File edited: /srv/x.md' },
        { type: 'text', text: privatePayload },
      ],
    });

    const logPath = path.join(root, 'logs', 'session-activity', `${sessionId}.jsonl`);
    const [{ ts: _ts, ...record }] = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(record, {
      session_id: sessionId,
      tool: 'Edit',
      event: 'edit_file',
      file_path: '/srv/x.md',
      device: 'lab',
    });
  } finally {
    delete process.env.CORTEX_HOME;
    delete process.env.CORTEX_SESSION_ID;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('session activity tracker records every event without time-window dedupe', async () => {
  // Net-diff reconstruction requires every Edit/Write to be captured; dropping a duplicate
  // would silently lose a hunk. Read/Skill have no such constraint but we keep one policy.
  const root = mkTemp('session-activity-no-dedupe-');
  const sessionId = '99999999-8888-4777-8666-555555555555';

  try {
    process.env.CORTEX_SESSION_ID = sessionId;
    process.env.CORTEX_HOME = root;

    const tracker = await import(moduleUrl('defaults/hooks/session-activity-tracker.mjs'));

    tracker.processPayload({
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/same.md' },
      tool_response: { success: true },
    });

    tracker.processPayload({
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/same.md' },
      tool_response: { success: true },
    });

    const logPath = path.join(root, 'logs', 'session-activity', `${sessionId}.jsonl`);
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

    assert.equal(lines.length, 2);
    assert.equal(lines[0].event, 'read_file');
    assert.equal(lines[1].event, 'read_file');
  } finally {
    delete process.env.CORTEX_HOME;
    delete process.env.CORTEX_SESSION_ID;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
