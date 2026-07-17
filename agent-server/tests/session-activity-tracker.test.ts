// input:  node:test, session-activity-tracker hook module
// output: Read/Edit/Skill session JSONL logging and sideband path tests
// pos:    session-activity-tracker hook regression test
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

test('session activity tracker captures diff snapshot from local Edit tool_response', async () => {
  const root = mkTemp('session-activity-edit-diff-');
  const sessionId = 'cccccccc-1111-4222-8333-444444444444';
  try {
    process.env.CORTEX_SESSION_ID = sessionId;
    process.env.CORTEX_HOME = root;
    const tracker = await import(moduleUrl('defaults/hooks/session-activity-tracker.mjs'));
    tracker.processPayload({
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/edited.md' },
      tool_response: {
        filePath: '/tmp/edited.md',
        oldString: 'a', newString: 'b',
        originalFile: 'a\n',
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
        userModified: false, replaceAll: false,
      },
    });
    const logPath = path.join(root, 'logs', 'session-activity', `${sessionId}.jsonl`);
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, 'edit_file');
    assert.equal(lines[0].originalFile, 'a\n');
    assert.equal(lines[0].structuredPatch.length, 1);
    assert.equal(lines[0].structuredPatch[0].lines[0], '-a');
  } finally {
    delete process.env.CORTEX_HOME;
    delete process.env.CORTEX_SESSION_ID;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('session activity tracker captures writtenContent from local Write create', async () => {
  const root = mkTemp('session-activity-write-create-');
  const sessionId = 'dddddddd-1111-4222-8333-555555555555';
  try {
    process.env.CORTEX_SESSION_ID = sessionId;
    process.env.CORTEX_HOME = root;
    const tracker = await import(moduleUrl('defaults/hooks/session-activity-tracker.mjs'));
    tracker.processPayload({
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/created.md', content: 'fresh\n' },
      tool_response: {
        type: 'create', filePath: '/tmp/created.md', content: 'fresh\n',
        structuredPatch: [], originalFile: null, userModified: false,
      },
    });
    const logPath = path.join(root, 'logs', 'session-activity', `${sessionId}.jsonl`);
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, 'write_file');
    assert.equal(lines[0].originalFile, null);
    assert.equal(lines[0].writtenContent, 'fresh\n');
  } finally {
    delete process.env.CORTEX_HOME;
    delete process.env.CORTEX_SESSION_ID;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('session activity tracker parses cortex-diff-data marker from MCP remote_edit response', async () => {
  const root = mkTemp('session-activity-remote-edit-');
  const sessionId = 'eeeeeeee-1111-4222-8333-666666666666';
  try {
    process.env.CORTEX_SESSION_ID = sessionId;
    process.env.CORTEX_HOME = root;
    const tracker = await import(moduleUrl('defaults/hooks/session-activity-tracker.mjs'));
    const marker = JSON.stringify({
      device: 'lab', file_path: '/srv/x.md', tool: 'edit',
      originalFile: 'old\n',
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }],
      writtenContent: null, degraded: false,
    });
    tracker.processPayload({
      tool_name: 'mcp__cortex__remote_edit',
      tool_input: { device: 'lab', file_path: '/srv/x.md', old_string: 'old', new_string: 'new' },
      tool_response: [
        { type: 'text', text: 'File edited: /srv/x.md' },
        { type: 'text', text: `<!--cortex-diff-data\n${marker}\n-->` },
      ],
    });
    const logPath = path.join(root, 'logs', 'session-activity', `${sessionId}.jsonl`);
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, 'edit_file');
    assert.equal(lines[0].device, 'lab');
    assert.equal(lines[0].file_path, '/srv/x.md');
    assert.equal(lines[0].originalFile, 'old\n');
    assert.equal(lines[0].structuredPatch.length, 1);
  } finally {
    delete process.env.CORTEX_HOME;
    delete process.env.CORTEX_SESSION_ID;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('session activity tracker tolerates missing/malformed diff marker on MCP response', async () => {
  const root = mkTemp('session-activity-remote-missing-');
  const sessionId = 'ffffffff-1111-4222-8333-777777777777';
  try {
    process.env.CORTEX_SESSION_ID = sessionId;
    process.env.CORTEX_HOME = root;
    const tracker = await import(moduleUrl('defaults/hooks/session-activity-tracker.mjs'));
    tracker.processPayload({
      tool_name: 'mcp__cortex__remote_write',
      tool_input: { device: 'lab', file_path: '/srv/y.md', content: 'x' },
      tool_response: [{ type: 'text', text: 'File written: /srv/y.md' }], // no marker
    });
    tracker.processPayload({
      tool_name: 'mcp__cortex__remote_write',
      tool_input: { device: 'lab', file_path: '/srv/z.md', content: 'x' },
      tool_response: [{ type: 'text', text: '<!--cortex-diff-data\n{not json\n-->' }], // malformed
    });
    const logPath = path.join(root, 'logs', 'session-activity', `${sessionId}.jsonl`);
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    for (const r of lines) {
      assert.equal(r.event, 'write_file');
      assert.equal(r.device, 'lab');
      assert.equal(r.originalFile, undefined);
      assert.equal(r.structuredPatch, undefined);
    }
  } finally {
    delete process.env.CORTEX_HOME;
    delete process.env.CORTEX_SESSION_ID;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('session activity tracker reads sideband diff file by tool_use_id and unlinks it', async () => {
  // mcp-server persists diff payload to {WORKSPACE_DIR}/diff-markers/<tool_use_id>.json
  // and the tool_response content[] contains NO inline marker. Hook must pick up the sideband file.
  const root = mkTemp('session-activity-sideband-');
  const sessionId = '12341234-aaaa-4bbb-8ccc-ddddddddeeee';
  const toolUseId = 'toolu_sideband_abc123';
  const sidebandDir = path.join(root, 'tmp', 'diff-markers');
  try {
    process.env.CORTEX_SESSION_ID = sessionId;
    process.env.CORTEX_HOME = root;
    // DATA_DIR = CORTEX_HOME, WORKSPACE_DIR = DATA_DIR/tmp, DIFF_MARKERS_DIR = WORKSPACE_DIR/diff-markers
    const sidebandPath = path.join(sidebandDir, `${toolUseId}.json`);
    fs.mkdirSync(sidebandDir, { recursive: true });
    fs.writeFileSync(sidebandPath, JSON.stringify({
      device: 'lab', file_path: '/srv/side.md', tool: 'edit',
      originalFile: 'O\n',
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-O', '+N'] }],
      writtenContent: null, degraded: false,
    }));
    try {
      const tracker = await import(moduleUrl('defaults/hooks/session-activity-tracker.mjs'));
      tracker.processPayload({
        tool_name: 'mcp__cortex__remote_edit',
        tool_input: { device: 'lab', file_path: '/srv/side.md', old_string: 'O', new_string: 'N' },
        tool_response: [{ type: 'text', text: 'File edited: /srv/side.md' }], // NO inline marker
        tool_use_id: toolUseId,
      });
      const logPath = path.join(root, 'logs', 'session-activity', `${sessionId}.jsonl`);
      const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      assert.equal(lines.length, 1);
      assert.equal(lines[0].event, 'edit_file');
      assert.equal(lines[0].device, 'lab');
      assert.equal(lines[0].originalFile, 'O\n');
      assert.equal(lines[0].structuredPatch.length, 1);
      // Sideband file must be unlinked after successful read.
      assert.equal(fs.existsSync(sidebandPath), false);
    } finally {
      // Defensive cleanup in case the unlink assertion failed.
      try { fs.unlinkSync(sidebandPath); } catch { /* ignore */ }
    }
  } finally {
    delete process.env.CORTEX_HOME;
    delete process.env.CORTEX_SESSION_ID;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('session activity tracker falls back to inline marker when sideband file is missing', async () => {
  // Back-compat: older mcp-server build or non-Claude-Code client that doesn't emit a
  // sideband file must still be tracked via the inline `<!--cortex-diff-data ... -->` block.
  const root = mkTemp('session-activity-fallback-');
  const sessionId = '56785678-aaaa-4bbb-8ccc-ffffffffffff';
  const toolUseId = 'toolu_nofile_xyz999';
  try {
    process.env.CORTEX_SESSION_ID = sessionId;
    process.env.CORTEX_HOME = root;
    const tracker = await import(moduleUrl('defaults/hooks/session-activity-tracker.mjs'));
    const marker = JSON.stringify({
      device: 'lab', file_path: '/srv/legacy.md', tool: 'edit',
      originalFile: 'A\n',
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-A', '+B'] }],
      writtenContent: null, degraded: false,
    });
    tracker.processPayload({
      tool_name: 'mcp__cortex__remote_edit',
      tool_input: { device: 'lab', file_path: '/srv/legacy.md', old_string: 'A', new_string: 'B' },
      tool_response: [
        { type: 'text', text: 'File edited: /srv/legacy.md' },
        { type: 'text', text: `<!--cortex-diff-data\n${marker}\n-->` },
      ],
      tool_use_id: toolUseId,
    });
    const logPath = path.join(root, 'logs', 'session-activity', `${sessionId}.jsonl`);
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, 'edit_file');
    assert.equal(lines[0].originalFile, 'A\n');
    assert.equal(lines[0].structuredPatch.length, 1);
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
