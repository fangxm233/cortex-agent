// input:  config snapshot, runtime descriptors and config.set writer
// output: writable mobile Notifications and Advanced settings screens
// pos:    Mobile runtime settings query and view container
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ConfigSettingEntry, ConfigSnapshot } from '@cortex-agent/ui-contract';
import { useVocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { MC } from '@/mobile/ui/kit';
import {
  ADVANCED_FLAGS, ADVANCED_NUMBER_SETTINGS, BUILTIN_JOB_SETTINGS, NOTIFY_SETTINGS,
  MAX_SESSION_RETENTION_DAYS, durationDraftFromMs, durationDraftToMs, getSetting,
  hasAnyKey, indexEnv, indexSettings, type BuiltinJobSettingDescriptor,
  type SettingToggleDescriptor, type SettingsIndex,
} from '@/features/settings/platform-env';
import { useRuntimeSettingWrite } from '@/features/settings/RuntimeSettingsPanels';
import {
  MSET_KEY, MSettingsButton, MSettingsCard, MSettingsField, MSettingsPage,
  MSettingsRow, MSettingsSelect, MSettingsToggle,
} from './MSettingsControls';

function ToggleRow(props: {
  descriptor: SettingToggleDescriptor; settings: SettingsIndex; pending: boolean;
  onToggle: ReturnType<typeof useRuntimeSettingWrite>['onToggle'];
}) {
  const L = useVocab();
  const entry = getSetting(props.settings, props.descriptor.setting);
  const value = typeof entry?.value === 'boolean' ? entry.value : false;
  return <MSettingsRow dataKey={props.descriptor.setting} title={L[props.descriptor.titleKey]}
    sub={`${L[props.descriptor.descKey]} · ${entry?.source ?? '—'}`}
    trailing={<MSettingsToggle value={value} label={L[props.descriptor.titleKey]}
      disabled={!entry || props.pending} onChange={(next) => props.onToggle(props.descriptor.setting, next)} />} />;
}

function NotificationsContent(props: { snapshot: ConfigSnapshot; write: ReturnType<typeof useRuntimeSettingWrite> }) {
  const L = useVocab();
  const settings = indexSettings(props.snapshot.settings);
  const slack = getSetting(settings, 'adminChannel')?.value;
  const feishu = getSetting(settings, 'feishuAdminChannel')?.value;
  return <>
    <MSettingsCard>{NOTIFY_SETTINGS.map((descriptor) => <ToggleRow key={descriptor.setting}
      descriptor={descriptor} settings={settings} pending={props.write.pending} onToggle={props.write.onToggle} />)}</MSettingsCard>
    <MSettingsCard title={L.stNotifyRoutingTitle}>
      <MSettingsRow title="Slack" sub={hasAnyKey(props.snapshot.env, 'SLACK_') ? String(slack ?? '—') : '—'} />
      <MSettingsRow title="飞书" sub={hasAnyKey(props.snapshot.env, 'FEISHU_') ? String(feishu ?? '—') : '—'} last />
    </MSettingsCard>
  </>;
}

function EnvFlagRow({ snapshot }: { snapshot: ConfigSnapshot }) {
  const L = useVocab();
  const flag = ADVANCED_FLAGS[0];
  const value = indexEnv(snapshot.env).DEBUG?.present === true;
  return <MSettingsRow title={L[flag.titleKey]} sub={`${L[flag.descKey]} · DEBUG`}
    trailing={<MSettingsToggle value={value} label={L[flag.titleKey]} disabled />} />;
}

function NumberSettingRow(props: { settings: SettingsIndex; write: ReturnType<typeof useRuntimeSettingWrite> }) {
  const L = useVocab();
  const descriptor = ADVANCED_NUMBER_SETTINGS[0];
  const entry = getSetting(props.settings, descriptor.setting);
  const current = typeof entry?.value === 'number' ? entry.value : null;
  const [draft, setDraft] = useState(current === null ? '' : String(current));
  useEffect(() => setDraft(current === null ? '' : String(current)), [current]);
  const value = /^\d+$/.test(draft) ? Number(draft) : null;
  const valid = value !== null && value >= 1 && value <= MAX_SESSION_RETENTION_DAYS;
  return <MSettingsRow title={L[descriptor.titleKey]} sub={L[descriptor.descKey]} trailing={
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', width: 132 }}>
      <input type="number" value={draft} onChange={(event) => setDraft(event.target.value)}
        style={{ width: 56, minWidth: 0 }} />
      <MSettingsButton disabled={current === null || !valid || value === current || props.write.pending}
        onClick={() => { if (valid) props.write.onSet(descriptor.setting, value); }}>{L.stBuiltinSave}</MSettingsButton>
    </div>} />;
}

function AdvancedReadOnly(props: { snapshot: ConfigSnapshot; settings: SettingsIndex }) {
  const L = useVocab();
  const concurrencyEntry = getSetting(props.settings, 'taskDispatchMaxConcurrent');
  const concurrency = concurrencyEntry?.value;
  const gpuMock = indexEnv(props.snapshot.env).CORTEX_GPU_MONITOR_MOCK?.present === true;
  const concurrencyLabel = !concurrencyEntry ? '—' : typeof concurrency === 'number' ? concurrency : L.stAuto;
  return <>
    <MSettingsRow title={L.advConc} sub={L.stAdvConcNote}
      trailing={<span style={MSET_KEY}>{concurrencyLabel}</span>} />
    <MSettingsRow title={L.stGpuMock} sub={L.advMock} last
      trailing={<span style={MSET_KEY}>{gpuMock ? L.stSet : '—'}</span>} />
  </>;
}

function AdvancedFlags(props: { snapshot: ConfigSnapshot; write: ReturnType<typeof useRuntimeSettingWrite> }) {
  const settings = indexSettings(props.snapshot.settings);
  return <MSettingsCard>
    <EnvFlagRow snapshot={props.snapshot} />
    {ADVANCED_FLAGS.slice(1).map((flag) => flag.kind === 'setting' && <ToggleRow key={flag.setting}
      descriptor={flag} settings={settings} pending={props.write.pending} onToggle={props.write.onToggle} />)}
    <NumberSettingRow settings={settings} write={props.write} />
    <AdvancedReadOnly snapshot={props.snapshot} settings={settings} />
  </MSettingsCard>;
}

function JobInterval(props: {
  descriptor: BuiltinJobSettingDescriptor; entry: ConfigSettingEntry | undefined;
  write: ReturnType<typeof useRuntimeSettingWrite>;
}) {
  const L = useVocab();
  const current = typeof props.entry?.value === 'number' ? props.entry.value : null;
  const initial = current === null ? { value: 1, unit: 'min' as const } : durationDraftFromMs(current);
  const [draft, setDraft] = useState(initial);
  useEffect(() => { if (current !== null) setDraft(durationDraftFromMs(current)); }, [current]);
  const next = durationDraftToMs(draft.value, draft.unit);
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 82px', gap: 7, padding: '0 13px 11px' }}>
    <MSettingsField label={L.stBuiltinInterval} type="number" min={1} value={draft.value}
      onChange={(event) => setDraft({ ...draft, value: Number(event.target.value) })} />
    <MSettingsSelect label="Unit" value={draft.unit}
      onChange={(event) => setDraft({ ...draft, unit: event.target.value as typeof draft.unit })}>
      <option value="sec">sec</option><option value="min">min</option><option value="hr">hr</option>
    </MSettingsSelect>
    <div style={{ gridColumn: '1 / -1' }}><MSettingsButton
      disabled={current === null || next === null || next === current || props.write.pending}
      onClick={() => { if (next !== null) props.write.onSet(props.descriptor.interval, next); }}>
      {L.stBuiltinSave}
    </MSettingsButton></div>
  </div>;
}

function JobRow(props: { descriptor: BuiltinJobSettingDescriptor; settings: SettingsIndex; write: ReturnType<typeof useRuntimeSettingWrite> }) {
  const L = useVocab();
  const enabled = getSetting(props.settings, props.descriptor.enabled);
  const interval = getSetting(props.settings, props.descriptor.interval);
  const value = typeof enabled?.value === 'boolean' ? enabled.value : false;
  return <div style={{ borderBottom: '1px solid var(--m-divider)' }}>
    <MSettingsRow title={L[props.descriptor.titleKey]} sub={L[props.descriptor.descKey]} last
      trailing={<MSettingsToggle value={value} label={L[props.descriptor.titleKey]}
        disabled={!enabled || props.write.pending}
        onChange={(next) => props.write.onToggle(props.descriptor.enabled, next)} />} />
    <JobInterval descriptor={props.descriptor} entry={interval} write={props.write} />
  </div>;
}

function AdvancedContent(props: { snapshot: ConfigSnapshot; write: ReturnType<typeof useRuntimeSettingWrite> }) {
  const L = useVocab();
  const settings = indexSettings(props.snapshot.settings);
  return <>
    <AdvancedFlags snapshot={props.snapshot} write={props.write} />
    <MSettingsCard title={L.stBuiltinJobsTitle}>
      {BUILTIN_JOB_SETTINGS.map((descriptor) => <JobRow key={descriptor.enabled}
        descriptor={descriptor} settings={settings} write={props.write} />)}
    </MSettingsCard>
    <div style={MSET_KEY}>settings · config.set</div>
  </>;
}

function RuntimeScreen({ kind }: { kind: 'notifications' | 'advanced' }) {
  const trpc = useTRPC();
  const L = useVocab();
  const navigate = useNavigate();
  const query = useQuery(trpc.config.get.queryOptions({}));
  const write = useRuntimeSettingWrite();
  const title = kind === 'notifications' ? L.stNavNotifications : L.stNavAdvanced;
  if (query.isLoading) return <MSettingsPage title={title} onBack={() => navigate('/m/settings')}>
    <MSettingsCard><div style={{ padding: 13 }}>{L.stLoadingConfig}</div></MSettingsCard>
  </MSettingsPage>;
  if (query.isError || !query.data) return <MSettingsPage title={title} onBack={() => navigate('/m/settings')}>
    <MSettingsCard><div style={{ padding: 13, color: MC.fail }}>{L.stFailedLoadConfig}</div></MSettingsCard>
  </MSettingsPage>;
  return <MSettingsPage title={title} onBack={() => navigate('/m/settings')}>
    {kind === 'notifications'
      ? <NotificationsContent snapshot={query.data} write={write} />
      : <AdvancedContent snapshot={query.data} write={write} />}
  </MSettingsPage>;
}

export function MNotificationsScreen() { return <RuntimeScreen kind="notifications" />; }
export function MAdvancedScreen() { return <RuntimeScreen kind="advanced" />; }
