// `cortex init`'s model step: list what the host can run from the ModelCatalog, take the default
// and favorites from the answers or a prompt, and write models.json. Every route without a
// favorite also gains its recommended model, as after a login (domain/models/seed.ts).

import * as clack from '@clack/prompts';
import { t } from '@core/i18n.js';
import { handleCancel } from './init-prompt.js';
import type { Backend } from '@core/types/agent-types.js';
import type { EngineSelection, ModelRef, ModelsFile } from '@domain/agents/engine-selection.js';
import { findModelRefs, modelCatalog, routeFor, type CatalogRoute, type CatalogSnapshot } from '@domain/models/catalog.js';
import {
  mergeRecommendations, readModelsFile, recommendFor, withPicks, writeModelsFile, type ModelPicks,
} from '@domain/models/seed.js';

/**
 * A model the answers name. `route` is `claude` (or a Claude connection id), a PI provider, or a
 * route name older answers used: `plan`/`api` for Claude, `pi-anthropic` for PI's anthropic.
 */
export interface InitModelChoice { route: string; model: string }

const CLAUDE_ROUTES = new Set(['claude', 'plan', 'api', 'subscription']);
const LEGACY_PI_ROUTES: Record<string, string> = { 'pi-anthropic': 'anthropic' };

function trimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function routeOf(input: Record<string, unknown>): string | undefined {
  if (input.backend === 'claude') return 'claude';
  if (input.backend === 'pi') return trimmed(input.provider);
  return trimmed(input.mode);
}

/** `{backend, provider, model}`, or an older `{mode, model}`; undefined when half is missing. */
export function parseChoiceValue(value: unknown): InitModelChoice | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  const route = routeOf(input);
  const model = trimmed(input.model);
  return route && model ? { route, model } : undefined;
}

/** `route:model` from the piped-stdin protocol; undefined for empty or invalid input. */
export function parseChoiceLine(raw: string | undefined): InitModelChoice | undefined {
  const text = raw?.trim();
  const colon = text ? text.indexOf(':') : -1;
  if (!text || colon <= 0 || colon === text.length - 1) return undefined;
  return { route: text.substring(0, colon).trim(), model: text.substring(colon + 1).trim() };
}

/** Comma-separated `route:model` favorites; undefined when none parse. */
export function parseFavoritesLine(raw: string | undefined): InitModelChoice[] | undefined {
  const choices = (raw?.trim() ? raw.split(',') : [])
    .map((part) => parseChoiceLine(part.trim()))
    .filter((choice): choice is InitModelChoice => !!choice);
  return choices.length > 0 ? choices : undefined;
}

// ── Resolving a choice against the catalog ───────────────────────────────────────────────────

function claudeConnection(snapshot: CatalogSnapshot, route: string): string | null | undefined {
  if (CLAUDE_ROUTES.has(route)) return null;
  const connections = routeFor(snapshot, { backend: 'claude', provider: null })?.connections ?? [];
  return connections.includes(route) ? route : undefined;
}

/** The selection a choice names; throws when the host cannot run it. */
export function choiceSelection(snapshot: CatalogSnapshot, choice: InitModelChoice): EngineSelection {
  const refs = findModelRefs(snapshot, choice.model);
  const connection = claudeConnection(snapshot, choice.route);
  const provider = LEGACY_PI_ROUTES[choice.route] ?? choice.route;
  const ref = connection !== undefined
    ? refs.find((entry) => entry.backend === 'claude')
    : refs.find((entry) => entry.backend === 'pi' && entry.provider === provider);
  if (!ref) throw new Error(`(${choice.route}, ${choice.model}) is not among the models this host can run`);
  return { ...ref, thinking: null, connection: connection ?? null };
}

export interface InitModelAnswers {
  defaultChoice?: InitModelChoice;
  favorites?: InitModelChoice[];
}

function answeredPicks(snapshot: CatalogSnapshot, answers: InitModelAnswers | undefined): ModelPicks {
  const selected = answers?.defaultChoice ? choiceSelection(snapshot, answers.defaultChoice) : undefined;
  const favorites = (answers?.favorites ?? []).map((choice) => choiceSelection(snapshot, choice));
  return { default: selected, favorites };
}

// ── Interactive pick ─────────────────────────────────────────────────────────────────────────

function routeLabel(ref: Pick<ModelRef, 'backend' | 'provider'>): string {
  return ref.backend === 'claude' ? 'claude' : ref.provider ?? 'pi';
}

function pickOptions(routes: CatalogRoute[]): Array<{ value: string; label: string }> {
  return routes.flatMap((route) => route.models.map((model) => ({
    value: JSON.stringify([route.backend, route.provider, model]),
    label: `${routeLabel(route)} / ${model}`,
  })));
}

function refOf(value: string): ModelRef {
  const [backend, provider, model] = JSON.parse(value) as [Backend, string | null, string];
  return { backend, provider, model };
}

async function confirmDefaultOverwrite(configDir: string): Promise<boolean> {
  if (!readModelsFile(configDir)?.default) return true;
  const confirm = await clack.confirm({ message: t('init.modelSetup.overwritePrompt'), initialValue: false });
  handleCancel(confirm);
  return confirm;
}

async function promptPicks(routes: CatalogRoute[], recommended: ModelRef[], configDir: string): Promise<ModelPicks> {
  if (!await confirmDefaultOverwrite(configDir)) return {};
  const options = pickOptions(routes);
  const initial = recommended[0] ? JSON.stringify([recommended[0].backend, recommended[0].provider, recommended[0].model]) : options[0].value;
  const selected = await clack.select({ message: t('init.modelSetup.defaultPrompt'), options, initialValue: initial });
  handleCancel(selected);
  const favorites = await clack.multiselect({
    message: t('init.modelSetup.favoritesPrompt'), options, required: false, initialValues: [selected],
  });
  handleCancel(favorites);
  return { default: { ...refOf(selected), thinking: null, connection: null }, favorites: favorites.map(refOf) };
}

// ── The step ─────────────────────────────────────────────────────────────────────────────────

function reportRoutes(routes: CatalogRoute[]): void {
  const summary = routes.map((route) => {
    const shown = route.models.slice(0, 3).join(', ');
    return `  ${routeLabel(route)}: ${shown}${route.models.length > 3 ? ', ...' : ''}`;
  }).join('\n');
  clack.log.success(t('init.modelSetup.discovered', { count: routes.length, summary }));
}

function reportModels(file: ModelsFile, target: string): void {
  clack.log.success(t('init.modelSetup.modelsWritten', { path: target }));
  clack.log.info(t('init.modelSetup.generatedModels', {
    names: file.favorites.map((ref) => ref.model).join(', '), default: file.default.model,
  }));
}

export interface InitModelSetup {
  backends: readonly Backend[];
  configDir: string;
  answers?: InitModelAnswers;
  interactive?: boolean;
}

/** Returns false when no backend can run anything yet, so there was nothing to write. */
export async function runModelSetup(setup: InitModelSetup): Promise<boolean> {
  const snapshot = await modelCatalog.reload();
  const routes = snapshot.routes.filter((route) => setup.backends.includes(route.backend) && route.models.length > 0);
  if (routes.length === 0) {
    clack.log.warn(t('init.modelSetup.noModels'));
    clack.log.info(t('init.modelSetup.rerunHint'));
    return false;
  }
  reportRoutes(routes);
  const recommended = await recommendFor(snapshot, { backends: setup.backends });
  const picks = setup.interactive
    ? await promptPicks(routes, recommended, setup.configDir)
    : answeredPicks(snapshot, setup.answers);
  const file = withPicks(mergeRecommendations(readModelsFile(setup.configDir), recommended).file, picks);
  reportModels(file, writeModelsFile(setup.configDir, file));
  return true;
}
