// input:  `!login custom` arguments and the custom provider stores
// output: chat listing, creation and deletion of user-defined PI providers
// pos:    Chat surface for custom PI provider management
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { t } from '@core/i18n.js';
import {
  CUSTOM_PROVIDER_APIS,
  defaultCustomProviderStores,
  getCustomProvider,
  listCustomProviders,
  removeCustomProvider,
  upsertCustomProvider,
  type CustomProviderApi,
  type CustomProviderFailure,
  type CustomProviderStores,
  type CustomProviderView,
} from '@domain/pi-providers/index.js';
import type { CommandResult } from './command-context.js';

export type CustomProviderRequest =
  | { kind: 'list' }
  | { kind: 'add'; name: string; api: string; upstreamUrl: string; models: string[] }
  | { kind: 'remove'; name: string }
  | { kind: 'usage' };

/**
 * `!login custom [list | add <name> <api> <url> <model...> | remove <name>]`.
 *
 * There is deliberately no key argument: a chat message is a durable, widely readable transcript,
 * and an upstream secret does not belong in one. A provider added here routes through the gateway
 * with the caller's own key passed through; to attach a stored key use the CLI (`--key -` reads it
 * from stdin) or the Web settings page, both of which keep the secret off any transcript.
 */
export function parseCustomProviderRequest(args: string[]): CustomProviderRequest {
  if (args.length === 0 || (args.length === 1 && args[0] === 'list')) return { kind: 'list' };
  if (args[0] === 'remove') {
    return args.length === 2 ? { kind: 'remove', name: args[1] } : { kind: 'usage' };
  }
  if (args[0] === 'add') {
    const [, name, api, upstreamUrl, ...models] = args;
    if (!name || !api || !upstreamUrl || models.length === 0) return { kind: 'usage' };
    return { kind: 'add', name, api, upstreamUrl, models };
  }
  return { kind: 'usage' };
}

function issueText(issue: CustomProviderFailure): string {
  return t(`provider.issue.${issue}` as Parameters<typeof t>[0]);
}

function renderProvider(provider: CustomProviderView): string {
  return provider.routed
    ? t('provider.cli.listItem', {
      name: provider.name,
      api: provider.api,
      upstream: provider.upstreamUrl ?? '',
    })
    : t('provider.cli.listItemUnrouted', { name: provider.name, api: provider.api });
}

function usage(): CommandResult {
  return { text: `${t('provider.chat.usage')}\n${t('provider.chat.keyNotice')}` };
}

function runList(stores: CustomProviderStores): CommandResult {
  const providers = listCustomProviders(stores);
  if (providers.length === 0) return { text: t('provider.cli.listEmpty') };
  return { text: providers.map(renderProvider).join('\n') };
}

function runAdd(
  request: Extract<CustomProviderRequest, { kind: 'add' }>,
  stores: CustomProviderStores,
): CommandResult {
  if (!CUSTOM_PROVIDER_APIS.includes(request.api as CustomProviderApi)) {
    return { text: `${issueText('api-invalid')} ${CUSTOM_PROVIDER_APIS.join(' | ')}` };
  }
  const result = upsertCustomProvider(stores, {
    name: request.name,
    api: request.api as CustomProviderApi,
    upstreamUrl: request.upstreamUrl,
    models: request.models.map((id) => ({ id })),
  });
  if (result.ok === false) return { text: result.errors.map(issueText).join('\n') };
  return {
    text: [
      t('provider.cli.added', {
        name: result.provider.name,
        upstream: result.provider.upstreamUrl ?? '',
      }),
      t('provider.chat.keyNotice'),
    ].join('\n'),
  };
}

function runRemove(name: string, stores: CustomProviderStores): CommandResult {
  if (!getCustomProvider(stores, name)) return { text: t('provider.cli.notFound', { name }) };
  const result = removeCustomProvider(stores, name);
  if (result.ok === false) return { text: result.errors.map(issueText).join('\n') };
  return { text: t('provider.cli.removed', { name }) };
}

export async function handleCustomProviderCommand(
  args: string[],
  stores: CustomProviderStores = defaultCustomProviderStores(),
): Promise<CommandResult> {
  const request = parseCustomProviderRequest(args);
  if (request.kind === 'list') return runList(stores);
  if (request.kind === 'add') return runAdd(request, stores);
  if (request.kind === 'remove') return runRemove(request.name, stores);
  return usage();
}
