import { createAccessVerifier, type AccessVerifier } from './access.js';
import { handleDashboard } from './dashboard/handler.js';
import type { Env } from './env.js';
import { jsonResponse, methodNotAllowed, notFound } from './http.js';
import { handleBatch } from './ingest.js';

export interface WorkerDeps {
  verifier: AccessVerifier;
  now?: Date;
}

interface Route {
  method: string;
  handle(request: Request, env: Env, deps: WorkerDeps): Promise<Response>;
}

const ROUTES = new Map<string, Route>([
  ['/v1/batch', { method: 'POST', handle: (request, env, deps) => handleBatch(request, env, deps.now) }],
  ['/dashboard', { method: 'GET', handle: (request, env, deps) => handleDashboard(request, env, deps.verifier, deps.now) }],
  ['/health', { method: 'GET', handle: async () => jsonResponse(200, { status: 'ok' }) }],
]);

const defaultDeps: WorkerDeps = { verifier: createAccessVerifier() };

export async function handleRequest(request: Request, env: Env, deps: WorkerDeps = defaultDeps): Promise<Response> {
  const route = ROUTES.get(new URL(request.url).pathname);
  if (!route) return notFound();
  if (request.method !== route.method) return methodNotAllowed(route.method);
  try {
    return await route.handle(request, env, deps);
  } catch (error) {
    console.error('Telemetry request failed:', error);
    return jsonResponse(500, { error: 'internal error' });
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
