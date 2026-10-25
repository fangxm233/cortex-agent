import { ACCESS_JWT_HEADER, accessConfig, type AccessVerifier } from '../access.js';
import type { D1Database, Env } from '../env.js';
import { jsonResponse, notFound } from '../http.js';
import { REPORT_NAMES, REPORTS, reportFilter, type ReportFilter } from '../reports.js';
import { renderDashboard, type DashboardData } from './page.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const DEFAULT_DAYS = 30;

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'",
};

/** The `.dev.vars` bypass only ever applies to a request addressed to the local machine. */
function localBypass(request: Request, env: Env): boolean {
  return env.DASHBOARD_LOCAL_BYPASS === '1' && LOCAL_HOSTS.has(new URL(request.url).hostname);
}

/** Null when the request may see the dashboard; 404 while Access is not configured. */
async function dashboardDenied(request: Request, env: Env, verifier: AccessVerifier): Promise<Response | null> {
  if (localBypass(request, env)) return null;
  const config = accessConfig(env);
  if (!config) return notFound();
  const token = request.headers.get(ACCESS_JWT_HEADER);
  if (token && await verifier.verify(token, config)) return null;
  return jsonResponse(403, { error: 'forbidden' });
}

/** Runs every report in one D1 batch (a single query against the per-invocation limit). */
export async function loadDashboard(db: D1Database, filter: ReportFilter): Promise<DashboardData> {
  const statements = REPORT_NAMES.map(name => {
    const query = REPORTS[name].build(filter);
    return db.prepare(query.sql).bind(...query.params);
  });
  const results = await db.batch(statements);
  return Object.fromEntries(REPORT_NAMES.map((name, i) => [name, results[i]?.results ?? []])) as DashboardData;
}

/** GET /dashboard[?days=7|30|90][&dev=1] */
export async function handleDashboard(
  request: Request,
  env: Env,
  verifier: AccessVerifier,
  now = new Date(),
): Promise<Response> {
  const denied = await dashboardDenied(request, env, verifier);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const filter = reportFilter(now, Number(params.get('days') ?? DEFAULT_DAYS), params.get('dev') === '1');
  const html = renderDashboard(await loadDashboard(env.DB, filter), filter, now);
  return new Response(html, { headers: HTML_HEADERS });
}
