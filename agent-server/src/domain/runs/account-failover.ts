// Account failover: while the login a run would use is rate-limited, the run uses another login of
// the same provider instead — its default login or one of its accounts, billed the same way, able
// to run the model, and not limited itself. Only the run's attempt changes: the session keeps its
// selection, so once the original login recovers the next run is back on it.

import { getSettings } from '@core/settings.js';
import type { EngineSelection } from '../agents/engine-selection.js';
import { configIsRateLimited, resolveRateLimitProvider } from '../agents/provider-run-lifecycle.js';
import { credentialInventory, routeName, type SelectionRef } from '../connections/index.js';
import { modelCatalog, routeFor, servingConnections } from '../models/catalog.js';

export interface FailoverTarget {
  /** The attempt's selection: the session's, on the candidate login. */
  selection: EngineSelection;
  /** Route names of the limited login and the one taken instead. */
  from: string;
  to: string;
}

export interface FailoverDeps {
  enabled?: () => boolean;
  /** The provider's logins that can run the selection's model, the default first. */
  logins?: (selection: EngineSelection) => Array<string | null>;
  billingOf?: (ref: SelectionRef) => string;
  isRateLimited?: (selection: EngineSelection) => boolean;
}

/** Claude: its subscription and accounts serving the model — never a key connection, which may be
 *  another model service altogether. PI: the provider's default login (null), then its accounts. */
function daemonLogins(selection: EngineSelection): Array<string | null> {
  const snapshot = modelCatalog.peek();
  if (selection.backend === 'claude') {
    return servingConnections(snapshot, selection.model)
      .filter((id) => credentialInventory.findClaude(id)?.kind !== 'key');
  }
  const provider = selection.provider ?? '';
  const connections = routeFor(snapshot, { backend: 'pi', provider })?.connections ?? [provider];
  return connections.map((id) => (id === provider ? null : id));
}

function resolved(deps: FailoverDeps): Required<FailoverDeps> {
  return {
    enabled: deps.enabled ?? (() => getSettings().accountFailover),
    logins: deps.logins ?? daemonLogins,
    billingOf: deps.billingOf ?? ((ref) => credentialInventory.billingOf(ref)),
    isRateLimited: deps.isRateLimited ?? configIsRateLimited,
  };
}

function onLogin(selection: EngineSelection, connection: string | null): EngineSelection {
  return { ...selection, connection };
}

/** The first other login that bills like the selection's and is not limited; null when the
 *  selection is not on one of the provider's logins (a key connection) or none is free. */
export function failoverCandidate(selection: EngineSelection, deps: FailoverDeps = {}): FailoverTarget | null {
  const d = resolved(deps);
  if (!d.enabled()) return null;
  const logins = d.logins(selection).map((connection) => onLogin(selection, connection));
  const from = routeName(selection);
  if (!logins.some((login) => routeName(login) === from)) return null;
  const billing = d.billingOf(selection);
  const free = (login: EngineSelection): boolean => routeName(login) !== from
    && d.billingOf(login) === billing && !d.isRateLimited(login);
  const candidate = logins.find(free);
  return candidate ? { selection: candidate, from, to: routeName(candidate) } : null;
}

/** Before a run starts: another login while the selection's own is limited. */
export function preflightFailover(selection: EngineSelection, deps: FailoverDeps = {}): FailoverTarget | null {
  const d = resolved(deps);
  if (!d.enabled() || !d.isRateLimited(selection)) return null;
  return failoverCandidate(selection, d);
}

/** After a run ended on a limit: another login to continue on at once — only when the run was on
 *  the session's own login, so one continuation switches at most once. */
export function resumeFailover(
  selection: EngineSelection,
  hit: { provider?: string | null; route?: string | null },
  deps: FailoverDeps = {},
): FailoverTarget | null {
  if (hit.route !== routeName(selection) || hit.provider !== resolveRateLimitProvider(selection)) return null;
  return failoverCandidate(selection, deps);
}

/** A login's name as the session shows it: the account's label, Claude's subscription by its
 *  name, a PI provider's default login by the provider. */
export function loginLabel(selection: EngineSelection): string {
  if (selection.backend === 'pi' && !selection.connection) return selection.provider ?? 'pi';
  const id = routeName(selection);
  const view = credentialInventory.list().find((candidate) => candidate.backend === selection.backend && candidate.id === id);
  return view?.label ?? id;
}

const announced = new Map<string, string>();

/** Whether a switch is news on this channel: the first run of a switch says so, the runs after it
 *  on the same pair stay quiet, and a run back on its own login ends the switch. */
export function announceFailover(channel: string, target: FailoverTarget | null): boolean {
  if (!target) {
    announced.delete(channel);
    return false;
  }
  const pair = `${target.from}\u0000${target.to}`;
  if (announced.get(channel) === pair) return false;
  announced.set(channel, pair);
  return true;
}

export function _resetFailoverAnnouncements(): void {
  announced.clear();
}
