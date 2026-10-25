import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccessVerifier } from '../src/access.js';
import { loadDashboard } from '../src/dashboard/handler.js';
import { histogramCounts, percentileSlot, slotLabel } from '../src/dashboard/stats.js';
import type { Env } from '../src/env.js';
import { handleRequest } from '../src/index.js';
import { D1_MAX_COMPOUND_TERMS, REPORT_NAMES, REPORTS, reportFilter } from '../src/reports.js';
import { NOW, crashEvent, envelope, everyEventType, sampleBatch } from './fixtures.js';
import { sqliteD1 } from './helpers/sqlite-d1.js';

const deps = { verifier: createAccessVerifier(async () => new Response('{}')), now: NOW };
const DEV_ID = '0b9d6c1e-2f3a-4c5d-9e8f-7a6b5c4d3e2f';

async function ingest(env: Env, body: unknown): Promise<void> {
  const request = new Request('https://telemetry.example.com/v1/batch', { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await handleRequest(request, env, deps)).status, 204);
}

async function seeded(): Promise<Env> {
  const env: Env = { DB: sqliteD1().db, DASHBOARD_LOCAL_BYPASS: '1' };
  await ingest(env, sampleBatch());
  const hostile = crashEvent({ message: '<script>alert(1)</script>', groupKey: 'XSS@<img src=x>' });
  await ingest(env, { envelope: envelope({ installId: DEV_ID, channel: 'dev' }), events: [...everyEventType(), hostile] });
  return env;
}

test('every report runs and the release filter excludes dev installs', async () => {
  const env = await seeded();
  const release = await loadDashboard(env.DB, reportFilter(NOW, 30, false));
  const all = await loadDashboard(env.DB, reportFilter(NOW, 30, true));
  assert.deepEqual(Object.keys(release).sort(), [...REPORT_NAMES].sort());
  assert.equal(release.activeSummary[0].today, 1);
  assert.equal(all.activeSummary[0].today, 2);
  assert.equal(release.activeSummary[0].crashing_installs, 1);

  const claude = release.turnHealth.find(row => row.backend === 'claude');
  assert.deepEqual({ completed: claude?.completed, failed: claude?.failed }, { completed: 40, failed: 3 });
  assert.equal(release.turnTotals[0].failed, 7);
  const funnel = Object.fromEntries(release.funnel.map(row => [`${row.step}/${row.detail}`, row.installs]));
  assert.equal(funnel['provider_authed/claude'], 1);
  assert.equal(release.errorGroups[0].message, 'EPERM: operation not permitted, fsync <path>');
  assert.equal(release.features.find(row => row.feature === 'worker_spawned')?.installs, 1);
  assert.equal(release.startupPhases[0].phase, 'adapters');
});

test('histogram percentiles resolve to bucket bounds', async () => {
  const data = await loadDashboard((await seeded()).DB, reportFilter(NOW, 30, false));
  const counts = histogramCounts(data.turnHistograms, 'ttftMs', 8);
  assert.deepEqual(counts, [2, 2, 4, 2, 2, 0, 0, 0]);
  const bounds = [500, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
  assert.equal(slotLabel(percentileSlot(counts, 0.5), bounds, String), '≤ 2000');
  assert.equal(slotLabel(percentileSlot(counts, 0.99), bounds, String), '≤ 10000');
  assert.equal(slotLabel(percentileSlot([0, 0, 1], 0.5), [1, 2], String), '> 2');
  assert.equal(slotLabel(percentileSlot([0, 0, 0], 0.5), [1, 2], String), '–');
});

test('the page renders every section and escapes reported text', async () => {
  const env = await seeded();
  const response = await handleRequest(new Request('http://localhost:8787/dashboard?days=7&dev=1'), env, deps);
  assert.equal(response.status, 200);
  const html = await response.text();
  for (const title of ['Active installs', 'Onboarding funnel', 'Top crash groups', 'Error digest', 'Turn health',
    'Feature usage', 'Performance', 'Upgrades and migrations']) {
    assert.ok(html.includes(`<h2>${title}</h2>`), title);
  }
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img src=x>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/);
});

test('no report exceeds the D1 compound SELECT limit', () => {
  for (const name of REPORT_NAMES) {
    const { sql } = REPORTS[name].build(reportFilter(NOW, 30, false));
    const terms = sql.split(/\bUNION\b/i).length;
    assert.ok(terms <= D1_MAX_COMPOUND_TERMS, `${name}: ${terms} terms`);
  }
});
