// resolveSelection: the one place a model selection is completed and checked. Every caller —
// runs, the pickers, `!model`/`!thinking`/`!connection`, schedules, subagents, team workers —
// hands it what it knows and takes the answer as is; none keeps a fallback chain of its own.
//
// Layers, highest first: what the request says, a selection the caller carries (a schedule's, a
// delegating parent's), the session's, the channel's draft (only before a session exists), the
// configured default. The backend is always one of those layers' own field — never inferred from a
// connection or route name. A selection stores the connection the user chose, or null; the
// connection a run uses is computed every time from what still exists. A PI connection is one of
// the provider's accounts.

import { createLogger } from '@core/log.js';
import type { Backend } from '@core/types/agent-types.js';
import { credentialInventory, type CredentialInventory } from '../connections/inventory.js';
import { modelCatalog, servingConnections, thinkingLevelsFor, type CatalogSnapshot } from '../models/catalog.js';
import type { ModelMemory } from './agent-state.js';
import { modelKey, type EngineSelection, type ModelRef } from './engine-selection.js';

const log = createLogger('selection');

export type SelectionFailure = 'invalid-thinking' | 'provider-not-supported' | 'invalid-connection'
  | 'invalid-model' | 'no-model-for-backend';

/** Where a backend starts when a request switches to it, and the configured default. */
export interface SelectionDefaults {
  /** The configured default selection; null when none is configured. */
  selection(): EngineSelection | null;
  /** A backend's starting point: the default when it is on that backend, else its first favorite. */
  forBackend(backend: Backend): ModelRef | null;
}

export interface SelectionContext {
  /** A complete selection the caller carries for this run (a schedule's, a parent's). */
  request?: EngineSelection | null;
  /** The bound session's selection. Whenever a session exists it wins over the draft. */
  session?: EngineSelection | null;
  /** The channel's draft entry, for a conversation that has no session yet. */
  draft?: EngineSelection | null;
  defaults: SelectionDefaults;
  memory: () => ModelMemory;
  inventory?: CredentialInventory;
  /** A catalog snapshot; peeked from the daemon's catalog when omitted, and only when needed. */
  catalog?: () => CatalogSnapshot;
}

export type SelectionResolution =
  | {
    ok: true;
    /** What to store: the user's connection choice, or null. */
    selection: EngineSelection;
    /** What a run uses: the same, with the connection computed. */
    effective: EngineSelection;
    base: EngineSelection | null;
  }
  | { ok: false; reason: SelectionFailure; allowed?: readonly string[]; base: EngineSelection | null };

type Failure = Extract<SelectionResolution, { ok: false }>;
type Step<T> = { ok: true; value: T } | { ok: false; reason: SelectionFailure; allowed?: readonly string[] };

interface Resolver {
  inventory: CredentialInventory;
  catalog: () => CatalogSnapshot;
  memory: () => ModelMemory;
  defaults: SelectionDefaults;
}

function resolverOf(context: SelectionContext): Resolver {
  let snapshot: CatalogSnapshot | null = null;
  const catalog = context.catalog ?? (() => modelCatalog.peek());
  return {
    inventory: context.inventory ?? credentialInventory,
    catalog: () => (snapshot ??= catalog()),
    memory: context.memory,
    defaults: context.defaults,
  };
}

function baseOf(context: SelectionContext): EngineSelection | null {
  return context.request ?? context.session ?? context.draft ?? context.defaults.selection();
}

/** A backend pick without a model selects that backend's own starting point. */
function startOf(partial: Partial<EngineSelection>, base: EngineSelection | null, r: Resolver): EngineSelection | null {
  const backendPick = partial.backend !== undefined && partial.model === undefined && partial.provider === undefined;
  if (!backendPick && (partial.backend === undefined || partial.backend === base?.backend)) return base;
  const configured = r.defaults.selection();
  if (configured?.backend === partial.backend) return configured;
  const ref = r.defaults.forBackend(partial.backend!);
  return ref ? { ...ref, thinking: r.memory()[modelKey(ref)]?.thinking ?? null, connection: null } : null;
}

const SAFE_NAME = /^[a-zA-Z0-9_-]+$/;

function targetRef(partial: Partial<EngineSelection>, start: EngineSelection | null): Step<ModelRef> {
  const backend = partial.backend ?? start?.backend;
  const model = partial.model ?? start?.model;
  if (!backend || model === undefined) return { ok: false, reason: 'no-model-for-backend' };
  const provider = partial.provider !== undefined ? partial.provider : (backend === 'claude' ? null : start?.provider ?? null);
  if (typeof model !== 'string' || !model.trim()) return { ok: false, reason: 'invalid-model' };
  const validProvider = backend === 'claude' ? provider === null
    : backend === 'pi' && typeof provider === 'string' && SAFE_NAME.test(provider);
  return validProvider ? { ok: true, value: { backend, provider, model } } : { ok: false, reason: 'provider-not-supported' };
}

function sameModel(start: EngineSelection | null, ref: ModelRef): boolean {
  return !!start && modelKey(start) === modelKey(ref);
}

/** The level a pick starts from: the start's own while the pick stays on its model (a backend-only
 *  pick takes its starting point whole), else the level last picked for the named model. */
function inheritedThinking(
  partial: Partial<EngineSelection>, start: EngineSelection | null, carried: boolean, ref: ModelRef, r: Resolver,
): string | null {
  const keepsStart = sameModel(start, ref) && (carried || partial.model === undefined);
  return keepsStart ? start!.thinking : r.memory()[modelKey(ref)]?.thinking ?? null;
}

/** An explicit level must be one the model accepts; an inherited one that no longer is drops to the
 *  model's default rather than failing a pick that did not touch it. */
function resolveThinking(
  partial: Partial<EngineSelection>, start: EngineSelection | null, carried: boolean, ref: ModelRef, r: Resolver,
): Step<string | null> {
  const inherited = inheritedThinking(partial, start, carried, ref, r);
  const same = sameModel(start, ref);
  const explicit = partial.thinking !== undefined && !(same && partial.thinking === inherited);
  const level = explicit ? partial.thinking! : inherited;
  if (level === null) return { ok: true, value: null };
  const allowed = thinkingLevelsFor(r.catalog(), ref);
  if (allowed.includes(level)) return { ok: true, value: level };
  return explicit ? { ok: false, reason: 'invalid-thinking', allowed } : { ok: true, value: null };
}

function claudeIds(r: Resolver): string[] {
  return r.inventory.claudeConnections().map((view) => view.id);
}

/** The connection a pick carries over: the start's, while the pick stays on its backend and — for
 *  PI, whose accounts each belong to one provider — on its provider. */
function inheritedConnection(start: EngineSelection | null, ref: ModelRef): string | null {
  if (!start || start.backend !== ref.backend) return null;
  if (ref.backend === 'pi' && start.provider !== ref.provider) return null;
  return start.connection ?? null;
}

/**
 * A connection the request names (and that differs from the one it already had) must exist. One
 * carried over is kept while it exists and serves the model; otherwise the choice is dropped and
 * the run computes its connection — never an error for a choice the request did not make.
 */
function resolveConnection(
  partial: Partial<EngineSelection>, start: EngineSelection | null, ref: ModelRef, r: Resolver,
): Step<string | null> {
  const inherited = inheritedConnection(start, ref);
  const named = partial.connection !== undefined && partial.connection !== inherited;
  if (named) return explicitConnection(partial.connection!, ref, r);
  if (ref.backend === 'pi') return { ok: true, value: carriedPiConnection(inherited, ref.provider!, r) };
  return { ok: true, value: carriedConnection(inherited, sameModel(start, ref), ref.model, r) };
}

function piAccountIds(provider: string, r: Resolver): string[] {
  return r.inventory.piAccounts(provider).map((view) => view.id);
}

/** What a selection may name: one of Claude's connections; for PI, one of the provider's signed-in
 *  accounts, or the provider itself for its default login (stored as null). */
function explicitConnection(connection: string | null, ref: ModelRef, r: Resolver): Step<string | null> {
  if (connection === null) return { ok: true, value: null };
  const ids = ref.backend === 'pi' ? [ref.provider!, ...piAccountIds(ref.provider!, r)] : claudeIds(r);
  if (!ids.includes(connection)) return { ok: false, reason: 'invalid-connection', allowed: ids };
  return { ok: true, value: connection === ref.provider ? null : connection };
}

function carriedConnection(connection: string | null, same: boolean, model: string, r: Resolver): string | null {
  if (connection === null) return null;
  if (!r.inventory.findClaude(connection)) {
    log.warn(`Connection '${connection}' no longer exists; the selection falls back to the default connection`);
    return null;
  }
  return same || servingConnections(r.catalog(), model).includes(connection) ? connection : null;
}

/** A PI account stays chosen while it is signed in; otherwise the provider's default login runs. */
function carriedPiConnection(connection: string | null, provider: string, r: Resolver): string | null {
  if (connection === null || piAccountIds(provider, r).includes(connection)) return connection;
  log.warn(`Account '${connection}' is not signed in to ${provider}; the selection falls back to its default login`);
  return null;
}

/**
 * The connection a Claude run uses: the chosen one while it exists; otherwise the default
 * connection when it serves the model, else the first connection that does. Null only when the host
 * has no Claude connection at all (the run then reports the missing login itself). A PI run uses
 * its account while signed in, else the provider's default login (null).
 */
function computeConnection(selection: EngineSelection, r: Resolver): string | null {
  if (selection.backend === 'pi') return carriedPiConnection(selection.connection, selection.provider ?? '', r);
  if (selection.connection && r.inventory.findClaude(selection.connection)) return selection.connection;
  if (selection.connection) log.warn(`Connection '${selection.connection}' no longer exists; using the default connection`);
  const fallback = r.inventory.defaultClaudeConnection();
  const serving = servingConnections(r.catalog(), selection.model);
  return fallback !== null && serving.includes(fallback) ? fallback : serving[0] ?? fallback;
}

function failure(step: Step<unknown>, base: EngineSelection | null): Failure {
  const failed = step as Extract<Step<unknown>, { ok: false }>;
  return { ok: false, reason: failed.reason, ...(failed.allowed ? { allowed: failed.allowed } : {}), base };
}

export function resolveSelection(context: SelectionContext, partial: Partial<EngineSelection> = {}): SelectionResolution {
  const r = resolverOf(context);
  const base = baseOf(context);
  const start = startOf(partial, base, r);
  const ref = targetRef(partial, start);
  if (!ref.ok) return failure(ref, base);
  const thinking = resolveThinking(partial, start, start === base, ref.value, r);
  if (!thinking.ok) return failure(thinking, base);
  const connection = resolveConnection(partial, start, ref.value, r);
  if (!connection.ok) return failure(connection, base);
  const selection: EngineSelection = { ...ref.value, thinking: thinking.value, connection: connection.value };
  return { ok: true, selection, effective: { ...selection, connection: computeConnection(selection, r) }, base };
}

/** The connection a Claude selection runs on now (see computeConnection); null only when the host
 *  has no Claude connection at all. Without a model, the default connection. */
export function claudeRunConnection(
  selection: Pick<EngineSelection, 'connection'> & { model?: string },
  context: Pick<SelectionContext, 'inventory' | 'catalog'> = {},
): string | null {
  const r = resolverOf({ ...context, defaults: NO_DEFAULTS, memory: () => ({}) });
  const claude: EngineSelection = {
    backend: 'claude', provider: null, model: selection.model ?? '', thinking: null, connection: selection.connection,
  };
  return computeConnection(claude, r);
}

/** The connection a stored selection runs on now, by the same rule a resolution computes it. */
export function effectiveSelection(selection: EngineSelection, context: Pick<SelectionContext, 'inventory' | 'catalog'> = {}): EngineSelection {
  const r = resolverOf({ ...context, defaults: NO_DEFAULTS, memory: () => ({}) });
  return { ...selection, connection: computeConnection(selection, r) };
}

const NO_DEFAULTS: SelectionDefaults = { selection: () => null, forBackend: () => null };
