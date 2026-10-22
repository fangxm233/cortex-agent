import type { CSSProperties } from 'react';
import { useVocab } from '@/i18n';
import { modelKey } from '@/lib/model-selection';
import { MBackChevron, MC, MSelect } from '@/mobile/ui/kit';
import {
  DAY_OPTIONS,
  INTERVAL_UNITS,
  SCHED_TYPES,
  scheduleOptionLabel,
  scheduleModelPatch,
  scheduleThinkingPatch,
  type ScheduleModelOption,
  visibleFields,
  type ScheduleEditableFields,
  type ScheduleEditorMode,
  type ScheduleForm,
  type SchedType,
} from '@/features/schedule/schedule-modal-vm';

const label: CSSProperties = {
  display: 'block', marginBottom: 5, color: MC.muted, fontSize: 13, fontWeight: 600,
};
const field: CSSProperties = {
  width: '100%', minWidth: 0, minHeight: 44, boxSizing: 'border-box',
  border: `1px solid ${MC.hairline}`, borderRadius: 'var(--r-control)', padding: '8px 10px',
  background: 'var(--material-inset-bg)', color: MC.ink, fontSize: 16, fontFamily: 'inherit',
};
const pair: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 };

type Vocab = ReturnType<typeof useVocab>;

export interface MScheduleEditorProps {
  form: ScheduleForm;
  mode: ScheduleEditorMode;
  editableFields: ScheduleEditableFields;
  modelOptions: ScheduleModelOption[];
  thinkingOptions: string[];
  valid: boolean;
  pending: boolean;
  error: string | null;
  onChange: (patch: Partial<ScheduleForm>) => void;
  onSubmit: () => void;
  onBack: () => void;
}

interface FieldsProps extends MScheduleEditorProps { copy: Vocab }

export function EditorHeader({ copy, mode, onBack }: FieldsProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 2px 12px' }}>
      <button type="button" data-action="sheet-back" onClick={onBack} aria-label={copy.back}
        style={{ border: 0, background: 'transparent', color: MC.ink, padding: 0, margin: '0 -8px 0 -10px', cursor: 'pointer', minWidth: 44, minHeight: 44, display: 'grid', placeItems: 'center' }}>
        <MBackChevron />
      </button>
      <span style={{ fontSize: 17, fontWeight: 650, color: MC.ink }}>
        {mode === 'edit' ? copy.scEditSchedule : copy.scNewSchedule}
      </span>
    </div>
  );
}

function TypeField({ copy, form, editableFields, onChange }: FieldsProps) {
  const labels: Record<SchedType, string> = {
    interval: copy.scTypeInterval, daily: copy.scTypeDaily,
    weekly: copy.scTypeWeekly, once: copy.scTypeOnce,
  };
  return (
    <div>
      <span style={label}>{copy.scType}</span>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', border: `1px solid ${MC.hairline}`, borderRadius: 'var(--r-chip)', overflow: 'hidden' }}>
        {SCHED_TYPES.map((type) => <TypeButton key={type} type={type} form={form}
          disabled={!editableFields.type} label={labels[type]} onChange={onChange} />)}
      </div>
    </div>
  );
}

function TypeButton({ type, form, disabled, label: text, onChange }: {
  type: SchedType; form: ScheduleForm; disabled: boolean; label: string;
  onChange: FieldsProps['onChange'];
}) {
  const selected = form.type === type;
  return (
    <button type="button" disabled={disabled} aria-pressed={selected} onClick={() => onChange({ type })}
      style={{ border: 0, borderRight: type === 'once' ? 0 : `1px solid ${MC.hairline}`,
        padding: '8px 2px', minHeight: 44, background: selected ? 'var(--proto-gray)' : 'var(--material-control-bg)',
        boxShadow: 'var(--material-control-shadow)', fontFamily: 'var(--font-ui)',
        color: selected ? MC.ink : MC.muted, fontSize: 13, fontWeight: selected ? 600 : 400 }}>
      {text}
    </button>
  );
}

function TimeField({ copy, form, editableFields, onChange }: FieldsProps) {
  if (!visibleFields(form.type).time) return null;
  return (
    <label>
      <span style={label}>{copy.scTime}</span>
      <input style={field} value={form.time} disabled={!editableFields.time}
        onChange={(event) => onChange({ time: event.target.value })} />
    </label>
  );
}

function IntervalField({ copy, form, editableFields, onChange }: FieldsProps) {
  if (!visibleFields(form.type).interval) return null;
  return (
    <div>
      <span style={label}>{copy.scEvery}</span>
      <div style={pair}>
        <input style={field} type="number" min={1} value={form.intervalValue}
          disabled={!editableFields.interval}
          onChange={(event) => onChange({ intervalValue: Number(event.target.value) })} />
        <MSelect style={field} title={copy.scEvery} value={form.intervalUnit} disabled={!editableFields.interval}
          onValueChange={value => onChange({ intervalUnit: value as ScheduleForm['intervalUnit'] })}
          options={INTERVAL_UNITS.map(unit => ({ value: unit, label: scheduleOptionLabel(unit, copy) }))} />
      </div>
    </div>
  );
}

function DelayField({ copy, form, editableFields, onChange }: FieldsProps) {
  if (!visibleFields(form.type).delay || !editableFields.delay) return null;
  return (
    <div data-schedule-delay>
      <span style={label}>{copy.scIn}</span>
      <div style={pair}>
        <input style={field} type="number" min={1} value={form.delayValue}
          onChange={(event) => onChange({ delayValue: Number(event.target.value) })} />
        <MSelect style={field} title={copy.scIn} value={form.delayUnit}
          onValueChange={value => onChange({ delayUnit: value as ScheduleForm['delayUnit'] })}
          options={INTERVAL_UNITS.map(unit => ({ value: unit, label: scheduleOptionLabel(unit, copy) }))} />
      </div>
    </div>
  );
}

function OnceTimingNote({ copy, form, mode }: FieldsProps) {
  if (mode !== 'edit' || form.type !== 'once') return null;
  return (
    <div data-once-timing-note style={{ border: `1px solid ${MC.hairline}`, borderRadius: 'var(--r-chip)',
      padding: 10, color: MC.muted, fontSize: 11.5, lineHeight: 1.5 }}>
      {copy.scOnceTimingUnavailable}
    </div>
  );
}

function DayField({ copy, form, editableFields, onChange }: FieldsProps) {
  if (!visibleFields(form.type).dayOfWeek) return null;
  const labels = [copy.scDaySun, copy.scDayMon, copy.scDayTue, copy.scDayWed,
    copy.scDayThu, copy.scDayFri, copy.scDaySat];
  return (
    <label>
      <span style={label}>{copy.scDay}</span>
      <MSelect style={field} title={copy.scDay} value={String(form.dayOfWeek)} disabled={!editableFields.dayOfWeek}
        onValueChange={value => onChange({ dayOfWeek: Number(value) })}
        options={DAY_OPTIONS.map(day => ({ value: String(day), label: labels[day] }))} />
    </label>
  );
}

function ModelField({ copy, form, editableFields, modelOptions, onChange }: FieldsProps) {
  return (
    <label>
      <span style={label}>{copy.scModel}</span>
      <MSelect style={field} title={copy.scModel} data-schedule-select="model" aria-label={copy.scModel}
        value={form.selection ? modelKey(form.selection) : ''} disabled={!editableFields.selection}
        onValueChange={value => onChange(scheduleModelPatch(modelOptions, value))}
        options={[{ value: '', label: copy.scChooseModel, disabled: true }, ...modelOptions.map(option => ({
          value: option.value, label: `${option.favorite ? '★ ' : ''}${option.label}`, disabled: !option.selection.mode,
        }))]} />
    </label>
  );
}

function ThinkingField({ copy, form, editableFields, thinkingOptions, onChange }: FieldsProps) {
  return (
    <label>
      <span style={label}>{copy.scThinking}</span>
      <MSelect style={field} title={copy.scThinking} data-schedule-select="thinking" aria-label={copy.scThinking}
        value={form.selection?.thinking ?? ''} disabled={!editableFields.selection || !form.selection}
        onValueChange={value => onChange(scheduleThinkingPatch(form, value))}
        options={thinkingOptions.map(value => ({ value, label: value || copy.scThinkingDefault }))} />
    </label>
  );
}

function MessageField({ copy, form, editableFields, onChange }: FieldsProps) {
  return (
    <label>
      <span style={label}>{copy.scMessage}</span>
      <textarea style={{ ...field, minHeight: 82, resize: 'vertical' }} value={form.message}
        disabled={!editableFields.message}
        onChange={(event) => onChange({ message: event.target.value })} />
    </label>
  );
}

function SubmitFields({ copy, mode, valid, pending, error, onSubmit }: FieldsProps) {
  return (
    <>
      {error && <div role="alert" style={{ color: MC.fail, fontSize: 12.5 }}>{error}</div>}
      <button type="button" data-action="save-schedule" disabled={!valid || pending} onClick={onSubmit}
        style={{ border: 0, borderRadius: 'var(--r-control)', height: 44, background: MC.inkSolid,
          color: MC.inkSolidFg, fontFamily: 'var(--font-ui)', fontSize: 15, fontWeight: 600,
          opacity: valid && !pending ? 1 : 0.45, cursor: valid && !pending ? 'pointer' : 'default' }}>
        {mode === 'edit' ? copy.scSaveSchedule : copy.scCreateSchedule}
      </button>
    </>
  );
}

export function EditorFields(props: FieldsProps) {
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <TypeField {...props} />
      <TimeField {...props} />
      <IntervalField {...props} />
      <DelayField {...props} />
      <OnceTimingNote {...props} />
      <DayField {...props} />
      <ModelField {...props} />
      <ThinkingField {...props} />
      <MessageField {...props} />
      <SubmitFields {...props} />
    </div>
  );
}
