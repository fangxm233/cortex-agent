// input:  vitest + domain/threads/template-writer over a temp thread-templates directory
// output: readEntity / saveEntity / removeEntity coverage — create, update, no-op, validation
//         rejection, optimistic-concurrency conflict, name safety, and the delete guard
// pos:    Everything here is hermetic over an explicit `dir`; nothing touches the real config.
//         The rules under test are the ones that keep a UI edit from breaking a running thread:
//         a save that would not validate never reaches disk, and a stale editor cannot silently
//         discard an edit that landed underneath it.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, describe, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  readEntity,
  saveEntity,
  removeEntity,
  listEntityNames,
  entityPath,
  sha256,
} from '../../src/domain/threads/template-writer.js';

let dir: string;

function agentBody(name: string, stages: string[] = ['work']) {
  return {
    name,
    description: `${name} agent`,
    profile: 'plan',
    persistSession: true,
    tools: 'Read',
    entryStage: stages[0],
    stages: Object.fromEntries(stages.map((s) => [s, { promptTemplate: `${s}: {{input}}` }])),
  };
}

function templateBody(name: string) {
  return {
    name,
    description: 'a → b',
    agents: ['a', 'b'],
    transitions: [{ from: 'a:work', to: 'b:work', condition: { type: 'always' } }],
    entryAgent: 'a',
    entryStage: 'work',
    maxTotalSteps: 2,
  };
}

function seed(kind: 'agents' | 'templates' | 'shells', name: string, body: unknown): void {
  const sub = path.join(dir, kind);
  mkdirSync(sub, { recursive: true });
  writeFileSync(path.join(sub, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

function expectError(fn: () => unknown, code: string, match?: RegExp): void {
  try {
    fn();
  } catch (error) {
    assert.equal((error as { code?: string }).code, code, `wrong code: ${(error as Error).message}`);
    if (match) assert.match((error as Error).message, match);
    return;
  }
  assert.fail(`expected a '${code}' error`);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cortex-tpl-'));
  seed('agents', 'a', agentBody('a'));
  seed('agents', 'b', agentBody('b'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('create', () => {
  test('writes a new entity and reports the hash of what landed', () => {
    const result = saveEntity(dir, { kind: 'template', name: 'ab', body: templateBody('ab'), baseHash: null });
    assert.equal(result.changed, true);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.filePath, entityPath(dir, 'template', 'ab'));

    const onDisk = readFileSync(result.filePath, 'utf8');
    assert.equal(result.sha256, sha256(onDisk));
    assert.equal(onDisk.endsWith('}\n'), true, 'expected a trailing newline');
    assert.deepEqual(JSON.parse(onDisk), templateBody('ab'));
  });

  test('refuses to create over an existing file', () => {
    saveEntity(dir, { kind: 'template', name: 'ab', body: templateBody('ab'), baseHash: null });
    expectError(
      () => saveEntity(dir, { kind: 'template', name: 'ab', body: templateBody('ab'), baseHash: null }),
      'invalid-args',
      /already exists/,
    );
  });

  test('rejects names that could escape the directory', () => {
    for (const name of ['../evil', 'a/b', '..', '.hidden', '']) {
      expectError(
        () => saveEntity(dir, { kind: 'agent', name, body: agentBody('x'), baseHash: null }),
        'invalid-args',
        /must start with a letter or digit/,
      );
    }
    assert.deepEqual(listEntityNames(dir, 'agent'), ['a', 'b']);
  });
});

describe('update', () => {
  test('replaces the body and treats an identical save as a no-op', () => {
    saveEntity(dir, { kind: 'template', name: 'ab', body: templateBody('ab'), baseHash: null });
    const read = readEntity(dir, 'template', 'ab');

    const same = saveEntity(dir, { kind: 'template', name: 'ab', body: templateBody('ab'), baseHash: read.sha256 });
    assert.equal(same.changed, false);

    const edited = { ...templateBody('ab'), maxTotalSteps: 6 };
    const changed = saveEntity(dir, { kind: 'template', name: 'ab', body: edited, baseHash: read.sha256 });
    assert.equal(changed.changed, true);
    assert.equal(JSON.parse(readFileSync(changed.filePath, 'utf8')).maxTotalSteps, 6);
  });

  test('omitted fields are removed, not merged', () => {
    saveEntity(dir, { kind: 'template', name: 'ab', body: templateBody('ab'), baseHash: null });
    const read = readEntity(dir, 'template', 'ab');
    const without = { ...templateBody('ab') } as Record<string, unknown>;
    delete without.entryStage;

    saveEntity(dir, { kind: 'template', name: 'ab', body: without, baseHash: read.sha256 });
    assert.equal('entryStage' in JSON.parse(readFileSync(entityPath(dir, 'template', 'ab'), 'utf8')), false);
  });

  test('updating something that does not exist is not-found', () => {
    expectError(
      () => saveEntity(dir, { kind: 'template', name: 'ghost', body: templateBody('ghost'), baseHash: 'abc' }),
      'not-found',
    );
  });
});

describe('optimistic concurrency', () => {
  test('a stale baseHash is a conflict, and the file is left untouched', () => {
    saveEntity(dir, { kind: 'template', name: 'ab', body: templateBody('ab'), baseHash: null });
    const stale = readEntity(dir, 'template', 'ab').sha256;

    // Someone else edits the file (hot-reload / git sync / hand edit).
    saveEntity(dir, { kind: 'template', name: 'ab', body: { ...templateBody('ab'), maxTotalSteps: 9 }, baseHash: stale });
    const theirs = readFileSync(entityPath(dir, 'template', 'ab'), 'utf8');

    expectError(
      () => saveEntity(dir, { kind: 'template', name: 'ab', body: { ...templateBody('ab'), maxTotalSteps: 3 }, baseHash: stale }),
      'conflict',
      /changed on disk/,
    );
    assert.equal(readFileSync(entityPath(dir, 'template', 'ab'), 'utf8'), theirs, 'the other edit must survive');
  });
});

describe('validation gate', () => {
  test('a template naming an unknown agent never reaches disk', () => {
    const bad = { ...templateBody('ab'), agents: ['a', 'ghost'] };
    expectError(() => saveEntity(dir, { kind: 'template', name: 'ab', body: bad, baseHash: null }), 'invalid-args', /unknown agent/);
    assert.equal(existsSync(entityPath(dir, 'template', 'ab')), false);
  });

  test('the thrown error carries the field-anchored issues', () => {
    const bad = { ...templateBody('ab'), entryAgent: 'nobody' };
    try {
      saveEntity(dir, { kind: 'template', name: 'ab', body: bad, baseHash: null });
      assert.fail('expected a rejection');
    } catch (error) {
      const issues = (error as { issues?: Array<{ path: string }> }).issues ?? [];
      assert.ok(issues.some((i) => i.path === 'entryAgent'), JSON.stringify(issues));
    }
  });

  test('an edit that breaks a dependent template is refused', () => {
    seed('templates', 'ab', templateBody('ab'));
    // Dropping the `work` stage breaks the ab template's transitions, which pin a:work.
    const bad = agentBody('a', ['other']);
    expectError(() => saveEntity(dir, { kind: 'agent', name: 'a', body: bad, baseHash: readEntity(dir, 'agent', 'a').sha256 }), 'invalid-args', /template:ab/);
  });

  test('warnings are returned, not enforced', () => {
    const body = { ...agentBody('c'), futureField: 'x' };
    const result = saveEntity(dir, { kind: 'agent', name: 'c', body, baseHash: null });
    assert.equal(result.changed, true);
    assert.ok(result.warnings.some((w) => w.path === 'futureField'), JSON.stringify(result.warnings));
  });

  test('the name field must agree with the filename', () => {
    expectError(
      () => saveEntity(dir, { kind: 'agent', name: 'c', body: agentBody('different'), baseHash: null }),
      'invalid-args',
      /must equal the filename/,
    );
  });
});

describe('remove', () => {
  test('deletes an unreferenced entity', () => {
    saveEntity(dir, { kind: 'agent', name: 'c', body: agentBody('c'), baseHash: null });
    const result = removeEntity(dir, 'agent', 'c');
    assert.equal(result.removed, true);
    assert.equal(existsSync(result.filePath), false);
  });

  test('refuses while a template still declares the agent', () => {
    seed('templates', 'ab', templateBody('ab'));
    expectError(() => removeEntity(dir, 'agent', 'a'), 'invalid-args', /still used by 1 template\(s\): ab/);
    assert.equal(existsSync(entityPath(dir, 'agent', 'a')), true);
  });

  test('a template has no config-level dependents and can always go', () => {
    seed('templates', 'ab', templateBody('ab'));
    assert.equal(removeEntity(dir, 'template', 'ab').removed, true);
  });

  test('removing something that does not exist is not-found', () => {
    expectError(() => removeEntity(dir, 'agent', 'ghost'), 'not-found');
  });
});

describe('read', () => {
  test('returns the body, the path and a hash that round-trips into a save', () => {
    const read = readEntity(dir, 'agent', 'a');
    assert.equal(read.name, 'a');
    assert.equal(read.body?.name, 'a');
    assert.equal(read.sha256, sha256(readFileSync(read.filePath, 'utf8')));
    saveEntity(dir, { kind: 'agent', name: 'a', body: { ...agentBody('a'), description: 'edited' }, baseHash: read.sha256 });
  });

  test('an unparseable file reads as a null body rather than throwing', () => {
    mkdirSync(path.join(dir, 'agents'), { recursive: true });
    writeFileSync(path.join(dir, 'agents', 'broken.json'), '{ not json', 'utf8');
    assert.equal(readEntity(dir, 'agent', 'broken').body, null);
  });
});
