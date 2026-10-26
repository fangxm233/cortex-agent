import { beforeAll, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('@domain/agents/index.js', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  getDefaultAgent: () => 'main',
}));
vi.mock('@domain/agents/environments/index.js', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  resolveEnvironmentByName: () => ({
    directive: 'DIRECTIVE', systemPrompt: null, promptTemplate: '{{input}}',
    claudeAgent: null, outputStyle: null, tools: null, pluginDirs: null,
  }),
}));
vi.mock('@domain/projects/index.js', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  projectStore: { get: () => ({ id: 'orchard', name: 'orchard', kind: 'user', contextDir: '/ctx/projects/orchard' }) },
}));
vi.mock('@domain/boards/board-context.js', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  loadBoardPromptContext: async (id: string) => ({ id, title: 'Atlas', dir: '/ctx/boards/atlas' }),
}));

import { prepareConversationRequest } from '../../src/orchestration/conversation-request.js';
import { sessionStore, type Session } from '../../src/store/session-registry-repo.js';
import { createWorkspace } from '../../src/core/workspace.js';
import { WORKSPACE_DIR } from '../../src/core/paths.js';
import { seedSelections } from './selection-fixture.js';

beforeAll(seedSelections);

async function register(sessionId: string, extra: Record<string, unknown>): Promise<Session> {
  await sessionStore.registerSession({
    sessionId, channel: `web:${sessionId}`, backend: 'claude', kind: 'local', projectId: 'orchard',
    boardId: 'b-1', ...extra,
  });
  return (await sessionStore.getById(sessionId))!;
}

function upload(name: string, body: string): string {
  const dir = path.join(WORKSPACE_DIR, 'attachments', 'up');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

async function prepare(session: Session, files: { localPath: string; mimetype: string; name: string }[] = []) {
  return prepareConversationRequest({
    ids: { sessionId: session.sessionId, backendSessionId: null, projectId: 'orchard' },
    channel: session.channel, session, userMessage: 'hello', files,
  });
}

test('a clean session runs in its workspace under the clean policy, told nothing about Cortex', async () => {
  const workspace = createWorkspace('clean-1');
  const session = await register('clean-1', { clean: true, workspaceDir: workspace });
  const { request } = await prepare(session);
  assert.equal(request.cwd, workspace);
  assert.equal(request.policy.clean, true);
  assert.equal(request.policy.hooks, false);
  assert.equal(request.policy.loadRules, false);
  const text = request.prompt.text;
  assert.ok(text.includes('DIRECTIVE'));
  for (const block of ['[Session Project]', '[Session Transcripts]', '[Board]']) {
    assert.ok(!text.includes(block), `${block} is withheld`);
  }
});

test('an ordinary session keeps the default cwd and its project, transcript and board blocks', async () => {
  const session = await register('plain-1', {});
  const { request } = await prepare(session);
  assert.equal(request.cwd, undefined);
  assert.equal(request.policy.clean, undefined);
  for (const block of ['[Session Project]', '[Session Transcripts]', '[Board]']) {
    assert.ok(request.prompt.text.includes(block), `${block} is delivered`);
  }
});

test('a clean session\'s attachments are copied into inputs/ and given from there', async () => {
  const workspace = createWorkspace('clean-2');
  const session = await register('clean-2', { clean: true, workspaceDir: workspace });
  const source = upload('upload_1.png', 'png-bytes');
  const { request, backendPrompt } = await prepare(session, [{ localPath: source, mimetype: 'image/png', name: 'photo.png' }]);
  const copied = path.join(workspace, 'inputs', 'photo.png');
  assert.equal(fs.readFileSync(copied, 'utf8'), 'png-bytes');
  assert.deepEqual(request.prompt.attachments?.map(a => a.path), [copied]);
  assert.ok(backendPrompt.includes(copied));
  assert.ok(!backendPrompt.includes(WORKSPACE_DIR));
});
