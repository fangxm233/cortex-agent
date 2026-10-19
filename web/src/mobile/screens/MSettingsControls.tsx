import type { ComponentProps, CSSProperties, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { MBackChevron, MBottomSheet, MC, MCard, MGroup, MGroupLabel } from '@/mobile/ui/kit';
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
    <button type="button" aria-label={vocab.back} onClick={props.onBack} className="mobile-settings-back"><MBackChevron /></button>
    <div className="mobile-settings-heading">{props.children}</div>
    {props.trailing && <div className="mobile-settings-header-actions">{props.trailing}</div>}
  </header>;
}

export function MSettingsBody({ children }: { children: ReactNode }) {
  return <div className="mobile-settings-body">{children}</div>;
}

/** Row text, section labels and dividers share one x: the body gutter plus this inset. */
export const MSET_INSET = 12;

export function MSettingsGroupLabel({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return <MGroupLabel style={{ fontSize: 13, padding: `0 ${MSET_INSET}px 6px`, display: 'flex', alignItems: 'center', gap: 8 }}>
    {children}
    {trailing && <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>{trailing}</span>}
  </MGroupLabel>;
}

/** A run of settings rows laid straight on the mesh: an optional label, rows split by inset hairlines. */
export function MSettingsGroup({ children, inset = MSET_INSET }: { children: ReactNode; inset?: number }) {
  return <MGroup inset={inset}>{children}</MGroup>;
}

export function MSettingsSurfaceCard(props: ComponentProps<typeof MCard>) {
  return <MCard {...props} radius={12} style={{ ...props.style, overflow: 'visible' }} />;
}

export function MSettingsCard(props: { children: ReactNode; title?: ReactNode; note?: string }) {
  return (
    <div>
      {props.title && <div style={{ ...MSET_KEY, padding: '0 2px 5px', fontWeight: 600 }}>{props.title}</div>}
      <MSettingsSurfaceCard padding={0}>{props.children}</MSettingsSurfaceCard>
      {props.note && <div style={{ ...MSET_SUB, padding: '6px 3px 0' }}>{props.note}</div>}
    </div>
  );
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
    content = <div data-settings-loading style={{ ...STATE_LINE, color: MC.muted }}>
      {props.loadingText ?? L.stLoadingConfig}
    </div>;
  } else if (query.isError || query.data === undefined) {
    content = <div data-settings-load-error style={{ ...STATE_LINE, color: MC.fail }}>
      {props.errorText ?? L.stFailedLoadConfig} {query.error?.message}
    </div>;
  } else {
    content = props.children(query.data);
  }
  return <MSettingsPage title={props.title} onBack={props.onBack} trailing={props.trailing}>
    {props.lead}
    {content}
  </MSettingsPage>;
}

const STATE_LINE: CSSProperties = { padding: `0 ${MSET_INSET}px`, overflowWrap: 'anywhere' };

export function MSettingsSection(props: { children: ReactNode; title?: ReactNode; trailing?: ReactNode; note?: string }) {
  return (
    <section data-settings-section="">
      {props.title && <MSettingsGroupLabel trailing={props.trailing}>{props.title}</MSettingsGroupLabel>}
      <MSettingsGroup>{props.children}</MSettingsGroup>
      {props.note && <div style={{ ...MSET_SUB, padding: `4px ${MSET_INSET}px 0` }}>{props.note}</div>}
    </section>
  );
}

export function MSettingsRow(props: {
  title: ReactNode; sub?: ReactNode; trailing?: ReactNode; onClick?: () => void;
  dataKey?: string; stacked?: boolean;
}) {
  return (
    <div data-settings-row={props.dataKey} onClick={props.onClick}
      className={props.stacked ? 'mobile-settings-row mobile-settings-row-stacked' : 'mobile-settings-row'}
      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: `12px ${MSET_INSET}px`,
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
