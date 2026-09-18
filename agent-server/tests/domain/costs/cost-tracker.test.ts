import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';

import { detectProject, _resetProjectCache } from '../../../src/domain/costs/cost-tracker.js';

afterAll(() => {
  _resetProjectCache(); // restore lazy-load behavior
});

// ── Tag matching ──

test('[project:xxx] tag overrides everything', () => {
  _resetProjectCache(['orchard', 'cortex-self']);

  // Even when message contains a project dir name, tag wins
  assert.equal(detectProject('[project:override] check orchard status'), 'override');

  // Tag alone
  assert.equal(detectProject('[project:my-project] hello'), 'my-project');

  // Tag with non-existent project is still valid
  assert.equal(detectProject('[project:fantasy] something'), 'fantasy');
});

// ── Dynamic name matching ──

test('case-insensitive substring match on project names', () => {
  _resetProjectCache(['MyProject', 'another-app']);

  // Exact case match
  assert.equal(detectProject('fix another-app bug'), 'another-app');

  // Lowercase message
  assert.equal(detectProject('debug myproject issue'), 'MyProject');

  // Uppercase message
  assert.equal(detectProject('CHECK ANOTHER-APP STATUS'), 'another-app');
});

test('no match returns general', () => {
  _resetProjectCache(['orchard', 'cortex-self']);

  assert.equal(detectProject('some unrelated text'), 'general');
  assert.equal(detectProject('what time is it'), 'general');
  assert.equal(detectProject('/research-loop'), 'general'); // old hardcoded rule removed
  assert.equal(detectProject('start training'), 'general'); // old hardcoded rule removed
  assert.equal(detectProject('/scan'), 'general'); // redundant rule removed, still falls to general
});

test('longest match wins when multiple project names appear', () => {
  _resetProjectCache(['orchard', 'orchard-dataset']);

  // Message contains both, longer one wins
  assert.equal(detectProject('check orchard-dataset status'), 'orchard-dataset');

  // Only shorter appears
  assert.equal(detectProject('check orchard status'), 'orchard');
});

// ── Falsy / empty messages ──

test('null returns general', () => {
  _resetProjectCache(['orchard']);
  assert.equal(detectProject(null), 'general');
});

// ── Empty / missing project list ──

test('null cache (lazy load fallback) returns general', () => {
  _resetProjectCache(null);

  // With null cache, getProjectNames() will call loadProjectNames()
  // which reads the real PROJECTS_DIR. The result depends on what's on disk,
  // but tag should still work.
  assert.equal(detectProject('[project:explicit] message'), 'explicit');
});

// ── Cache behavior ──

test('_resetProjectCache with names pre-seeds the cache', () => {
  _resetProjectCache(['project-a']);
  assert.equal(detectProject('check project-a'), 'project-a');
  assert.equal(detectProject('check project-b'), 'general');

  // Update cache with new names
  _resetProjectCache(['project-a', 'project-b']);
  assert.equal(detectProject('check project-a'), 'project-a');
  assert.equal(detectProject('check project-b'), 'project-b');
});

// ── Ambiguity and edge cases ──

test('project name is substring of another but only partial appears', () => {
  _resetProjectCache(['atlas', 'atlas-extra', 'atlas-security']);
  // "atlas" is substring of both "atlas-extra" and "atlas-security", but message only contains "atlas"
  assert.equal(detectProject('atlas setup'), 'atlas');
});

test('hyphenated project names match correctly', () => {
  _resetProjectCache(['orchard', 'orchard-dataset', 'beacon-nav']);

  assert.equal(detectProject('orchard training script'), 'orchard');
  assert.equal(detectProject('orchard-dataset collection'), 'orchard-dataset');
  assert.equal(detectProject('beacon-nav experiment'), 'beacon-nav');
});
