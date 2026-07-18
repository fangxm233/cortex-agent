import { useEffect, type CSSProperties } from 'react';
import { useVocab } from '@/i18n';
import {
  visibleFields,
  nextRunParts,
  SCHED_TYPES,
  DAY_OPTIONS,
  INTERVAL_UNITS,
  FALLBACK_OPTIONS,
  TARGET_OPTIONS,
  type ScheduleForm,
  type SchedType,
} from './schedule-modal-vm';

// New-schedule overlay (design 7c), rebuilt 1:1 from prototype.dc.html L1431-1459 (+ shared backdrop
// L1291-1292). Exact inline styles / px / hex / font-size / weight / EN copy from the source; the
// prototype's static mock is made interactive: TYPE drives which field cell shows, MESSAGE is
// editable, PROFILE/TARGET/FALLBACK/DAY/unit are real controls, and Create schedule fires the real
// `schedules.add` mutation (owned by ScheduleModalProvider). The DAILY state is the visual-diff bar
// (proto-shot 13); interval/weekly/once reuse the identical cell chrome, swapping the visible field.

const LABEL: CSSProperties = {
  fontSize: 9.5,
  fontWeight: 700,
  letterSpacing: '.05em',
  color: 'var(--proto-muted-3)',
};

const CELL_BOX: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  border: '1px solid var(--proto-line)',
  borderRadius: 8,
  padding: '7px 10px',
};

const CARET: CSSProperties = { marginLeft: 'auto', color: 'var(--proto-muted-3)', fontSize: 8 };

// A native <select> styled to disappear into the prototype's value chrome (+ a ▾ glyph).
function bareSelectStyle(font: string): CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    border: 'none',
    outline: 'none',
    background: 'transparent',
    appearance: 'none',
    WebkitAppearance: 'none',
    MozAppearance: 'none',
    cursor: 'pointer',
    font,
    color: 'var(--proto-ink)',
  };
}

export interface ScheduleModalProps {
  form: ScheduleForm;
  onChange: (patch: Partial<ScheduleForm>) => void;
  onCancel: () => void;
  onCreate: () => void;
  valid: boolean;
  pending: boolean;
  /** Real selectable agent profiles (from config.get); already includes the form's current value. */
  profileOptions: string[];
  now?: Date;
}

export function ScheduleModal({ form, onChange, onCancel, onCreate, valid, pending, profileOptions, now }: ScheduleModalProps) {
  const L = useVocab();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
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
  const { clock, delta } = nextRunParts(form, now ?? new Date());
  const canCreate = valid && !pending;

  // Left 130px cell: TIME (daily/weekly) · EVERY (interval) · IN (once). PROFILE always on the right;
  // weekly inserts a DAY cell between them (grid widens to 130/130/1fr — daily stays 130/1fr, 1:1).
  const topGridCols = vis.dayOfWeek ? '130px 130px 1fr' : '130px 1fr';

  return (
    <>
      {/* backdrop (prototype L1291-1292) */}
      <div
        onClick={onCancel}
        style={{ position: 'fixed', inset: 0, background: 'rgba(25,28,34,.34)', zIndex: 60, animation: 'cxfade .18s ease' }}
      />
      {/* card (prototype L1433) */}
      <div
        data-schedule-modal
        data-sched-type={form.type}
        style={{
          position: 'fixed',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%,-50%)',
          animation: 'cxmodal .26s cubic-bezier(.22,1,.36,1)',
          width: 560,
          background: 'var(--proto-card)',
          borderRadius: 14,
          boxShadow: '0 24px 64px rgba(16,24,40,.3)',
          zIndex: 61,
          overflow: 'hidden',
        }}
      >
        {/* header (prototype L1434) */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '14px 20px 0' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--proto-ink)' }}>{L.scNewSchedule}</span>
          <span
            onClick={onCancel}
            style={{
              marginLeft: 'auto',
              font: "500 9.5px 'IBM Plex Mono',monospace",
              color: 'var(--proto-muted-3)',
              border: '1px solid var(--proto-line)',
              borderRadius: 5,
              padding: '2px 6px',
              cursor: 'pointer',
            }}
          >
            esc
          </span>
        </div>

        {/* body (prototype L1435) */}
        <div style={{ padding: '0 20px' }}>
          {/* TYPE (prototype L1436-1442) */}
          <div style={{ ...LABEL, margin: '13px 0 5px' }}>{L.scType}</div>
          <div style={{ display: 'flex', border: '1px solid var(--proto-line)', borderRadius: 8, overflow: 'hidden' }}>
            {SCHED_TYPES.map((t: SchedType, i) => {
              const selected = form.type === t;
              return (
                <span
                  key={t}
                  data-sched-type-opt={t}
                  aria-pressed={selected}
                  onClick={() => onChange({ type: t })}
                  style={{
                    flex: 1,
                    textAlign: 'center',
                    padding: '6px 0',
                    fontSize: 11.5,
                    fontWeight: 600,
                    color: selected ? 'var(--proto-accent)' : 'var(--proto-muted-2)',
                    background: selected ? 'var(--proto-accent-bg)' : undefined,
                    borderRight: i < SCHED_TYPES.length - 1 ? '1px solid var(--proto-line)' : undefined,
                    cursor: 'pointer',
                  }}
                >
                  {TYPE_LABELS[t]}
                </span>
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
                      onChange={(e) => onChange({ time: e.target.value })}
                      placeholder="09:00"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        border: 'none',
                        outline: 'none',
                        background: 'transparent',
                        font: "600 12px 'IBM Plex Mono',monospace",
                        color: 'var(--proto-ink)',
                      }}
                    />
                    <span style={{ marginLeft: 'auto', font: "400 9px 'IBM Plex Mono',monospace", color: 'var(--proto-faint)' }}>24h</span>
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
                      onChange={(e) => onChange({ intervalValue: Number(e.target.value) })}
                      style={{
                        width: 44,
                        border: 'none',
                        outline: 'none',
                        background: 'transparent',
                        font: "600 12px 'IBM Plex Mono',monospace",
                        color: 'var(--proto-ink)',
                      }}
                    />
                    <select
                      value={form.intervalUnit}
                      onChange={(e) => onChange({ intervalUnit: e.target.value as ScheduleForm['intervalUnit'] })}
                      style={bareSelectStyle("400 10px 'IBM Plex Mono',monospace")}
                    >
                      {INTERVAL_UNITS.map((u) => (
                        <option key={u} value={u}>{u}</option>
                      ))}
                    </select>
                    <span style={CARET}>▾</span>
                  </div>
                </>
              )}
              {vis.delay && (
                <>
                  <div style={{ ...LABEL, marginBottom: 5 }}>{L.scIn}</div>
                  <div style={CELL_BOX}>
                    <input
                      type="number"
                      min={1}
                      value={form.delayValue}
                      onChange={(e) => onChange({ delayValue: Number(e.target.value) })}
                      style={{
                        width: 44,
                        border: 'none',
                        outline: 'none',
                        background: 'transparent',
                        font: "600 12px 'IBM Plex Mono',monospace",
                        color: 'var(--proto-ink)',
                      }}
                    />
                    <select
                      value={form.delayUnit}
                      onChange={(e) => onChange({ delayUnit: e.target.value as ScheduleForm['delayUnit'] })}
                      style={bareSelectStyle("400 10px 'IBM Plex Mono',monospace")}
                    >
                      {INTERVAL_UNITS.map((u) => (
                        <option key={u} value={u}>{u}</option>
                      ))}
                    </select>
                    <span style={CARET}>▾</span>
                  </div>
                </>
              )}
            </div>

            {/* DAY (weekly only) */}
            {vis.dayOfWeek && (
              <div>
                <div style={{ ...LABEL, marginBottom: 5 }}>{L.scDay}</div>
                <div style={CELL_BOX}>
                  <select
                    value={form.dayOfWeek}
                    onChange={(e) => onChange({ dayOfWeek: Number(e.target.value) })}
                    style={bareSelectStyle("500 11.5px 'IBM Plex Mono',monospace")}
                  >
                    {DAY_OPTIONS.map((d) => (
                      <option key={d.value} value={d.value}>{DAY_LABELS[d.value] ?? d.label}</option>
                    ))}
                  </select>
                  <span style={CARET}>▾</span>
                </div>
              </div>
            )}

            {/* PROFILE (prototype L1445) */}
            <div>
              <div style={{ ...LABEL, marginBottom: 5 }}>{L.scProfile}</div>
              <div style={CELL_BOX}>
                <select
                  value={form.profile}
                  onChange={(e) => onChange({ profile: e.target.value })}
                  style={bareSelectStyle("500 11.5px 'IBM Plex Mono',monospace")}
                >
                  {profileOptions.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
                <span style={CARET}>▾</span>
              </div>
            </div>
          </div>

          {/* MESSAGE (prototype L1447-1448) */}
          <div style={{ ...LABEL, margin: '12px 0 5px' }}>{L.scMessage}</div>
          <div style={{ border: '1px solid var(--proto-line)', borderRadius: 8, padding: '8px 11px', minHeight: 38 }}>
            <textarea
              value={form.message}
              onChange={(e) => onChange({ message: e.target.value })}
              placeholder={L.scMessagePh}
              rows={2}
              style={{
                width: '100%',
                border: 'none',
                outline: 'none',
                resize: 'none',
                background: 'transparent',
                fontSize: 11.5,
                lineHeight: 1.55,
                color: 'var(--proto-ink-2)',
                fontFamily: 'inherit',
              }}
            />
          </div>

          {/* TARGET + FALLBACK (prototype L1449-1452) */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
            <div>
              <div style={{ ...LABEL, marginBottom: 5 }}>{L.scTarget}</div>
              <div style={CELL_BOX}>
                <select
                  value={form.target}
                  onChange={(e) => onChange({ target: e.target.value as ScheduleForm['target'] })}
                  style={bareSelectStyle('11.5px system-ui, sans-serif')}
                >
                  {TARGET_OPTIONS.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                <span style={CARET}>▾</span>
              </div>
            </div>
            <div>
              <div style={{ ...LABEL, marginBottom: 5 }}>{L.scFallback}</div>
              <div style={CELL_BOX}>
                <select
                  value={form.fallback}
                  onChange={(e) => onChange({ fallback: e.target.value as ScheduleForm['fallback'] })}
                  style={bareSelectStyle('11.5px system-ui, sans-serif')}
                >
                  {FALLBACK_OPTIONS.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
                <span style={CARET}>▾</span>
              </div>
            </div>
          </div>
        </div>

        {/* footer (prototype L1454-1458) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 20px 16px' }}>
          <span style={{ font: "500 10px 'IBM Plex Mono',monospace", color: 'var(--proto-muted)' }}>
            {L.scNextRun} <b style={{ color: 'var(--proto-accent)' }}>{clock}</b> · {L.scFooterIn} {delta}
          </span>
          <span
            onClick={onCancel}
            style={{
              marginLeft: 'auto',
              fontSize: 11.5,
              fontWeight: 600,
              border: '1px solid var(--proto-line-3)',
              borderRadius: 8,
              padding: '6px 13px',
              color: 'var(--proto-ink)',
              cursor: 'pointer',
            }}
          >
            {L.cancel}
          </span>
          <span
            data-action="create-schedule"
            onClick={() => canCreate && onCreate()}
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              borderRadius: 8,
              padding: '7px 15px',
              color: 'var(--ink-solid-fg)',
              background: 'var(--proto-accent)',
              cursor: canCreate ? 'pointer' : 'not-allowed',
              opacity: canCreate ? 1 : 0.55,
            }}
          >
            {L.scCreateSchedule}
          </span>
        </div>
      </div>
    </>
  );
}
