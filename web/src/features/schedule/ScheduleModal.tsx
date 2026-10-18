import { useEffect, type CSSProperties } from 'react';
import { Button, IconButton, Select } from '@/design';
import { fmt, useLang, useVocab } from '@/i18n';
import { modelKey } from '@/lib/model-selection';
import {
  visibleFields,
  nextRunParts,
  SCHED_TYPES,
  DAY_OPTIONS,
  INTERVAL_UNITS,
  scheduleOptionLabel,
  scheduleModelPatch,
  scheduleThinkingPatch,
  type ScheduleModelOption,
  type ScheduleEditableFields,
  type ScheduleForm,
  type SchedType,
} from './schedule-modal-vm';

// New-schedule overlay (design 7c), restyled to the v2 dialog grammar (Panels mockup): a 16/620
// title with a quiet × close, sentence-case field labels, a segmented type control, UI-face fields
// and an ink primary. The form stays live: TYPE drives which field cell shows, MESSAGE is editable,
// MODEL/DAY/unit are real controls, and Create schedule fires the real `schedules.add` mutation
// (owned by useScheduleEditorController). interval/weekly/once reuse the identical cell chrome,
// swapping the visible field.

// Labels are hierarchy by weight and colour, not by case: an uppercase tracked label reads as a
// code token sitting above the field rather than as the field's name.
const LABEL: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 550,
  color: 'var(--proto-muted)',
  marginBottom: 6,
};

// Every field of the form — the time input, the interval pair, and the four selects — sits in this
// one cell. A select used to get a shorter, rounder box than the input beside it; sharing the cell
// (and fixing its height rather than inferring one from padding) keeps the row aligned whatever the
// control inside it is. The cell is a raised control surface with a hairline, not a recessed well:
// it is where the user types, so it reads as the brightest thing in the sheet.
const FIELD_HEIGHT = 36;
// Longhands rather than a `font` shorthand, so a field's `tabular-nums` is not reset by it.
const FIELD_TEXT: CSSProperties = { fontFamily: 'var(--font-ui)', fontSize: 13.5, fontWeight: 400 };
const focusClass = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-proto-accent';
const CELL_BOX: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  height: FIELD_HEIGHT,
  boxSizing: 'border-box',
  border: '1px solid var(--proto-line-4)',
  background: 'var(--material-control-bg)',
  borderRadius: 'var(--r-control)',
  padding: '0 12px',
};

const NUMBER_INPUT: CSSProperties = {
  width: 44,
  border: 'none',
  background: 'transparent',
  ...FIELD_TEXT,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--proto-ink)',
};

// Shared Select trigger styled to disappear into the value-cell chrome. `bare` density adds nothing
// of its own, so the cell above owns the whole box and the trigger just fills it.
function bareSelectStyle(): CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    alignSelf: 'stretch',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    ...FIELD_TEXT,
    color: 'var(--proto-ink)',
  };
}

// The type picker is the sheet's one segmented control: a recessed track holding a raised active
// option. The active option is lifted, not tinted — the accent is reserved for focus and state.
const SEG_TRACK: CSSProperties = {
  display: 'flex',
  gap: 2,
  padding: 3,
  borderRadius: 'var(--r-control)',
  background: 'var(--proto-line-2)',
};

function segOptionStyle(selected: boolean, editable: boolean): CSSProperties {
  return {
    flex: 1,
    height: 28,
    padding: '0 10px',
    border: 0,
    borderRadius: 'calc(var(--r-control) - 3px)',
    textAlign: 'center',
    whiteSpace: 'nowrap',
    fontSize: 13,
    fontWeight: selected ? 550 : 400,
    color: selected ? 'var(--proto-ink)' : 'var(--proto-muted)',
    background: selected ? 'var(--material-control-bg)' : 'transparent',
    boxShadow: selected ? 'var(--material-control-shadow)' : 'none',
    cursor: editable ? 'pointer' : 'default',
  };
}

function CloseGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" aria-hidden="true">
      <path d="m4.5 4.5 7 7m0-7-7 7" />
    </svg>
  );
}

export interface ScheduleModalProps {
  form: ScheduleForm;
  /** 'edit' (design 27b) locks fields omitted by schedules.update. */
  mode: 'create' | 'edit';
  editableFields: ScheduleEditableFields;
  onChange: (patch: Partial<ScheduleForm>) => void;
  onCancel: () => void;
  onCreate: () => void;
  valid: boolean;
  pending: boolean;
  modelOptions: ScheduleModelOption[];
  thinkingOptions: string[];
  now?: Date;
}

function ModelFields({ form, editableFields, onChange, modelOptions, thinkingOptions }: ScheduleModalProps) {
  const L = useVocab();
  return <div style={{ minWidth: 0, display: 'grid', gap: 12 }}>
    <div><div style={LABEL}>{L.scModel}</div>
      <div style={CELL_BOX}><Select data-schedule-select="model" density="bare" aria-label={L.scModel}
        value={form.selection ? modelKey(form.selection) : ''} placeholder={L.scChooseModel}
        disabled={!editableFields.selection} options={modelOptions.map((option) => ({
          value: option.value, label: `${option.favorite ? '★ ' : ''}${option.label}`, disabled: !option.selection.mode,
        }))} onValueChange={(value) => onChange(scheduleModelPatch(modelOptions, value))}
        style={bareSelectStyle()} /></div>
    </div>
    <div><div style={LABEL}>{L.scThinking}</div>
      <div style={CELL_BOX}><Select data-schedule-select="thinking" density="bare" aria-label={L.scThinking}
        value={form.selection?.thinking ?? ''} disabled={!editableFields.selection || !form.selection}
        options={thinkingOptions.map((value) => ({ value, label: value || L.scThinkingDefault }))}
        onValueChange={(value) => onChange(scheduleThinkingPatch(form, value))}
        style={bareSelectStyle()} /></div>
    </div>
  </div>;
}

export function ScheduleModal(props: ScheduleModalProps) {
  const { form, mode, editableFields, onChange, onCancel, onCreate, valid, pending, now } = props;
  const L = useVocab();
  const lang = useLang();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  // Display labels for enum values sourced from the VM (values stay unchanged; only the rendered
  // text is localized at this call site).
  const TYPE_LABELS: Record<SchedType, string> = {
    interval: L.scTypeInterval,
    daily: L.scTypeDaily,
    weekly: L.scTypeWeekly,
    once: L.scTypeOnce,
  };
  const DAY_LABELS: Record<number, string> = {
    0: L.scDaySun,
    1: L.scDayMon,
    2: L.scDayTue,
    3: L.scDayWed,
    4: L.scDayThu,
    5: L.scDayFri,
    6: L.scDaySat,
  };

  const vis = visibleFields(form.type);
  const canCreate = valid && !pending;
  const editing = mode === 'edit';
  const onceTimingUnavailable = editing && form.type === 'once';
  const nextRun = onceTimingUnavailable ? null : nextRunParts(form, now ?? new Date(), lang);

  // Left 150px cell: TIME (daily/weekly) · EVERY (interval) · IN (once). MODEL always on the right;
  // weekly inserts a DAY cell between them (grid widens to 150/130/1fr — daily stays 150/1fr).
  const topGridCols = vis.dayOfWeek ? '150px 130px 1fr' : '150px 1fr';

  return (
    <>
      {/* backdrop */}
      <div
        onClick={onCancel}
        style={{ position: 'fixed', inset: 0, background: 'var(--overlay-scrim)', backdropFilter: 'var(--material-scrim-filter)', WebkitBackdropFilter: 'var(--material-scrim-filter)', zIndex: 60, animation: 'cxfade .18s ease' }}
      />
      {/* card */}
      <div
        data-schedule-modal
        role="dialog"
        aria-label={editing ? L.scEditSchedule : L.scNewSchedule}
        data-sched-type={form.type}
        style={{
          position: 'fixed',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%,-50%)',
          animation: 'cxmodal .26s cubic-bezier(.22,1,.36,1)',
          width: 560,
          maxWidth: 'calc(100vw - 40px)',
          maxHeight: 'calc(100dvh - 40px)',
          display: 'flex',
          flexDirection: 'column',
          // Floating glass sheet, matching design/Modal: a top-level overlay is the one shape
          // `backdrop-filter` is affordable on, because the sheet holds still and the backdrop is
          // sampled once per open rather than on every scroll frame of the form inside it.
          background: 'var(--material-overlay-bg)',
          backdropFilter: 'var(--glass-filter)',
          WebkitBackdropFilter: 'var(--glass-filter)',
          borderRadius: 'var(--r-float)',
          boxShadow: 'var(--material-overlay-shadow)',
          zIndex: 61,
          overflow: 'hidden',
        }}
      >
        {/* header: the title and a quiet close. Escape still closes; it no longer needs a keycap. */}
        <div style={{ display: 'flex', flex: 'none', alignItems: 'center', gap: 8, padding: '16px 14px 0 22px' }}>
          <span style={{ fontSize: 16, fontWeight: 620, color: 'var(--proto-ink)' }}>{editing ? L.scEditSchedule : L.scNewSchedule}</span>
          <IconButton label={L.cmClose} size={28} onClick={onCancel} style={{ marginLeft: 'auto' }}>
            <CloseGlyph />
          </IconButton>
        </div>

        {/* body */}
        <div style={{ padding: '18px 22px 20px', display: 'flex', flexDirection: 'column', gap: 16, background: 'transparent', minHeight: 0, overflowY: 'auto', scrollbarGutter: 'stable' }}>
          {/* TYPE */}
          <div>
            <div style={LABEL}>{L.scType}</div>
            <div role="group" aria-label={L.scType} style={SEG_TRACK}>
              {SCHED_TYPES.map((t: SchedType) => {
                const selected = form.type === t;
                return (
                  <button
                    type="button"
                    className={focusClass}
                    disabled={!editableFields.type}
                    key={t}
                    data-sched-type-opt={t}
                    aria-pressed={selected}
                    onClick={editableFields.type ? () => onChange({ type: t }) : undefined}
                    style={segOptionStyle(selected, editableFields.type)}
                  >
                    {TYPE_LABELS[t]}
                  </button>
                );
              })}
            </div>
          </div>

          {/* [left cell] + [DAY if weekly] + MODEL */}
          <div style={{ display: 'grid', gridTemplateColumns: topGridCols, gap: 12 }}>
            {/* left cell */}
            <div>
              {vis.time && (
                <>
                  <div style={LABEL}>{L.scTime}</div>
                  <div style={CELL_BOX}>
                    <input
                      value={form.time}
                      className={focusClass}
                      aria-label={L.scTime}
                      disabled={!editableFields.time}
                      onChange={(e) => onChange({ time: e.target.value })}
                      placeholder="09:00"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        border: 'none',
                        background: 'transparent',
                        ...FIELD_TEXT,
                        fontVariantNumeric: 'tabular-nums',
                        color: 'var(--proto-ink)',
                      }}
                    />
                    <span style={{ marginLeft: 'auto', flex: 'none', fontSize: 12, color: 'var(--proto-muted)' }}>{L.schedClock24h}</span>
                  </div>
                </>
              )}
              {vis.interval && (
                <>
                  <div style={LABEL}>{L.scEvery}</div>
                  <div style={CELL_BOX}>
                    <input
                      type="number"
                      min={1}
                      value={form.intervalValue}
                      className={focusClass}
                      aria-label={L.scEvery}
                      disabled={!editableFields.interval}
                      onChange={(e) => onChange({ intervalValue: Number(e.target.value) })}
                      style={NUMBER_INPUT}
                    />
                    <Select
                      data-schedule-select="intervalUnit"
                      density="bare"
                      aria-label={L.scEvery}
                      value={form.intervalUnit}
                      disabled={!editableFields.interval}
                      options={INTERVAL_UNITS.map((unit) => ({ value: unit, label: scheduleOptionLabel(unit, L) }))}
                      onValueChange={(intervalUnit) => onChange({ intervalUnit })}
                      style={bareSelectStyle()}
                    />
                  </div>
                </>
              )}
              {vis.delay && editableFields.delay && (
                <>
                  <div style={LABEL}>{L.scIn}</div>
                  <div data-schedule-delay style={CELL_BOX}>
                    <input
                      type="number"
                      min={1}
                      value={form.delayValue}
                      className={focusClass}
                      aria-label={L.scIn}
                      onChange={(e) => onChange({ delayValue: Number(e.target.value) })}
                      style={NUMBER_INPUT}
                    />
                    <Select
                      data-schedule-select="delayUnit"
                      density="bare"
                      aria-label={L.scIn}
                      value={form.delayUnit}
                      options={INTERVAL_UNITS.map((unit) => ({ value: unit, label: scheduleOptionLabel(unit, L) }))}
                      onValueChange={(delayUnit) => onChange({ delayUnit })}
                      style={bareSelectStyle()}
                    />
                  </div>
                </>
              )}
              {onceTimingUnavailable && (
                <div
                  data-once-timing-note
                  style={{ fontSize: 12.5, lineHeight: 1.45, color: 'var(--proto-muted)'  }}
                >
                  {L.scOnceTimingUnavailable}
                </div>
              )}
            </div>

            {/* DAY (weekly only) */}
            {vis.dayOfWeek && (
              <div>
                <div style={LABEL}>{L.scDay}</div>
                <div style={CELL_BOX}>
                  <Select
                    data-schedule-select="dayOfWeek"
                    density="bare"
                    aria-label={L.scDay}
                    value={form.dayOfWeek}
                    disabled={!editableFields.dayOfWeek}
                    options={DAY_OPTIONS.map((day) => ({ value: day, label: DAY_LABELS[day] }))}
                    onValueChange={(dayOfWeek) => onChange({ dayOfWeek })}
                    style={bareSelectStyle()}
                  />
                </div>
              </div>
            )}

            <ModelFields {...props} />
          </div>

          {/* MESSAGE */}
          <div>
            <div style={LABEL}>{L.scMessage}</div>
            <div style={{ border: '1px solid var(--proto-line-4)', background: 'var(--material-control-bg)', borderRadius: 'var(--r-control)', padding: '10px 12px', minHeight: 92, boxSizing: 'border-box', display: 'flex' }}>
              <textarea
                className={focusClass}
                aria-label={L.scMessage}
                value={form.message}
                disabled={!editableFields.message}
                onChange={(e) => onChange({ message: e.target.value })}
                placeholder={L.scMessagePh}
                rows={3}
                style={{
                  width: '100%',
                  border: 'none',
                  resize: 'none',
                  background: 'transparent',
                  font: '400 13.5px/1.6 var(--font-ui)',
                  color: 'var(--proto-ink)',
                }}
              />
            </div>
          </div>
        </div>

        {/* footer: when it next runs, in words, then the two actions */}
        <div style={{ display: 'flex', flex: 'none', alignItems: 'center', gap: 8, padding: '14px 22px 18px', borderTop: '1px solid var(--proto-line-2)', background: 'transparent' }}>
          {nextRun && (
            <span data-schedule-next-run style={{ minWidth: 0, fontSize: 12.5, color: 'var(--proto-muted)', fontVariantNumeric: 'tabular-nums' }}>
              {fmt(L.scNextRunLine, { day: nextRun.day, clock: nextRun.clock, until: fmt(L.timeUntil, { span: nextRun.delta }) })}
            </span>
          )}
          <Button variant="secondary" onClick={onCancel} style={{ marginLeft: 'auto', flex: 'none' }}>
            {L.cancel}
          </Button>
          <Button
            variant="primary"
            disabled={!canCreate}
            data-action="create-schedule"
            onClick={() => canCreate && onCreate()}
            style={{ flex: 'none' }}
          >
            {editing ? L.scSaveSchedule : L.scCreateSchedule}
          </Button>
        </div>
      </div>
    </>
  );
}
