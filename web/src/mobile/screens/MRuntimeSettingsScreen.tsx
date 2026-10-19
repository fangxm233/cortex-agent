import { mobileHeaderBack } from '@/mobile/mobile-navigation';
import { useEffect, useState } from 'react';
import { LocalNotificationsCard } from '@/features/settings/panels/LocalNotificationsCard';
import { useNavigate } from 'react-router-dom';
import type { ConfigSettingEntry, ConfigSnapshot, SystemNoticeEntry } from '@cortex-agent/ui-contract';
import { relativeAge } from '@/design';
import { useLang, useVocab } from '@/i18n';
import { MButton, MC } from '@/mobile/ui/kit';
import {
  noticeHistoryCaption, noticeHistoryNote, useNoticeHistory,
} from '@/features/notifications/useNoticeHistory';
import { useConfigSnapshot } from '@/features/settings/controllers/useConfigSnapshot';
import { useUiSignOut } from '@/features/settings/controllers/useUiSignOut';
import { MNativeNotificationsCard } from './MNativeNotificationsCard';
import {
  ADVANCED_FLAGS, ADVANCED_NUMBER_SETTINGS, BUILTIN_JOB_SETTINGS, NOTIFY_SETTINGS,
  durationDraftFromMs, durationDraftToMs, durationUnits, numberSettingLoaded, parseNumberSettingDraft,
  hasAnyKey, indexEnv, indexSettings, type AdvancedFlag,
  type BuiltinJobSettingDescriptor, type NumberSettingDescriptor,
  type SettingToggleDescriptor, type SettingsIndex,
} from '@/features/settings/vm/platform-env';
import {
  useRuntimeSettingWrite,
  type RuntimeSettingWriter,
} from '@/features/settings/controllers/runtime-settings-writer';
import {
  MSET_INSET, MSET_KEY, MSET_SUB, MSET_TITLE, MSettingsField, MSettingsQueryPage,
  MSettingsRow, MSettingsSection, MSettingsSelect, MSettingsToggle,
} from './MSettingsControls';

function ToggleRow(props: {
  descriptor: SettingToggleDescriptor; settings: SettingsIndex; pending: boolean;
  onToggle: RuntimeSettingWriter['onToggle']; descSuffix?: string;
}) {
  const L = useVocab();
  const entry = props.settings[props.descriptor.setting];
  const value = typeof entry?.value === 'boolean' ? entry.value : false;
  const descKey = props.descriptor.descKey;
  return <MSettingsRow dataKey={props.descriptor.setting} title={L[props.descriptor.titleKey]}
    sub={descKey && `${L[descKey]}${props.descSuffix ?? ''}`}
    trailing={<MSettingsToggle value={value} label={L[props.descriptor.titleKey]}
      disabled={!entry || props.pending} onChange={(next) => props.onToggle(props.descriptor.setting, next)} />} />;
}

const NOTICE_COLOR: Record<SystemNoticeEntry['level'], string> = {
  info: MC.run, warning: MC.amber, error: MC.fail,
};

function NoticeRow({ entry }: { entry: SystemNoticeEntry }) {
  const lang = useLang();
  return <div data-notice-row={entry.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: `12px ${MSET_INSET}px` }}>
    <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', flex: 'none', marginTop: 5,
      background: NOTICE_COLOR[entry.level] }} />
    <div style={{ minWidth: 0, flex: 1 }}>
      {entry.title && <div style={MSET_TITLE}>{entry.title}</div>}
      <div style={{ ...MSET_SUB, marginTop: entry.title ? 4 : 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {entry.text}
      </div>
    </div>
    <span style={{ fontSize: 12, color: MC.faint, flex: 'none' }}>{relativeAge(entry.ts, lang)}</span>
  </div>;
}

/** The system notices the server broadcast, from the same history the desktop panel reads. */
function RecentNotificationsCard() {
  const L = useVocab();
  const history = useNoticeHistory();
  const note = noticeHistoryNote(L, history);
  return <MSettingsSection title={L.stRecentNotifications} note={noticeHistoryCaption(L, history)}>
    {note !== null
      ? <div style={{ ...MSET_SUB, marginTop: 0, padding: `12px ${MSET_INSET}px` }}>{note}</div>
      : history.entries.map((entry) => <NoticeRow key={entry.id} entry={entry} />)}
  </MSettingsSection>;
}

function NotificationsContent(props: { snapshot: ConfigSnapshot; write: RuntimeSettingWriter }) {
  const L = useVocab();
  const settings = indexSettings(props.snapshot.settings);
  const slack = settings.adminChannel?.value;
  const feishu = settings.feishuAdminChannel?.value;
  const threshold = settings.turnNotifyThresholdS?.value;
  const thresholdSuffix = typeof threshold === 'number' ? ` ${threshold}s` : undefined;
  return <>
    <MSettingsSection>{NOTIFY_SETTINGS.map((descriptor) => <ToggleRow key={descriptor.setting}
      descriptor={descriptor} settings={settings} pending={props.write.pending} onToggle={props.write.onToggle}
      descSuffix={descriptor.setting === 'turnNotify' ? thresholdSuffix : undefined} />)}</MSettingsSection>
    <MSettingsSection title={L.stNotifyRoutingTitle}>
      <MSettingsRow title="Slack" sub={hasAnyKey(props.snapshot.env, 'SLACK_') ? String(slack ?? '—') : '—'} />
      <MSettingsRow title={L.psFeishu} sub={hasAnyKey(props.snapshot.env, 'FEISHU_') ? String(feishu ?? '—') : '—'} />
    </MSettingsSection>
    <RecentNotificationsCard />
  </>;
}

function EnvFlagRow(props: {
  descriptor: Extract<AdvancedFlag, { kind: 'env' }>;
  snapshot: ConfigSnapshot;
}) {
  const L = useVocab();
  const entry = indexEnv(props.snapshot.env)[props.descriptor.env];
  const value = entry?.enabled ?? entry?.present === true;
  return <MSettingsRow dataKey={props.descriptor.env} title={L[props.descriptor.titleKey]}
    trailing={<MSettingsToggle value={value} label={L[props.descriptor.titleKey]} disabled />} />;
}

function NumberSettingRow(props: {
  descriptor: NumberSettingDescriptor;
  settings: SettingsIndex;
  write: RuntimeSettingWriter;
}) {
  const L = useVocab();
  const entry = props.settings[props.descriptor.setting];
  const current = typeof entry?.value === 'number' ? entry.value : null;
  const [draft, setDraft] = useState(current === null ? '' : String(current));
  useEffect(() => setDraft(current === null ? '' : String(current)), [current]);
  const next = parseNumberSettingDraft(props.descriptor, draft);
  const canSave = numberSettingLoaded(props.descriptor, entry) && next.valid
    && next.value !== current && !props.write.pending;
  const placeholderKey = props.descriptor.nullable?.placeholderKey;
  return <MSettingsRow dataKey={props.descriptor.setting} title={L[props.descriptor.titleKey]}
    sub={props.descriptor.descKey && L[props.descriptor.descKey]} trailing={
    <div className="mobile-settings-number-control">
      <input type="number" aria-label={L[props.descriptor.titleKey]} value={draft} onChange={(event) => setDraft(event.target.value)}
        min={props.descriptor.min} max={props.descriptor.max}
        placeholder={placeholderKey ? L[placeholderKey] : undefined}
        step={1} />
      <MButton compact variant="outline" disabled={!canSave}
        onClick={() => { if (next.valid) props.write.onSet(props.descriptor.setting, next.value); }}>{L.stBuiltinSave}</MButton>
    </div>} />;
}

function AdvancedReadOnly(props: { snapshot: ConfigSnapshot }) {
  const L = useVocab();
  const gpuMock = indexEnv(props.snapshot.env).CORTEX_GPU_MONITOR_MOCK?.present === true;
  return <MSettingsRow title={L.stGpuMock}
    trailing={<span style={MSET_KEY}>{gpuMock ? L.stSet : '—'}</span>} />;
}

function AdvancedFlags(props: { snapshot: ConfigSnapshot; write: RuntimeSettingWriter }) {
  const settings = indexSettings(props.snapshot.settings);
  return <MSettingsSection>
    {ADVANCED_FLAGS.map((flag) => flag.kind === 'env'
      ? <EnvFlagRow key={`env:${flag.env}`} descriptor={flag} snapshot={props.snapshot} />
      : <ToggleRow key={flag.setting} descriptor={flag} settings={settings}
          pending={props.write.pending} onToggle={props.write.onToggle} />)}
    {ADVANCED_NUMBER_SETTINGS.map((descriptor) => <NumberSettingRow key={descriptor.setting}
      descriptor={descriptor} settings={settings} write={props.write} />)}
    <AdvancedReadOnly snapshot={props.snapshot} />
  </MSettingsSection>;
}

function JobInterval(props: {
  descriptor: BuiltinJobSettingDescriptor; entry: ConfigSettingEntry | undefined;
  write: RuntimeSettingWriter;
}) {
  const L = useVocab();
  const current = typeof props.entry?.value === 'number' ? props.entry.value : null;
  const initial = current === null ? { value: 1, unit: 'min' as const } : durationDraftFromMs(current);
  const [draft, setDraft] = useState(initial);
  useEffect(() => { if (current !== null) setDraft(durationDraftFromMs(current)); }, [current]);
  const next = durationDraftToMs(draft.value, draft.unit);
  return <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 90px', gap: 7, padding: `0 ${MSET_INSET}px 11px` }}>
    <MSettingsField label={L.stBuiltinInterval} type="number" min={1} value={draft.value}
      onChange={(event) => setDraft({ ...draft, value: Number(event.target.value) })} />
    <MSettingsSelect label={L.setUnitLabel} value={draft.unit}
      onChange={(event) => setDraft({ ...draft, unit: event.target.value as typeof draft.unit })}>
      {durationUnits(L).map((unit) => <option key={unit.value} value={unit.value}>{unit.label}</option>)}
    </MSettingsSelect>
    <div style={{ gridColumn: '1 / -1' }}><MButton compact variant="outline"
      disabled={current === null || next === null || next === current || props.write.pending}
      onClick={() => { if (next !== null) props.write.onSet(props.descriptor.interval, next); }}>
      {L.stBuiltinSave}
    </MButton></div>
  </div>;
}

function JobRow(props: { descriptor: BuiltinJobSettingDescriptor; settings: SettingsIndex; write: RuntimeSettingWriter }) {
  const L = useVocab();
  const enabled = props.settings[props.descriptor.enabled];
  const interval = props.settings[props.descriptor.interval];
  const value = typeof enabled?.value === 'boolean' ? enabled.value : false;
  return <div>
    <MSettingsRow title={L[props.descriptor.titleKey]}
      trailing={<MSettingsToggle value={value} label={L[props.descriptor.titleKey]}
        disabled={!enabled || props.write.pending}
        onChange={(next) => props.write.onToggle(props.descriptor.enabled, next)} />} />
    <JobInterval descriptor={props.descriptor} entry={interval} write={props.write} />
  </div>;
}

/** Shown only where desktop shows it: a plain browser signed in with the UI token. */
function SignOutCard() {
  const L = useVocab();
  const { offered, signOut } = useUiSignOut();
  if (!offered) return null;
  return <div style={{ padding: `0 ${MSET_INSET}px` }}>
    <MButton variant="danger-outline" data-ui-sign-out style={{ width: '100%' }}
      onClick={() => void signOut()}>{L.uiLogoutAction}</MButton>
  </div>;
}

function AdvancedContent(props: { snapshot: ConfigSnapshot; write: RuntimeSettingWriter }) {
  const L = useVocab();
  const settings = indexSettings(props.snapshot.settings);
  return <>
    <AdvancedFlags snapshot={props.snapshot} write={props.write} />
    <MSettingsSection title={L.stBuiltinJobsTitle}>
      {BUILTIN_JOB_SETTINGS.map((descriptor) => <JobRow key={descriptor.enabled}
        descriptor={descriptor} settings={settings} write={props.write} />)}
    </MSettingsSection>
    <SignOutCard />
  </>;
}

function RuntimeScreen({ kind }: { kind: 'notifications' | 'advanced' }) {
  const L = useVocab();
  const navigate = useNavigate();
  const config = useConfigSnapshot();
  const write = useRuntimeSettingWrite();
  const title = kind === 'notifications' ? L.stNavNotifications : L.stNavAdvanced;
  // The device cards work without the server's config, so they stay usable when it fails to load.
  const lead = kind === 'notifications' ? <><MNativeNotificationsCard /><LocalNotificationsCard /></> : undefined;
  return <MSettingsQueryPage title={title} onBack={() => mobileHeaderBack(navigate, '/m/settings')} query={config} lead={lead}>
    {(snapshot) => kind === 'notifications'
      ? <NotificationsContent snapshot={snapshot} write={write} />
      : <AdvancedContent snapshot={snapshot} write={write} />}
  </MSettingsQueryPage>;
}

export function MNotificationsScreen() { return <RuntimeScreen kind="notifications" />; }
export function MAdvancedScreen() { return <RuntimeScreen kind="advanced" />; }
