// input:  ScheduleForm, editable fields, Select, vocabulary
// output: ScheduleModal
// pos:    Continuous schedule glass sheet and inset controls
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import { useEffect, type CSSProperties } from 'react';
import { CONTROL_HEIGHT, Select } from '@/design';
import { useVocab } from '@/i18n';
import {
  visibleFields,
  nextRunParts,
  SCHED_TYPES,
  DAY_OPTIONS,
  INTERVAL_UNITS,
  FALLBACK_OPTIONS,
  TARGET_OPTIONS,
  type ScheduleEditableFields,
  type ScheduleForm,
  type SchedType,
} from './schedule-modal-vm';

// New-schedule overlay (design 7c), rebuilt 1:1 from prototype.dc.html L1431-1459 (+ shared backdrop
// L1291-1292). Exact inline styles / px / hex / font-size / weight / EN copy from the source; the
// prototype's static mock is made interactive: TYPE drives which field cell shows, MESSAGE is
// editable, PROFILE/TARGET/FALLBACK/DAY/unit are real controls, and Create schedule fires the real
// `schedules.add` mutation (owned by useScheduleEditorController). The DAILY state is the visual-diff bar
// (proto-shot 13); interval/weekly/once reuse the identical cell chrome, swapping the visible field.

const LABEL: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '.02em',
  color: 'var(--proto-muted)',
};

// Every field of the form — the time input, the interval pair, and the four selects — sits in this
// one cell. A select used to get a shorter, rounder box than the input beside it; sharing the cell
// (and fixing its height rather than inferring one from padding) keeps the row aligned whatever the
// control inside it is.
const focusClass = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-proto-accent';
const CELL_BOX: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  height: CONTROL_HEIGHT.md,
  boxSizing: 'border-box',
  border: '1px solid var(--proto-line-3)',
  background: 'var(--material-inset-bg)',
  borderRadius: 'var(--r-control)',
  padding: '0 10px',
};

// Shared Select trigger styled to disappear into the prototype's value-cell chrome. `bare` density
// adds nothing of its own, so the cell above owns the whole box and the trigger just fills it.
function bareSelectStyle(font: string): CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    alignSelf: 'stretch',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    font,
    color: 'var(--proto-ink)',
  };
}

export interface ScheduleModalProps {
  form: ScheduleForm;
  /** 'edit' (design 27b) locks fields omitted by schedules.update. */
  mode?: 'create' | 'edit';
  editableFields: ScheduleEditableFields;
  onChange: (patch: Partial<ScheduleForm>) => void;
  onCancel: () => void;
  onCreate: () => void;
  valid: boolean;
  pending: boolean;
  /** Real selectable agent profiles (from config.get); already includes the form's current value. */
  profileOptions: string[];
  now?: Date;
}

export function ScheduleModal({ form, mode = 'create', editableFields, onChange, onCancel, onCreate, valid, pending, profileOptions, now }: ScheduleModalProps) {
  const L = useVocab();
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
  const nextRun = onceTimingUnavailable ? null : nextRunParts(form, now ?? new Date());

  // Left 130px cell: TIME (daily/weekly) · EVERY (interval) · IN (once). PROFILE always on the right;
  // weekly inserts a DAY cell between them (grid widens to 130/130/1fr — daily stays 130/1fr, 1:1).
  const topGridCols = vis.dayOfWeek ? '130px 130px 1fr' : '130px 1fr';

  return (
    <>
      {/* backdrop (prototype L1291-1292) */}
      <div
        onClick={onCancel}
        style={{ position: 'fixed', inset: 0, background: 'var(--overlay-scrim)', backdropFilter: 'var(--material-scrim-filter)', WebkitBackdropFilter: 'var(--material-scrim-filter)', zIndex: 60, animation: 'cxfade .18s ease' }}
      />
      {/* card (prototype L1433) */}
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
        {/* header (prototype L1434) */}
        <div style={{ display: 'flex', flex: 'none', alignItems: 'center', padding: '14px 20px', borderBottom: '1px solid var(--proto-line-2)' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--proto-ink)' }}>{editing ? L.scEditSchedule : L.scNewSchedule}</span>
          <button
            type="button"
            className={focusClass}
            aria-label="Close"
            onClick={onCancel}
            style={{
              marginLeft: 'auto',
              font: "500 11px 'IBM Plex Mono',monospace",
              color: 'var(--proto-muted)',
              border: '1px solid var(--proto-line)',
              borderRadius: 'var(--r-chip)',
              padding: '5px 8px',
              cursor: 'pointer',
            }}
          >
            esc
          </button>
        </div>

        {/* body (prototype L1435) */}
        <div style={{ padding: '0 20px 16px', background: 'transparent', minHeight: 0, overflowY: 'auto' }}>
          {/* TYPE (prototype L1436-1442) */}
          <div style={{ ...LABEL, margin: '13px 0 5px' }}>{L.scType}</div>
          <div style={{ display: 'flex', border: '1px solid var(--proto-line)', borderRadius: 'var(--r-control)', overflow: 'hidden' }}>
            {SCHED_TYPES.map((t: SchedType, i) => {
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
                  style={{
                    flex: 1,
                    textAlign: 'center',
                    padding: '6px 0',
                    fontSize: 11.5,
                    fontWeight: 600,
                    color: selected ? 'var(--proto-accent)' : 'var(--proto-muted)',
                    background: selected ? 'var(--proto-accent-bg)' : undefined,
                    borderRight: i < SCHED_TYPES.length - 1 ? '1px solid var(--proto-line)' : undefined,
                    cursor: editableFields.type ? 'pointer' : 'default',
                  }}
                >
                  {TYPE_LABELS[t]}
                </button>
              );
            })}
          </div>

          {/* [left cell] + [DAY if weekly] + PROFILE (prototype L1443-1446) */}
          <div style={{ display: 'grid', gridTemplateColumns: topGridCols, gap: 12, marginTop: 12 }}>
            {/* left cell */}
            <div>
              {vis.time && (
                <>
                  <div style={{ ...LABEL, marginBottom: 5 }}>{L.scTime}</div>
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
                        font: "600 12px 'IBM Plex Mono',monospace",
                        color: 'var(--proto-ink)',
                      }}
                    />
                    <span style={{ marginLeft: 'auto', font: "400 11px 'IBM Plex Mono',monospace", color: 'var(--proto-muted)' }}>24h</span>
                  </div>
                </>
              )}
              {vis.interval && (
                <>
                  <div style={{ ...LABEL, marginBottom: 5 }}>{L.scEvery}</div>
                  <div style={CELL_BOX}>
                    <input
                      type="number"
                      min={1}
                      value={form.intervalValue}
                      className={focusClass}
                      aria-label={L.scEvery}
                      disabled={!editableFields.interval}
                      onChange={(e) => onChange({ intervalValue: Number(e.target.value) })}
                      style={{
                        width: 44,
                        border: 'none',
                        background: 'transparent',
                        font: "600 12px 'IBM Plex Mono',monospace",
                        color: 'var(--proto-ink)',
                      }}
                    />
                    <Select
                      data-schedule-select="intervalUnit"
                      density="bare"
                      aria-label={L.scEvery}
                      value={form.intervalUnit}
                      disabled={!editableFields.interval}
                      options={INTERVAL_UNITS.map((unit) => ({ value: unit, label: unit }))}
                      onValueChange={(intervalUnit) => onChange({ intervalUnit })}
                      style={bareSelectStyle("400 11px 'IBM Plex Mono',monospace")}
                    />
                  </div>
                </>
              )}
              {vis.delay && editableFields.delay && (
                <>
                  <div style={{ ...LABEL, marginBottom: 5 }}>{L.scIn}</div>
                  <div data-schedule-delay style={CELL_BOX}>
                    <input
                      type="number"
                      min={1}
                      value={form.delayValue}
                      className={focusClass}
                      aria-label={L.scIn}
                      onChange={(e) => onChange({ delayValue: Number(e.target.value) })}
                      style={{
                        width: 44,
                        border: 'none',
                        background: 'transparent',
                        font: "600 12px 'IBM Plex Mono',monospace",
                        color: 'var(--proto-ink)',
                      }}
                    />
                    <Select
                      data-schedule-select="delayUnit"
                      density="bare"
                      aria-label={L.scIn}
                      value={form.delayUnit}
                      options={INTERVAL_UNITS.map((unit) => ({ value: unit, label: unit }))}
                      onValueChange={(delayUnit) => onChange({ delayUnit })}
                      style={bareSelectStyle("400 11px 'IBM Plex Mono',monospace")}
                    />
                  </div>
                </>
              )}
              {onceTimingUnavailable && (
                <div
                  data-once-timing-note
                  style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--proto-muted)'  }}
                >
                  {L.scOnceTimingUnavailable}
                </div>
              )}
            </div>

            {/* DAY (weekly only) */}
            {vis.dayOfWeek && (
              <div>
                <div style={{ ...LABEL, marginBottom: 5 }}>{L.scDay}</div>
                <div style={CELL_BOX}>
                  <Select
                    data-schedule-select="dayOfWeek"
                    density="bare"
                    aria-label={L.scDay}
                    value={form.dayOfWeek}
                    disabled={!editableFields.dayOfWeek}
                    options={DAY_OPTIONS.map((day) => ({
                      value: day.value,
                      label: DAY_LABELS[day.value] ?? day.label,
                    }))}
                    onValueChange={(dayOfWeek) => onChange({ dayOfWeek })}
                    style={bareSelectStyle("500 11.5px 'IBM Plex Mono',monospace")}
                  />
                </div>
              </div>
            )}

            {/* PROFILE (prototype L1445) */}
            <div>
              <div style={{ ...LABEL, marginBottom: 5 }}>{L.scProfile}</div>
              <div style={CELL_BOX}>
                <Select
                  data-schedule-select="profile"
                  density="bare"
                  aria-label={L.scProfile}
                  value={form.profile}
                  disabled={!editableFields.profile}
                  options={profileOptions.map((profile) => ({ value: profile, label: profile }))}
                  onValueChange={(profile) => onChange({ profile })}
                  style={bareSelectStyle("500 11.5px 'IBM Plex Mono',monospace")}
                />
              </div>
            </div>
          </div>

          {/* MESSAGE (prototype L1447-1448) */}
          <div style={{ ...LABEL, margin: '12px 0 5px' }}>{L.scMessage}</div>
          <div style={{ border: '1px solid var(--proto-line-3)', background: 'var(--material-inset-bg)', borderRadius: 'var(--r-control)', padding: '8px 11px', minHeight: 38 }}>
            <textarea
              className={focusClass}
              aria-label={L.scMessage}
              value={form.message}
              disabled={!editableFields.message}
              onChange={(e) => onChange({ message: e.target.value })}
              placeholder={L.scMessagePh}
              rows={2}
              style={{
                width: '100%',
                border: 'none',
                resize: 'none',
                background: 'transparent',
                fontSize: 11.5,
                lineHeight: 1.55,
                color: 'var(--proto-ink-2)',
                fontFamily: 'inherit',
              }}
            />
          </div>

          {/* TARGET + FALLBACK (prototype L1449-1452) — not patchable via schedules.update, so
              edit mode shows them read-only (prefill from the persisted record). */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
            <div>
              <div style={{ ...LABEL, marginBottom: 5 }}>{L.scTarget}</div>
              <div style={CELL_BOX}>
                <Select
                  data-schedule-select="target"
                  density="bare"
                  aria-label={L.scTarget}
                  value={form.target}
                  disabled={!editableFields.target}
                  options={TARGET_OPTIONS.map((target) => ({ value: target, label: target }))}
                  onValueChange={(target) => onChange({ target })}
                  style={{
                    ...bareSelectStyle('11.5px system-ui, sans-serif'),
                    cursor: editableFields.target ? 'pointer' : 'not-allowed',
                  }}
                />
              </div>
            </div>
            <div>
              <div style={{ ...LABEL, marginBottom: 5 }}>{L.scFallback}</div>
              <div style={CELL_BOX}>
                <Select
                  data-schedule-select="fallback"
                  density="bare"
                  aria-label={L.scFallback}
                  value={form.fallback}
                  disabled={!editableFields.fallback}
                  options={FALLBACK_OPTIONS.map((fallback) => ({ value: fallback, label: fallback }))}
                  onValueChange={(fallback) => onChange({ fallback })}
                  style={{
                    ...bareSelectStyle('11.5px system-ui, sans-serif'),
                    cursor: editableFields.fallback ? 'pointer' : 'not-allowed',
                  }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* footer (prototype L1454-1458) */}
        <div style={{ display: 'flex', flex: 'none', alignItems: 'center', gap: 10, padding: '16px 20px', borderTop: '1px solid var(--proto-line-2)', background: 'transparent' }}>
          {nextRun && (
            <span data-schedule-next-run style={{ font: "500 11px 'IBM Plex Mono',monospace", color: 'var(--proto-muted)' }}>
              {L.scNextRun} <b style={{ color: 'var(--proto-accent)' }}>{nextRun.clock}</b> · {L.scFooterIn} {nextRun.delta}
            </span>
          )}
          <button
            type="button"
            className={focusClass}
            onClick={onCancel}
            style={{
              marginLeft: 'auto',
              fontSize: 12,
              flex: 'none',
              fontWeight: 600,
              border: '1px solid var(--proto-line-3)',
              borderRadius: 'var(--r-control)',
              padding: '6px 13px',
              color: 'var(--proto-ink)',
              cursor: 'pointer',
            }}
          >
            {L.cancel}
          </button>
          <button
            type="button"
            className={focusClass}
            disabled={!canCreate}
            data-action="create-schedule"
            onClick={() => canCreate && onCreate()}
            style={{
              fontSize: 12,
              fontWeight: 600,
              flex: 'none',
              borderRadius: 'var(--r-control)',
              padding: '7px 15px',
              color: canCreate ? 'var(--ink-solid-fg)' : 'var(--proto-muted)',
              background: canCreate ? 'var(--proto-accent)' : 'var(--proto-gray)',
              cursor: canCreate ? 'pointer' : 'not-allowed',
            }}
          >
            {editing ? L.scSaveSchedule : L.scCreateSchedule}
          </button>
        </div>
      </div>
    </>
  );
}
