import type { ConfigSnapshot, EngineSelection, ModelCatalogSnapshot, ModelRef, ScheduleInfo, MutateArgs } from '@cortex-agent/ui-contract';
import { modelKey, modelLabel, selectionForModel } from '@/lib/model-selection';
import { formatSpan, formatSpanPrecise, type TimeLang } from '@/i18n/time-format';
import type { Vocab } from '@/i18n';

export type SchedType = 'interval' | 'daily' | 'weekly' | 'once';
export type IntervalUnit = 'min' | 'hr';

export const SCHED_TYPES: SchedType[] = ['interval', 'daily', 'weekly', 'once'];
export const INTERVAL_UNITS: IntervalUnit[] = ['min', 'hr'];

export const DAY_OPTIONS: number[] = [0, 1, 2, 3, 4, 5, 6];

// Display words for the unit options; the option VALUES stay the scheduler's own spellings.
const OPTION_LABEL_KEY = {
  min: 'schedUnitMin',
  hr: 'schedUnitHr',
} as const satisfies Record<IntervalUnit, keyof Vocab>;

export function scheduleOptionLabel(option: IntervalUnit, L: Vocab): string {
  return L[OPTION_LABEL_KEY[option]];
}

export interface ScheduleModelOption {
  value: string;
  label: string;
  selection: EngineSelection;
  favorite: boolean;
}

/** Favorites render without the catalog; deduplicate by backend/provider/model, not model name. */
export function scheduleModelOptions(
  config: Pick<ConfigSnapshot, 'models'> | undefined,
  catalog: ModelCatalogSnapshot | undefined,
  current: EngineSelection | null,
): ScheduleModelOption[] {
  const favorites = config?.models?.favorites ?? [];
  const refs: ModelRef[] = [...favorites, ...(catalog?.routes ?? []).flatMap((route) =>
    route.models.map((model) => ({ backend: route.backend,
      provider: route.provider, model })))];
  if (current) refs.push(current);
  const unique = new Map(refs.map((ref) => [modelKey(ref), ref]));
  return [...unique].map(([value, ref]) => ({
    value, label: `${modelLabel(ref)} · ${ref.provider ?? ref.backend}`,
    selection: current && modelKey(current) === value ? current : selectionForModel(ref, config, catalog),
    favorite: favorites.some((favorite) => modelKey(favorite) === value),
  }));
}

export function scheduleThinkingOptions(
  catalog: ModelCatalogSnapshot | undefined, selection: EngineSelection | null,
): string[] {
  if (!selection) return [''];
  const route = catalog?.routes.find((entry) =>
    entry.backend === selection.backend && entry.provider === selection.provider);
  const levels = route?.modelThinking?.[selection.model] ?? catalog?.thinkingLevels?.[selection.backend] ?? [];
  return [...new Set(['', ...levels, selection.thinking ?? ''])];
}

export function scheduleModelPatch(options: ScheduleModelOption[], value: string): Partial<ScheduleForm> {
  const option = options.find((candidate) => candidate.value === value);
  return option?.selection.mode ? { selection: option.selection } : {};
}

export function scheduleThinkingPatch(form: ScheduleForm, value: string): Partial<ScheduleForm> {
  return form.selection ? { selection: { ...form.selection, thinking: value || null } } : {};
}

export interface ScheduleForm {
  type: SchedType;
  message: string;
  selection: EngineSelection | null;
  time: string; // HH:MM (daily / weekly)
  dayOfWeek: number; // 0..6 (weekly)
  intervalValue: number; // interval
  intervalUnit: IntervalUnit;
  delayValue: number; // once
  delayUnit: IntervalUnit;
  projectId: string | null;
}

export function defaultScheduleForm(projectId: string | null): ScheduleForm {
  return {
    type: 'daily',
    message: '',
    selection: null,
    time: '09:00',
    dayOfWeek: 1,
    intervalValue: 30,
    intervalUnit: 'min',
    delayValue: 10,
    delayUnit: 'min',
    projectId,
  };
}

export interface FieldVisibility {
  time: boolean;
  interval: boolean;
  dayOfWeek: boolean;
  delay: boolean;
}

export type ScheduleEditorMode = 'create' | 'edit';

/** Every form field is gated from the actual add/update contracts, not merely disabled in views. */
export interface ScheduleEditableFields extends FieldVisibility {
  type: boolean;
  message: boolean;
  selection: boolean;
  projectId: boolean;
}

export function visibleFields(type: SchedType): FieldVisibility {
  return {
    time: type === 'daily' || type === 'weekly',
    interval: type === 'interval',
    dayOfWeek: type === 'weekly',
    delay: type === 'once',
  };
}

export function editableScheduleFields(
  mode: ScheduleEditorMode,
  type: SchedType,
): ScheduleEditableFields {
  const timing = visibleFields(type);
  const editing = mode === 'edit';
  return {
    ...timing,
    // A once DTO has no original delay/runAt and schedules.update accepts no once timing field.
    delay: timing.delay && !editing,
    type: !editing,
    message: true,
    selection: true,
    projectId: true,
  };
}

const FIELD_GATES: Partial<Record<keyof ScheduleForm, keyof ScheduleEditableFields>> = {
  intervalValue: 'interval',
  intervalUnit: 'interval',
  delayValue: 'delay',
  delayUnit: 'delay',
};

function patchFieldEditable(
  fields: ScheduleEditableFields,
  key: keyof ScheduleForm,
): boolean {
  const gate = FIELD_GATES[key] ?? key;
  return fields[gate as keyof ScheduleEditableFields] ?? false;
}

/** Apply only fields accepted by the current API mode, protecting headless consumers too. */
export function applyEditableSchedulePatch(
  form: ScheduleForm,
  mode: ScheduleEditorMode,
  patch: Partial<ScheduleForm>,
): ScheduleForm {
  const fields = editableScheduleFields(mode, form.type);
  const accepted: Partial<ScheduleForm> = {};
  for (const key of Object.keys(patch) as (keyof ScheduleForm)[]) {
    if (patchFieldEditable(fields, key)) Object.assign(accepted, { [key]: patch[key] });
  }
  return { ...form, ...accepted };
}

export function unitToMs(value: number, unit: IntervalUnit): number {
  return unit === 'hr' ? value * 3_600_000 : value * 60_000;
}

const TIME_RE = /^\d{2}:\d{2}$/;

export function buildScheduleAddArgs(form: ScheduleForm): MutateArgs<'schedules.add'> {
  const args: MutateArgs<'schedules.add'> = {
    type: form.type,
    message: form.message.trim(),
  };
  if (form.projectId) args.projectId = form.projectId;
  if (form.selection) args.selection = form.selection;

  if (form.type === 'interval') args.intervalMs = unitToMs(form.intervalValue, form.intervalUnit);
  if (form.type === 'daily' || form.type === 'weekly') args.time = form.time;
  if (form.type === 'weekly') args.dayOfWeek = form.dayOfWeek;
  if (form.type === 'once') args.delay = unitToMs(form.delayValue, form.delayUnit);
  return args;
}

// ── Edit mode (design 27b「Edit schedule ↗」) ────────────────────────────────
// The schedule's type is immutable and `schedules.update` patches only message/projectId/selection +
// the type's own timing fields — a once-schedule's runAt is not patchable.

/** Prefill the form from a persisted schedule. Missing fields fall back to the create defaults so
 *  every control stays controlled; a missing selection stays null. */
export function formFromSchedule(s: ScheduleInfo): ScheduleForm {
  const base = defaultScheduleForm(s.projectId || null);
  const ms = s.intervalMs ?? 0;
  const wholeHours = ms > 0 && ms % 3_600_000 === 0;
  return {
    ...base,
    type: s.type,
    message: s.message,
    selection: s.selection,
    time: s.time ?? base.time,
    dayOfWeek: s.dayOfWeek ?? base.dayOfWeek,
    intervalValue: ms > 0 ? (wholeHours ? ms / 3_600_000 : Math.round(ms / 60_000)) : base.intervalValue,
    intervalUnit: wholeHours ? 'hr' : 'min',
  };
}

/** The real `schedules.update` payload: only patchable fields, timing scoped to the form's type. */
export function buildScheduleUpdateArgs(scheduleId: string, form: ScheduleForm): MutateArgs<'schedules.update'> {
  const args: MutateArgs<'schedules.update'> = { scheduleId, message: form.message.trim() };
  if (form.selection) args.selection = form.selection;
  if (form.projectId) args.projectId = form.projectId;
  if (form.type === 'interval') args.intervalMs = unitToMs(form.intervalValue, form.intervalUnit);
  if (form.type === 'daily' || form.type === 'weekly') args.time = form.time;
  if (form.type === 'weekly') args.dayOfWeek = form.dayOfWeek;
  return args;
}

export interface Validation {
  ok: boolean;
  errors: string[];
}

function messageError(form: ScheduleForm): string | null {
  return form.message.trim() ? null : 'message is required';
}

function intervalError(form: ScheduleForm): string | null {
  return form.type === 'interval' && !(form.intervalValue > 0) ? 'interval must be > 0' : null;
}

function timeError(form: ScheduleForm): string | null {
  const timed = form.type === 'daily' || form.type === 'weekly';
  return timed && !TIME_RE.test(form.time) ? 'time must be HH:MM' : null;
}

function weekdayError(form: ScheduleForm): string | null {
  const invalid = !(form.dayOfWeek >= 0 && form.dayOfWeek <= 6);
  return form.type === 'weekly' && invalid ? 'dayOfWeek must be 0..6' : null;
}

function delayError(form: ScheduleForm, mode: ScheduleEditorMode): string | null {
  const invalid = form.type === 'once' && mode === 'create' && !(form.delayValue > 0);
  return invalid ? 'delay must be > 0' : null;
}

export function validateScheduleForm(
  form: ScheduleForm,
  mode: ScheduleEditorMode = 'create',
): Validation {
  const candidates = [messageError(form), intervalError(form), timeError(form),
    weekdayError(form), delayError(form, mode)];
  const errors = candidates.filter((error): error is string => error !== null);
  return { ok: errors.length === 0, errors };
}

export function computeNextRun(form: ScheduleForm, now: Date): Date {
  if (form.type === 'interval') return new Date(now.getTime() + unitToMs(form.intervalValue, form.intervalUnit));
  if (form.type === 'once') return new Date(now.getTime() + unitToMs(form.delayValue, form.delayUnit));

  // daily / weekly: next occurrence of HH:MM (weekly also advances to the target weekday)
  const [h, m] = form.time.split(':').map((n) => parseInt(n, 10));
  const next = new Date(now);
  next.setHours(h, m, 0, 0);
  if (form.type === 'daily') {
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return next;
  }
  // weekly
  let deltaDays = (form.dayOfWeek - now.getDay() + 7) % 7;
  if (deltaDays === 0 && next.getTime() <= now.getTime()) deltaDays = 7;
  next.setDate(next.getDate() + deltaDays);
  return next;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Schedule delta rounded to the minute: `30m / 3h 5m / 2d` · `30分钟 / 3小时5分 / 2天`. */
export function humanizeDelta(ms: number, lang: TimeLang): string {
  const span = Math.max(0, Math.round(ms / 60_000)) * 60_000;
  return span < 86_400_000 ? formatSpanPrecise(span, lang) : formatSpan(span, lang);
}

export function nextRunParts(form: ScheduleForm, now: Date, lang: TimeLang): { clock: string; delta: string } {
  const next = computeNextRun(form, now);
  return {
    clock: `${pad2(next.getHours())}:${pad2(next.getMinutes())}`,
    delta: humanizeDelta(next.getTime() - now.getTime(), lang),
  };
}
