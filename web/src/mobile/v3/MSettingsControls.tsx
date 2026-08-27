// input:  mobile UI primitives, labels, field feedback and form callbacks
// output: compact settings page, rows, toggles and validated fields
// pos:    Shared presentation controls for mobile settings drill-ins
// >>> If I am updated, update my header comment and CORTEX.md <<<

import type { CSSProperties, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { MCard, MDrillHeader, MScreen, MScrollBody, MC, MONO } from '@/mobile/ui/kit';

export const MSET_TITLE: CSSProperties = { fontSize: 13.5, fontWeight: 600, color: MC.ink };
export const MSET_SUB: CSSProperties = { fontSize: 10.5, color: MC.muted, lineHeight: 1.45, marginTop: 2 };
export const MSET_KEY: CSSProperties = { font: `400 9px ${MONO}`, color: MC.faint };

export function MSettingsPage(props: { title: string; onBack: () => void; children: ReactNode; trailing?: ReactNode }) {
  return (
    <MScreen label={`Settings · ${props.title}`} header={
      <MDrillHeader onBack={props.onBack} trailing={props.trailing}>
        <span style={{ fontSize: 16, fontWeight: 650, color: MC.ink }}>{props.title}</span>
      </MDrillHeader>
    }>
      <MScrollBody>{props.children}</MScrollBody>
    </MScreen>
  );
}

export function MSettingsCard(props: { children: ReactNode; title?: string; note?: string }) {
  return (
    <div>
      {props.title && <div style={{ ...MSET_KEY, padding: '0 2px 5px', fontWeight: 700 }}>{props.title}</div>}
      <MCard padding={0} style={{ overflow: 'hidden' }}>{props.children}</MCard>
      {props.note && <div style={{ ...MSET_SUB, padding: '6px 3px 0' }}>{props.note}</div>}
    </div>
  );
}

export function MSettingsRow(props: {
  title: ReactNode; sub?: ReactNode; trailing?: ReactNode; last?: boolean; onClick?: () => void;
  dataKey?: string;
}) {
  return (
    <div data-settings-row={props.dataKey} onClick={props.onClick}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px',
        borderBottom: props.last ? undefined : `1px solid ${MC.divider}`,
        cursor: props.onClick ? 'pointer' : undefined }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={MSET_TITLE}>{props.title}</div>
        {props.sub !== undefined && <div style={MSET_SUB}>{props.sub}</div>}
      </div>
      {props.trailing}
    </div>
  );
}

export function MSettingsToggle(props: { value: boolean; disabled?: boolean; label: string; onChange?: (value: boolean) => void }) {
  const active = !props.disabled && !!props.onChange;
  return (
    <button type="button" role="switch" aria-checked={props.value} aria-label={props.label}
      disabled={!active} onClick={() => { if (active) props.onChange?.(!props.value); }}
      style={{ width: 44, height: 26, border: 0, borderRadius: 999, padding: 2,
        background: props.value ? MC.done : 'var(--proto-line-3)', opacity: props.disabled ? 0.55 : 1,
        display: 'flex', justifyContent: props.value ? 'flex-end' : 'flex-start' }}>
      <span style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--ink-solid-bg)',
        boxShadow: 'var(--shadow-switch-thumb)' }} />
    </button>
  );
}

export function MSettingsButton(props: { children: ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button type="button" onClick={props.onClick} disabled={props.disabled}
      style={{ border: `1px solid ${props.danger ? MC.failBorder : MC.runBorder}`, borderRadius: 8,
        background: props.danger ? MC.failBg : MC.runBg, color: props.danger ? MC.fail : MC.run,
        fontSize: 11, fontWeight: 600, padding: '7px 10px', opacity: props.disabled ? 0.5 : 1 }}>
      {props.children}
    </button>
  );
}

const FIELD: CSSProperties = { width: '100%', boxSizing: 'border-box', border: `1px solid ${MC.hairline}`,
  borderRadius: 8, background: MC.card, color: MC.ink, padding: '9px 10px', font: `400 12px ${MONO}` };

interface MSettingsControlFeedback {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
}

export function MSettingsFeedback({ hint, error }: Omit<MSettingsControlFeedback, 'label'>) {
  const hasError = error !== undefined && error !== null;
  const copy = hasError ? error : hint;
  if (copy === undefined || copy === null) return null;
  return (
    <span
      data-settings-field-error={hasError || undefined}
      style={{ ...MSET_SUB, display: 'block', color: hasError ? MC.fail : MC.faint, marginTop: 4 }}
    >
      {copy}
    </span>
  );
}

export function MSettingsField(
  props: InputHTMLAttributes<HTMLInputElement> & MSettingsControlFeedback,
) {
  const { label, hint, error, ...input } = props;
  const hasError = error !== undefined && error !== null;
  return (
    <label style={{ display: 'block' }}>
      <span style={{ ...MSET_KEY, display: 'block', marginBottom: 4 }}>{label}</span>
      <input
        {...input}
        aria-invalid={input['aria-invalid'] ?? (hasError || undefined)}
        style={{ ...FIELD, borderColor: hasError ? MC.failBorder : undefined, ...input.style }}
      />
      <MSettingsFeedback hint={hint} error={error} />
    </label>
  );
}

export function MSettingsSelect(
  props: SelectHTMLAttributes<HTMLSelectElement> & MSettingsControlFeedback,
) {
  const { label, hint, error, children, ...select } = props;
  const hasError = error !== undefined && error !== null;
  return (
    <label style={{ display: 'block' }}>
      <span style={{ ...MSET_KEY, display: 'block', marginBottom: 4 }}>{label}</span>
      <select
        {...select}
        aria-invalid={select['aria-invalid'] ?? (hasError || undefined)}
        style={{ ...FIELD, borderColor: hasError ? MC.failBorder : undefined, ...select.style }}
      >
        {children}
      </select>
      <MSettingsFeedback hint={hint} error={error} />
    </label>
  );
}
