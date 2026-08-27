// input:  mobile schedule editor props and localized schedule copy
// output: small DOM-preserving presentational field groups for MScheduleEditor
// pos:    Presentational helpers for the mobile schedule editor level
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { CSSProperties } from 'react';
import { useVocab } from '@/i18n';
import { MC, MONO } from '@/mobile/ui/kit';
import {
  DAY_OPTIONS,
  FALLBACK_OPTIONS,
  INTERVAL_UNITS,
  SCHED_TYPES,
  TARGET_OPTIONS,
  visibleFields,
  type ScheduleEditableFields,
  type ScheduleEditorMode,
  type ScheduleForm,
  type SchedType,
} from '@/features/schedule/schedule-modal-vm';

const label: CSSProperties = {
  display: 'block', marginBottom: 5, color: MC.faint,
  font: `600 9.5px ${MONO}`, letterSpacing: '.05em',
};
const field: CSSProperties = {
  width: '100%', minHeight: 40, boxSizing: 'border-box',
  border: `1px solid ${MC.hairline}`, borderRadius: 9, padding: '8px 10px',
  background: MC.card, color: MC.ink, fontSize: 13,
};
const pair: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 };

type Vocab = ReturnType<typeof useVocab>;

export interface MScheduleEditorProps {
  form: ScheduleForm;
  mode: ScheduleEditorMode;
  editableFields: ScheduleEditableFields;
  profileOptions: string[];
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
        style={{ border: 0, background: 'transparent', color: MC.run, fontSize: 20, padding: '0 3px', cursor: 'pointer' }}>
        ‹
      </button>
      <span style={{ fontSize: 17, fontWeight: 700, color: MC.ink }}>
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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', border: `1px solid ${MC.hairline}`, borderRadius: 9, overflow: 'hidden' }}>
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
        padding: '8px 2px', background: selected ? 'var(--proto-accent-bg)' : MC.card,
        color: selected ? MC.run : MC.muted, fontSize: 10.5 }}>
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
        <select style={field} value={form.intervalUnit} disabled={!editableFields.interval}
          onChange={(event) => onChange({ intervalUnit: event.target.value as ScheduleForm['intervalUnit'] })}>
          {INTERVAL_UNITS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
        </select>
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
        <select style={field} value={form.delayUnit}
          onChange={(event) => onChange({ delayUnit: event.target.value as ScheduleForm['delayUnit'] })}>
          {INTERVAL_UNITS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
        </select>
      </div>
    </div>
  );
}

function OnceTimingNote({ copy, form, mode }: FieldsProps) {
  if (mode !== 'edit' || form.type !== 'once') return null;
  return (
    <div data-once-timing-note style={{ border: `1px solid ${MC.hairline}`, borderRadius: 9,
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
      <select style={field} value={form.dayOfWeek} disabled={!editableFields.dayOfWeek}
        onChange={(event) => onChange({ dayOfWeek: Number(event.target.value) })}>
        {DAY_OPTIONS.map((day) => <option key={day.value} value={day.value}>
          {labels[day.value] ?? day.label}
        </option>)}
      </select>
    </label>
  );
}

function ProfileField({ copy, form, editableFields, profileOptions, onChange }: FieldsProps) {
  return (
    <label>
      <span style={label}>{copy.scProfile}</span>
      <select style={field} value={form.profile} disabled={!editableFields.profile}
        onChange={(event) => onChange({ profile: event.target.value })}>
        {profileOptions.map((profile) => <option key={profile} value={profile}>{profile}</option>)}
      </select>
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

function RoutingFields({ copy, form, mode, editableFields, onChange }: FieldsProps) {
  return (
    <div style={{ ...pair, opacity: mode === 'edit' ? 0.6 : 1 }}>
      <label>
        <span style={label}>{copy.scTarget}</span>
        <select style={field} value={form.target} disabled={!editableFields.target}
          onChange={(event) => onChange({ target: event.target.value as ScheduleForm['target'] })}>
          {TARGET_OPTIONS.map((target) => <option key={target} value={target}>{target}</option>)}
        </select>
      </label>
      <label>
        <span style={label}>{copy.scFallback}</span>
        <select style={field} value={form.fallback} disabled={!editableFields.fallback}
          onChange={(event) => onChange({ fallback: event.target.value as ScheduleForm['fallback'] })}>
          {FALLBACK_OPTIONS.map((fallback) => <option key={fallback} value={fallback}>{fallback}</option>)}
        </select>
      </label>
    </div>
  );
}

function SubmitFields({ copy, mode, valid, pending, error, onSubmit }: FieldsProps) {
  return (
    <>
      {error && <div role="alert" style={{ color: MC.fail, fontSize: 11.5 }}>{error}</div>}
      <button type="button" data-action="save-schedule" disabled={!valid || pending} onClick={onSubmit}
        style={{ border: 0, borderRadius: 9, padding: 11, background: MC.run,
          color: 'var(--ink-solid-fg)', fontSize: 13, fontWeight: 700 }}>
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
      <ProfileField {...props} />
      <MessageField {...props} />
      <RoutingFields {...props} />
      <SubmitFields {...props} />
    </div>
  );
}
