import { test } from 'vitest';
import assert from 'node:assert/strict';
import { isTeamLead, isTeamWorker } from '../../../src/domain/sessions/team.js';

test('a lead is a web direct session that is not a worker, and only while team mode is on', () => {
  const web = { origin: 'direct', channel: 'web:s1', teamLeadId: null };
  assert.equal(isTeamLead(web, true), true);
  assert.equal(isTeamLead(web, false), false);
  assert.equal(isTeamLead({ ...web, channel: 'slack:C1' }, true), false);
  assert.equal(isTeamLead({ ...web, origin: 'scheduled' }, true), false);
  assert.equal(isTeamLead({ ...web, teamLeadId: 'lead' }, true), false);
  assert.equal(isTeamLead(null, true), false);
});

test('a worker is a worker only while team mode is on', () => {
  assert.equal(isTeamWorker({ teamLeadId: 'lead' }, true), true);
  assert.equal(isTeamWorker({ teamLeadId: 'lead' }, false), false);
  assert.equal(isTeamWorker({ teamLeadId: null }, true), false);
});
