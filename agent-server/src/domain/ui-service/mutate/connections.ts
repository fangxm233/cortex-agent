import { t } from '@core/i18n.js';
import { piProviderDiscovery } from '../../../agent-adapter/pi/discovery.js';
import {
  removeConnectionBy, upsertConnectionFrom, type ConnectionEditorDeps, type ConnectionIssue,
} from '@domain/connections/editor.js';
import type {
  ConnectionsRemoveReturn, ConnectionsUpsertReturn, MutateArgs, Result, UiServiceDeps,
} from '../types.js';

/** The host's connections file; a PI change rescans PI so its models show without waiting. */
function editorOf(deps: UiServiceDeps): ConnectionEditorDeps {
  return deps.connectionEditor ?? { onChanged: (backend) => { if (backend === 'pi') piProviderDiscovery.refresh(); } };
}

/** One message table serves every surface, so the Web text matches what the CLI prints. */
function issueText(issue: ConnectionIssue): string {
  return t(`provider.issue.${issue}` as Parameters<typeof t>[0]);
}

/** A missing connection is a client error, a failed write is ours, anything else a draft to fix. */
function failure(errors: ConnectionIssue[]): Result<never> {
  const code = errors.includes('not-found') ? 'not-found' : errors.includes('write-failed') ? 'internal' : 'invalid-args';
  return { ok: false, code, message: errors.map(issueText).join(' ') };
}

export async function handleConnectionsUpsert(
  deps: UiServiceDeps,
  args: MutateArgs<'connections.upsert'>,
): Promise<Result<ConnectionsUpsertReturn>> {
  const result = upsertConnectionFrom(args, editorOf(deps));
  return result.ok === true ? { ok: true, data: { connection: result.connection } } : failure(result.errors);
}

export async function handleConnectionsRemove(
  deps: UiServiceDeps,
  args: MutateArgs<'connections.remove'>,
): Promise<Result<ConnectionsRemoveReturn>> {
  const result = await removeConnectionBy(args, editorOf(deps));
  return result.ok === true ? { ok: true, data: { removed: true } } : failure(result.errors);
}
