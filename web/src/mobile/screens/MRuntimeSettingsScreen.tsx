import { useEffect, useState } from 'react';
import { LocalNotificationsCard } from '@/features/settings/panels/LocalNotificationsCard';
import { useNavigate } from 'react-router-dom';
import type { ConfigSettingEntry, ConfigSnapshot } from '@cortex-agent/ui-contract';
import { useVocab } from '@/i18n';
import { MButton } from '@/mobile/ui/kit';
import { useConfigSnapshot } from '@/features/settings/controllers/useConfigSnapshot';
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
  MSET_KEY, MSettingsCard, MSettingsField, MSettingsQueryPage,
  MSettingsRow, MSettingsSelect, MSettingsToggle,
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

function NotificationsContent(props: { snapshot: ConfigSnapshot; write: RuntimeSettingWriter }) {
  const L = useVocab();
  const settings = indexSettings(props.snapshot.settings);
  const slack = settings.adminChannel?.value;
  const feishu = settings.feishuAdminChannel?.value;
  const threshold = settings.turnNotifyThresholdS?.value;
  const thresholdSuffix = typeof threshold === 'number' ? ` ${threshold}s` : undefined;
  return <>
    <MSettingsCard>{NOTIFY_SETTINGS.map((descriptor) => <ToggleRow key={descriptor.setting}
      descriptor={descriptor} settings={settings} pending={props.write.pending} onToggle={props.write.onToggle}
      descSuffix={descriptor.setting === 'turnNotify' ? thresholdSuffix : undefined} />)}</MSettingsCard>
    <MSettingsCard title={L.stNotifyRoutingTitle}>
      <MSettingsRow title="Slack" sub={hasAnyKey(props.snapshot.env, 'SLACK_') ? String(slack ?? '—') : '—'} />
      <MSettingsRow title={L.psFeishu} sub={hasAnyKey(props.snapshot.env, 'FEISHU_') ? String(feishu ?? '—') : '—'} last />
    </MSettingsCard>
  </>;
}

function EnvFlagRow(props: {
  descriptor: Extract<AdvancedFlag, { kind: 'env' }>;
  snapshot: ConfigSnapshot;
}) {
  const L = useVocab();
  const value = indexEnv(props.snapshot.env)[props.descriptor.env]?.present === true;
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
      <MButton compact variant="accent-outline" disabled={!canSave}
        onClick={() => { if (next.valid) props.write.onSet(props.descriptor.setting, next.value); }}>{L.stBuiltinSave}</MButton>
    </div>} />;
}

function AdvancedReadOnly(props: { snapshot: ConfigSnapshot }) {
  const L = useVocab();
  const gpuMock = indexEnv(props.snapshot.env).CORTEX_GPU_MONITOR_MOCK?.present === true;
  return <MSettingsRow title={L.stGpuMock} last
    trailing={<span style={MSET_KEY}>{gpuMock ? L.stSet : '—'}</span>} />;
}

function AdvancedFlags(props: { snapshot: ConfigSnapshot; write: RuntimeSettingWriter }) {
  const settings = indexSettings(props.snapshot.settings);
  return <MSettingsCard>
    {ADVANCED_FLAGS.map((flag) => flag.kind === 'env'
      ? <EnvFlagRow key={`env:${flag.env}`} descriptor={flag} snapshot={props.snapshot} />
      : <ToggleRow key={flag.setting} descriptor={flag} settings={settings}
          pending={props.write.pending} onToggle={props.write.onToggle} />)}
    {ADVANCED_NUMBER_SETTINGS.map((descriptor) => <NumberSettingRow key={descriptor.setting}
      descriptor={descriptor} settings={settings} write={props.write} />)}
    <AdvancedReadOnly snapshot={props.snapshot} />
  </MSettingsCard>;
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
  return <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 90px', gap: 7, padding: '0 13px 11px' }}>
    <MSettingsField label={L.stBuiltinInterval} type="number" min={1} value={draft.value}
      onChange={(event) => setDraft({ ...draft, value: Number(event.target.value) })} />
    <MSettingsSelect label={L.setUnitLabel} value={draft.unit}
      onChange={(event) => setDraft({ ...draft, unit: event.target.value as typeof draft.unit })}>
      {durationUnits(L).map((unit) => <option key={unit.value} value={unit.value}>{unit.label}</option>)}
    </MSettingsSelect>
    <div style={{ gridColumn: '1 / -1' }}><MButton compact variant="accent-outline"
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
  return <div style={{ borderBottom: '1px solid var(--m-divider)' }}>
    <MSettingsRow title={L[props.descriptor.titleKey]} last
      trailing={<MSettingsToggle value={value} label={L[props.descriptor.titleKey]}
        disabled={!enabled || props.write.pending}
        onChange={(next) => props.write.onToggle(props.descriptor.enabled, next)} />} />
    <JobInterval descriptor={props.descriptor} entry={interval} write={props.write} />
  </div>;
}

function AdvancedContent(props: { snapshot: ConfigSnapshot; write: RuntimeSettingWriter }) {
  const L = useVocab();
  const settings = indexSettings(props.snapshot.settings);
  return <>
    <AdvancedFlags snapshot={props.snapshot} write={props.write} />
    <MSettingsCard title={L.stBuiltinJobsTitle}>
      {BUILTIN_JOB_SETTINGS.map((descriptor) => <JobRow key={descriptor.enabled}
        descriptor={descriptor} settings={settings} write={props.write} />)}
    </MSettingsCard>
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
  return <MSettingsQueryPage title={title} onBack={() => navigate('/m/settings')} query={config} lead={lead}>
    {(snapshot) => kind === 'notifications'
      ? <NotificationsContent snapshot={snapshot} write={write} />
      : <AdvancedContent snapshot={snapshot} write={write} />}
  </MSettingsQueryPage>;
}

export function MNotificationsScreen() { return <RuntimeScreen kind="notifications" />; }
export function MAdvancedScreen() { return <RuntimeScreen kind="advanced" />; }
