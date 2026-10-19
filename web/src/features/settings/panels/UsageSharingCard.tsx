import { useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { useVocab, type Vocab } from '@/i18n';
import {
  SButton, SDot, SFieldRow, SNotice, SSection, S_CONTROL_STYLE, Toggle,
} from '@/features/settings/ui/settings-ui';
import {
  LEADERBOARD_URL, type UsageSharingController, type UsageSharingField, type UsageSharingIssue,
} from '@/features/settings/vm/usage-sharing-vm';

/** `setup` sits among the setup page's cards; `settings` is a section of the Settings panel. */
export type UsageSharingVariant = 'setup' | 'settings';

const NOTE: CSSProperties = { fontSize: 12, lineHeight: 1.6, color: 'var(--proto-muted)', margin: 0 };
const LINK: CSSProperties = { color: 'var(--proto-accent)', whiteSpace: 'nowrap' };
const ISSUE_TEXT: Record<UsageSharingIssue, keyof Vocab> = {
  'name-required': 'usageShareNameRequired', 'email-invalid': 'usageShareEmailInvalid',
};
const FIELDS: { field: UsageSharingField; label: keyof Vocab; issue?: UsageSharingIssue; placeholder?: keyof Vocab; type: string }[] = [
  { field: 'name', label: 'usageShareName', issue: 'name-required', type: 'text' },
  { field: 'org', label: 'usageShareOrg', placeholder: 'usageShareOptional', type: 'text' },
  { field: 'email', label: 'usageShareEmail', issue: 'email-invalid', placeholder: 'usageShareEmailPlaceholder', type: 'email' },
];

function SharingToggle({ controller }: { controller: UsageSharingController }) {
  const L = useVocab(), s = controller.state;
  return <Toggle on={s.draft.enabled} ariaLabel={L.usageShareTitle}
    onClick={s.saving ? undefined : () => controller.setEnabled(!s.draft.enabled)} />;
}

function SharingFields({ controller }: { controller: UsageSharingController }) {
  const L = useVocab(), s = controller.state;
  const issues = controller.issues();
  return <div data-usage-sharing-fields>
    {FIELDS.map(({ field, label, issue, placeholder, type }) => {
      const hint = issue && issues.includes(issue) ? L[ISSUE_TEXT[issue]] : undefined;
      return <SFieldRow key={field} label={L[label]} hint={hint} hintTone="danger">
        <input data-usage-sharing-field={field} type={type} aria-label={L[label]} aria-invalid={hint !== undefined}
          style={S_CONTROL_STYLE} value={s.draft[field]} disabled={s.saving}
          placeholder={placeholder ? L[placeholder] : undefined}
          onChange={event => controller.setField(field, event.target.value)} />
      </SFieldRow>;
    })}
  </div>;
}

function SharingActions({ controller }: { controller: UsageSharingController }) {
  const L = useVocab(), s = controller.state;
  const pending = controller.dirty() || s.saving;
  if (!pending && !s.justSaved) return null;
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
    {s.saveError ? <span role="alert" style={{ ...NOTE, color: 'var(--proto-danger)', overflowWrap: 'anywhere' }}>
      {L.usageShareSaveFailed}: {s.saveError}</span> : null}
    {s.justSaved ? <span role="status" style={{ ...NOTE, color: 'var(--proto-accent)' }}>{L.usageShareSaved}</span> : null}
    {pending ? <SButton tone="primary" data-usage-sharing-save disabled={s.saving} onClick={() => void controller.save()}>
      {s.saving ? L.usageShareSaving : L.usageShareSave}</SButton> : null}
  </div>;
}

function SharingBody({ controller }: { controller: UsageSharingController }) {
  const L = useVocab();
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <p style={NOTE}>{L.usageShareDescription}{' '}
      <a href={LEADERBOARD_URL} target="_blank" rel="noreferrer" style={LINK}>{L.usageShareLink}</a></p>
    {controller.state.draft.enabled ? <SharingFields controller={controller} /> : null}
    <SharingActions controller={controller} />
  </div>;
}

interface FrameProps { toggle: ReactNode; children: ReactNode }

function SetupFrame({ toggle, children }: FrameProps) {
  const L = useVocab();
  return <section className="setup-card" data-usage-sharing="setup">
    <div className="setup-card-header"><h2>{L.usageShareTitle}</h2><span className="setup-pill">{L.setupOptional}</span>
      <span style={{ marginLeft: 'auto', display: 'flex' }}>{toggle}</span></div>
    <div className="setup-card-body">{children}</div>
  </section>;
}

function SettingsFrame({ toggle, children }: FrameProps) {
  const L = useVocab();
  return <div data-usage-sharing="settings">
    <SSection label={L.usageShareTitle} action={toggle}>{children}</SSection>
  </div>;
}

const FRAMES: Record<UsageSharingVariant, typeof SetupFrame> = { setup: SetupFrame, settings: SettingsFrame };

function LoadFailure({ controller, variant }: { controller: UsageSharingController; variant: UsageSharingVariant }) {
  const L = useVocab();
  // The setup page stays quiet: the card is optional there, and Settings offers it again later.
  if (variant === 'setup' || !controller.state.loadError) return null;
  return <SNotice tone="danger" icon={<SDot color="var(--proto-danger)" size={6} />}>
    {L.usageShareLoadFailed}: {controller.state.loadError}</SNotice>;
}

/** The opt-in for the public aistatus.cc leaderboard: a toggle, the identity it shows, and Save. */
export function UsageSharingCard({ controller, variant }: { controller: UsageSharingController; variant: UsageSharingVariant }) {
  useSyncExternalStore(controller.subscribe, controller.snapshot);
  if (!controller.state.saved) return <LoadFailure controller={controller} variant={variant} />;
  const Frame = FRAMES[variant];
  return <Frame toggle={<SharingToggle controller={controller} />}><SharingBody controller={controller} /></Frame>;
}
