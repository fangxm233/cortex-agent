import type { ComponentProps, CSSProperties, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { MCard, MBottomSheet, MC } from '@/mobile/ui/kit';
import { useVocab, useVocabOptional } from '@/i18n';
import type { SettingsQuery } from '@/features/settings/controllers/useConfigSnapshot';
import '@/features/settings/ui/settings-style.css';
import './mobile-settings.css';

export function MSettingsFrame(props: { label?: string; header?: ReactNode; children: ReactNode }) {
  return <div className="settings-surface mobile-settings mobile-settings-frame" data-screen-label={props.label}>
    {props.header}
    <div className="mobile-settings-scroll">{props.children}</div>
  </div>;
}

export function MSettingsHeader(props: { onBack: () => void; trailing?: ReactNode; children: ReactNode }) {
  const vocab = useVocabOptional();
  return <header className="mobile-settings-header">
    <button type="button" aria-label={vocab.back} onClick={props.onBack} className="mobile-settings-back">‹</button>
    <div className="mobile-settings-heading">{props.children}</div>
    {props.trailing && <div className="mobile-settings-header-actions">{props.trailing}</div>}
  </header>;
}

export function MSettingsBody({ children }: { children: ReactNode }) {
  return <div className="mobile-settings-body">{children}</div>;
}

export function MSettingsGroupLabel({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 13, fontWeight: 600, color: MC.muted }}>{children}</div>;
}

export function MSettingsSurfaceCard(props: ComponentProps<typeof MCard>) {
  return <MCard {...props} radius={12} style={{ ...props.style, overflow: 'visible' }} />;
}

export function MSettingsSheet(props: ComponentProps<typeof MBottomSheet>) {
  return <MBottomSheet {...props} className="settings-surface mobile-settings mobile-settings-sheet" />;
}

export const MSET_TITLE: CSSProperties = { fontSize: 13, fontWeight: 600, color: MC.ink };
export const MSET_SUB: CSSProperties = { fontSize: 12, color: MC.muted, lineHeight: 1.5, marginTop: 4 };
export const MSET_KEY: CSSProperties = { fontSize: 13, fontWeight: 500, color: MC.muted };

export function MSettingsPage(props: { title: string; onBack: () => void; children: ReactNode; trailing?: ReactNode }) {
  return (
    <MSettingsFrame label={`Settings · ${props.title}`} header={
      <MSettingsHeader onBack={props.onBack} trailing={props.trailing}>
        <span>{props.title}</span>
      </MSettingsHeader>
    }>
      <MSettingsBody>{props.children}</MSettingsBody>
    </MSettingsFrame>
  );
}

/** A settings page whose content waits on one read: loading, failed (with the server's message), or
 *  rendered from the data. `lead` is shown above it in every state. */
export function MSettingsQueryPage<T>(props: {
  title: string;
  onBack: () => void;
  query: SettingsQuery<T>;
  children: (data: T) => ReactNode;
  lead?: ReactNode;
  trailing?: ReactNode;
  loadingText?: string;
  errorText?: string;
}) {
  const L = useVocab();
  const { query } = props;
  let content: ReactNode;
  if (query.isLoading) {
    content = <MSettingsCard><div data-settings-loading style={{ padding: 13, color: MC.muted }}>
      {props.loadingText ?? L.stLoadingConfig}
    </div></MSettingsCard>;
  } else if (query.isError || query.data === undefined) {
    content = <MSettingsCard><div data-settings-load-error style={{ padding: 13, color: MC.fail, overflowWrap: 'anywhere' }}>
      {props.errorText ?? L.stFailedLoadConfig} {query.error?.message}
    </div></MSettingsCard>;
  } else {
    content = props.children(query.data);
  }
  return <MSettingsPage title={props.title} onBack={props.onBack} trailing={props.trailing}>
    {props.lead}
    {content}
  </MSettingsPage>;
}

export function MSettingsCard(props: { children: ReactNode; title?: string; note?: string }) {
  return (
    <div>
      {props.title && <div style={{ ...MSET_KEY, padding: '0 2px 5px', fontWeight: 700 }}>{props.title}</div>}
      <MSettingsSurfaceCard padding={0}>{props.children}</MSettingsSurfaceCard>
      {props.note && <div style={{ ...MSET_SUB, padding: '6px 3px 0' }}>{props.note}</div>}
    </div>
  );
}

export function MSettingsRow(props: {
  title: ReactNode; sub?: ReactNode; trailing?: ReactNode; last?: boolean; onClick?: () => void;
  dataKey?: string; stacked?: boolean;
}) {
  return (
    <div data-settings-row={props.dataKey} onClick={props.onClick}
      className={props.stacked ? 'mobile-settings-row mobile-settings-row-stacked' : 'mobile-settings-row'}
      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px',
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
      className="mobile-settings-toggle">
      <span aria-hidden="true" className="mobile-settings-toggle-track"><span /></span>
    </button>
  );
}

const FIELD: CSSProperties = { width: '100%', boxSizing: 'border-box', border: `1px solid ${MC.hairline}`,
  borderRadius: 8, minHeight: 44, background: 'var(--material-inset-bg)', color: MC.ink, padding: '8px 12px', fontSize: 16, fontFamily: 'inherit' };

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
