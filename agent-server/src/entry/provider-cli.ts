// input:  provider subcommand arguments and the two store paths
// output: custom provider listing, saving and removal with CLI framing
// pos:    Custom PI provider CLI handler
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { formatError, formatHelp, readStdinSync } from '@core/cli-utils.js';
import { t } from '@core/i18n.js';
import {
  CUSTOM_PROVIDER_APIS,
  getCustomProvider,
  listCustomProviders,
  removeCustomProvider,
  upsertCustomProvider,
  type CustomProviderApi,
  type CustomProviderFailure,
  type CustomProviderStores,
  type CustomProviderView,
} from '@domain/pi-providers/index.js';

export interface ProviderCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProviderCliOptions {
  /** Reads the key when `--key -` is used. Injected so tests need no real stdin. */
  readSecret?: () => string;
}

const SUBCOMMANDS = ['list', 'add', 'remove'] as const;

function labels() {
  return { validValues: t('provider.cli.validValues'), hint: t('provider.cli.hint') };
}

function fail(message: string, opts: { validValues?: string[]; hint: string }): ProviderCliResult {
  return {
    exitCode: 1,
    stdout: '',
    stderr: formatError(message, { ...opts, labels: labels() }),
  };
}

export function getProviderHelp(): string {
  return formatHelp({
    name: 'cortex auth provider',
    description: t('provider.cli.description'),
    usage: 'cortex auth provider <list|add|remove> [options]',
    commands: [
      { name: 'list', description: t('provider.cli.listDescription') },
      { name: 'add', description: t('provider.cli.addDescription') },
      { name: 'remove', description: t('provider.cli.removeDescription') },
    ],
    options: [
      { flag: '--name <name>', description: t('provider.cli.nameDescription') },
      { flag: '--api <api>', description: `${t('provider.cli.apiDescription')} (${CUSTOM_PROVIDER_APIS.join(' | ')})` },
      { flag: '--url <url>', description: t('provider.cli.urlDescription') },
      { flag: '--key <key|->', description: t('provider.cli.keyDescription') },
      { flag: '--model <id>', description: t('provider.cli.modelDescription') },
      { flag: '--dry-run', description: t('provider.cli.dryRunDescription') },
      { flag: '--json', description: t('provider.cli.jsonDescription') },
      { flag: '--help, -h', description: t('provider.cli.helpDescription') },
    ],
    examples: [
      {
        description: t('provider.cli.exampleAdd'),
        command: 'cortex auth provider add --name my-vllm --api anthropic-messages --url http://127.0.0.1:8100 --model Model-27B',
      },
      {
        description: t('provider.cli.exampleAddPiped'),
        command: 'pass show my-endpoint | cortex auth provider add --name my-proxy --api openai-completions --url https://proxy.example.com/v1 --model small --key -',
      },
      { description: t('provider.cli.exampleList'), command: 'cortex auth provider list --json' },
      { description: t('provider.cli.exampleRemove'), command: 'cortex auth provider remove --name my-vllm --dry-run' },
    ],
    labels: {
      usage: t('cmd.auth.cli.helpUsage'),
      commands: t('cmd.auth.cli.helpCommands'),
      options: t('cmd.auth.cli.helpOptions'),
      examples: t('cmd.auth.cli.helpExamples'),
    },
  });
}

interface ParsedFlags {
  values: Map<string, string>;
  models: string[];
  json: boolean;
  dryRun: boolean;
}

const VALUE_FLAGS = new Set(['--name', '--api', '--url', '--key']);

function parseFlags(args: string[]): ParsedFlags | ProviderCliResult {
  const values = new Map<string, string>();
  const models: string[] = [];
  let json = false;
  let dryRun = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') { json = true; continue; }
    if (arg === '--dry-run') { dryRun = true; continue; }
    if (arg === '--model' || VALUE_FLAGS.has(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return fail(t('provider.cli.flagNeedsValue', { flag: arg }), { hint: 'cortex auth provider --help' });
      }
      i += 1;
      if (arg === '--model') models.push(value);
      else values.set(arg, value);
      continue;
    }
    return fail(t('provider.cli.unknownFlag', { flag: arg }), {
      validValues: ['--name', '--api', '--url', '--key', '--model', '--dry-run', '--json'],
      hint: 'cortex auth provider --help',
    });
  }

  return { values, models, json, dryRun };
}

function issueText(issue: CustomProviderFailure): string {
  return t(`provider.issue.${issue}` as Parameters<typeof t>[0]);
}

function renderProvider(provider: CustomProviderView): string {
  return provider.routed
    ? t('provider.cli.listItem', { name: provider.name, api: provider.api, upstream: provider.upstreamUrl ?? '' })
    : t('provider.cli.listItemUnrouted', { name: provider.name, api: provider.api });
}

function runList(flags: ParsedFlags, stores: CustomProviderStores): ProviderCliResult {
  const providers = listCustomProviders(stores);
  if (flags.json) {
    return { exitCode: 0, stdout: JSON.stringify({ ok: true, providers }, null, 2), stderr: '' };
  }
  const stdout = providers.length === 0
    ? t('provider.cli.listEmpty')
    : providers.map(renderProvider).join('\n');
  return { exitCode: 0, stdout, stderr: '' };
}

function resolveKey(flags: ParsedFlags, options: ProviderCliOptions): string | undefined {
  const raw = flags.values.get('--key');
  if (raw === undefined) return undefined;
  if (raw !== '-') return raw;
  const read = options.readSecret ?? readStdinSync;
  return read().trim();
}

function runAdd(
  flags: ParsedFlags,
  stores: CustomProviderStores,
  options: ProviderCliOptions,
): ProviderCliResult {
  for (const flag of ['--name', '--api', '--url']) {
    if (!flags.values.has(flag)) {
      return fail(t('provider.cli.missingFlag', { flag }), { hint: 'cortex auth provider add --help' });
    }
  }
  const api = flags.values.get('--api') as CustomProviderApi;
  if (!CUSTOM_PROVIDER_APIS.includes(api)) {
    return fail(issueText('api-invalid'), {
      validValues: [...CUSTOM_PROVIDER_APIS],
      hint: 'cortex auth provider add --help',
    });
  }

  const result = upsertCustomProvider(stores, {
    name: flags.values.get('--name')!,
    api,
    upstreamUrl: flags.values.get('--url')!,
    apiKey: resolveKey(flags, options),
    models: flags.models.map((id) => ({ id })),
  });

  // `=== false` rather than `!result.ok`: this project typechecks with `strict: false`, where
  // truthiness alone does not narrow a boolean-literal discriminant.
  if (result.ok === false) {
    return fail(result.errors.map(issueText).join('\n'), { hint: 'cortex auth provider add --help' });
  }
  const stdout = flags.json
    ? JSON.stringify({ ok: true, provider: result.provider }, null, 2)
    : t('provider.cli.added', {
      name: result.provider.name,
      upstream: result.provider.upstreamUrl ?? '',
    });
  return { exitCode: 0, stdout, stderr: '' };
}

function runRemove(flags: ParsedFlags, stores: CustomProviderStores): ProviderCliResult {
  const name = flags.values.get('--name');
  if (!name) {
    return fail(t('provider.cli.missingFlag', { flag: '--name' }), { hint: 'cortex auth provider remove --help' });
  }
  const existing = getCustomProvider(stores, name);
  if (!existing) {
    return fail(t('provider.cli.notFound', { name }), { hint: 'cortex auth provider list' });
  }
  if (flags.dryRun) {
    const payload = { dry_run: true, would_remove: existing };
    return { exitCode: 0, stdout: JSON.stringify(payload, null, 2), stderr: '' };
  }

  const result = removeCustomProvider(stores, name);
  if (result.ok === false) {
    return fail(result.errors.map(issueText).join('\n'), { hint: 'cortex auth provider list' });
  }
  const stdout = flags.json
    ? JSON.stringify({ ok: true, name }, null, 2)
    : t('provider.cli.removed', { name });
  return { exitCode: 0, stdout, stderr: '' };
}

/**
 * `cortex auth provider <list|add|remove>`. `add` is an upsert, so retrying it is safe; `remove`
 * takes `--dry-run` because it deletes a gateway route the running gateway is serving.
 */
export function runProviderCli(
  args: string[],
  stores: CustomProviderStores,
  options: ProviderCliOptions = {},
): ProviderCliResult {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return { exitCode: 0, stdout: getProviderHelp(), stderr: '' };
  }
  const subcommand = args[0];
  if (!SUBCOMMANDS.includes(subcommand as typeof SUBCOMMANDS[number])) {
    return fail(t('provider.cli.unknownSubcommand', { command: subcommand }), {
      validValues: [...SUBCOMMANDS],
      hint: 'cortex auth provider --help',
    });
  }

  const rest = args.slice(1);
  if (rest.includes('--help') || rest.includes('-h')) {
    return { exitCode: 0, stdout: getProviderHelp(), stderr: '' };
  }
  const flags = parseFlags(rest);
  if (!('values' in flags)) return flags;

  if (subcommand === 'list') return runList(flags, stores);
  if (subcommand === 'add') return runAdd(flags, stores, options);
  return runRemove(flags, stores);
}
