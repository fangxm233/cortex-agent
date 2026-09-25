// input:  runtime setting writer, config, settings atoms
// output: desktop notifications and advanced settings
// pos:    Runtime settings with readable keys and status history
// >>> Once updated, update this header and parent AGENTS.md <<<

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { ConfigSnapshot, ConfigSettingEntry, SystemNoticeEntry } from '@cortex-agent/ui-contract';
import { Select, relativeAge } from '@/design';
import { useVocab, type Vocab } from '@/i18n';
import { useNoticeHistory } from '@/features/notifications/useNoticeHistory';
import { PlatformAvatar, PresencePill } from './SettingsPanels';
import {
  ROW_STYLE,
  SButton,
  SDot,
  SPill,
  SRow,
  SRowGroup,
  SSection,
  S_CONTROL_STYLE,
  Toggle,
} from '@/features/settings/ui/settings-ui';
import { AppUpdateCard } from './AppUpdateCard';
import { UiSignOutCard } from './UiSignOutCard';
import {
  ADVANCED_FLAGS,
  ADVANCED_NUMBER_SETTINGS,
  BUILTIN_JOB_SETTINGS,
  NOTIFY_SETTINGS,
  durationDraftFromMs,
  durationDraftToMs,
  getSetting,
  hasAnyKey,
  indexEnv,
  indexSettings,
  numberSettingRangeLabel,
  numberSettingValid,
  parseWholeNumber,
  type BuiltinJobSettingDescriptor,
  type DurationDraft,
  type DurationUnit,
  type NumberSettingDescriptor,
  type SettingsIndex,
  type WritableBooleanSettingKey,
  type WritableSettingKey,
} from '@/features/settings/vm/platform-env';
import {
  useRuntimeSettingWrite,
  type RuntimeSettingWriter,
} from '@/features/settings/controllers/runtime-settings-writer';

type SettingSource = ConfigSettingEntry['source'];

const MONO = "'IBM Plex Mono',monospace";

// Which setting a row writes, and where its current value came from, is an identifier rather than
// prose: it gets its own mono line under the description instead of competing with the control.
const KEY_LINE_STYLE: CSSProperties = {
  font: `400 12px ${MONO}`, color: 'var(--proto-muted-2)', marginTop: 4, overflowWrap: 'anywhere',
};
const MONO_VALUE_STYLE: CSSProperties = {
  font: `400 12px ${MONO}`, color: 'var(--proto-muted-2)', minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere',
};
// Controls keep their compact widths, but wrap as a unit below the row's text when needed.
const CONTROL_STRIP_STYLE: CSSProperties = {
  display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, minWidth: 0, maxWidth: '100%',
};
const NUMBER_INPUT: CSSProperties = { ...S_CONTROL_STYLE, width: 96 };
const DURATION_INPUT: CSSProperties = { ...S_CONTROL_STYLE, width: 64 };
const DURATION_SELECT: CSSProperties = { ...S_CONTROL_STYLE, width: 78, cursor: 'pointer' };

const DURATION_UNITS = [
  { value: 'sec', label: 'sec' },
  { value: 'min', label: 'min' },
  { value: 'hr', label: 'hr' },
] satisfies Array<{ value: DurationUnit; label: string }>;

function KeyLine({ children }: { children: ReactNode }) {
  return <div style={KEY_LINE_STYLE}>{children}</div>;
}

export interface RuntimeSettingToggleRowProps {
  settingKey: WritableBooleanSettingKey;
  value: boolean;
  source: SettingSource | null;
  title: string;
  desc: string;
  pending: boolean;
  onToggle: (key: WritableBooleanSettingKey, nextValue: boolean) => void;
}

export function RuntimeSettingToggleRow(props: RuntimeSettingToggleRowProps) {
  const onClick = props.source && !props.pending
    ? () => props.onToggle(props.settingKey, !props.value)
    : undefined;
  return (
    <SRow
      data-setting-key={props.settingKey}
      data-setting-value={props.source ? String(props.value) : 'missing'}
      data-setting-source={props.source ?? 'missing'}
      title={props.title}
      desc={props.desc}
      control={<Toggle on={props.value} onClick={onClick} inert={!onClick} />}
    >
      <KeyLine>{`settings.${props.settingKey} · ${props.source ?? '—'}`}</KeyLine>
    </SRow>
  );
}

function notifyRows(args: {
  settings: SettingsIndex;
  pending: boolean;
  onToggle: RuntimeSettingToggleRowProps['onToggle'];
  threshold: number | undefined;
  L: Vocab;
}): ReactNode[] {
  return NOTIFY_SETTINGS.map((descriptor) => {
    const entry = getSetting(args.settings, descriptor.setting);
    const suffix = descriptor.setting === 'turnNotify' && args.threshold !== undefined
      ? ` · ${args.threshold}s`
      : '';
    return (
      <RuntimeSettingToggleRow
        key={descriptor.setting}
        settingKey={descriptor.setting}
        value={typeof entry?.value === 'boolean' ? entry.value : false}
        source={typeof entry?.value === 'boolean' ? entry.source : null}
        title={args.L[descriptor.titleKey]}
        desc={`${args.L[descriptor.descKey]}${suffix}`}
        pending={args.pending}
        onToggle={args.onToggle}
      />
    );
  });
}

function NotificationRouting({ snapshot, settings }: { snapshot: ConfigSnapshot; settings: SettingsIndex }) {
  const L = useVocab();
  const slackChannel = getSetting(settings, 'adminChannel')?.value;
  const feishuChannel = getSetting(settings, 'feishuAdminChannel')?.value;
  return (
    <SSection label={L.stNotifyRoutingTitle}
      action={<span style={MONO_VALUE_STYLE}>{L.stNotifyRoutingRight}</span>}>
      <SRowGroup>
        <RoutingRow
          platform="Slack"
          glyph="S"
          present={hasAnyKey(snapshot.env, 'SLACK_')}
          setting="adminChannel"
          channel={typeof slackChannel === 'string' ? slackChannel : null}
        />
        <RoutingRow
          platform="飞书"
          glyph="飞"
          present={hasAnyKey(snapshot.env, 'FEISHU_')}
          setting="feishuAdminChannel"
          channel={typeof feishuChannel === 'string' ? feishuChannel : null}
        />
      </SRowGroup>
    </SSection>
  );
}

function RoutingRow(props: {
  platform: string;
  glyph: string;
  present: boolean;
  setting: 'adminChannel' | 'feishuAdminChannel';
  channel: string | null;
}) {
  return (
    <SRow
      title={
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <PlatformAvatar glyph={props.glyph} />
          {props.platform}
          <PresencePill present={props.present} />
        </span>
      }
      control={
        <span style={MONO_VALUE_STYLE}>
          {`settings.${props.setting}: `}
          <span style={{ color: props.channel ? 'var(--proto-muted)' : 'var(--proto-faint)' }}>
            {props.channel ?? '—'}
          </span>
        </span>
      }
    />
  );
}

const NOTICE_LEVEL_COLOR: Record<SystemNoticeEntry['level'], string> = {
  info: 'var(--proto-accent)',
  warning: 'var(--proto-amber)',
  error: 'var(--pill-failed-fg)',
};

const NOTICE_BODY_STYLE: CSSProperties = {
  fontSize: 13, color: 'var(--proto-muted-2)', lineHeight: 1.55,
  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
};

function NoticeRow({ entry }: { entry: SystemNoticeEntry }) {
  return (
    <div style={{ ...ROW_STYLE, gap: 10, alignItems: 'flex-start' }}>
      <span style={{ display: 'flex', paddingTop: 5 }}>
        <SDot color={NOTICE_LEVEL_COLOR[entry.level]} size={7} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {entry.title ? (
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)' }}>{entry.title}</div>
        ) : null}
        <div style={{ ...NOTICE_BODY_STYLE, marginTop: entry.title ? 3 : 0 }}>{entry.text}</div>
      </div>
      <span style={{ ...MONO_VALUE_STYLE, color: 'var(--proto-muted-2)', paddingTop: 2 }}>
        {relativeAge(entry.ts)}
      </span>
    </div>
  );
}

function NoticeNote({ text }: { text: string }) {
  return (
    <div style={{ padding: '12px 16px', fontSize: 12, color: 'var(--proto-muted-3)' }}>{text}</div>
  );
}

/** The system notices the server actually broadcast (same stream the routing card fans out), read
 *  from its in-memory ring via `system.notices` and kept live by the `system.notice` event. */
function RecentNotifications() {
  const L = useVocab();
  const { entries, cap, loading, error } = useNoticeHistory();
  const right = cap > 0
    ? L.stRecentNotifRight.replace('{n}', String(cap))
    : L.stRecentNotifRightUnknown;
  return (
    <SSection label={L.stRecentNotifications} action={<span style={MONO_VALUE_STYLE}>{right}</span>}>
      <SRowGroup>
        {error ? <NoticeNote text={L.stRecentNotifError} /> : null}
        {!error && loading ? <NoticeNote text={L.stRecentNotifLoading} /> : null}
        {!error && !loading && entries.length === 0 ? <NoticeNote text={L.stRecentNotifEmpty} /> : null}
        {!error && entries.map((entry) => <NoticeRow key={entry.id} entry={entry} />)}
      </SRowGroup>
    </SSection>
  );
}

export function NotificationsPanelView({
  snapshot,
  pending,
  onToggle,
}: {
  snapshot: ConfigSnapshot;
  pending: boolean;
  onToggle: RuntimeSettingToggleRowProps['onToggle'];
}) {
  const L = useVocab();
  const settings = indexSettings(snapshot.settings);
  const thresholdEntry = getSetting(settings, 'turnNotifyThresholdS');
  const threshold = typeof thresholdEntry?.value === 'number' ? thresholdEntry.value : undefined;
  return (
    <>
      <SRowGroup>{notifyRows({ settings, pending, onToggle, threshold, L })}</SRowGroup>
      <NotificationRouting snapshot={snapshot} settings={settings} />
      <RecentNotifications />
    </>
  );
}

export function NotificationsPanel({ snapshot }: { snapshot: ConfigSnapshot }) {
  const write = useRuntimeSettingWrite();
  return <NotificationsPanelView snapshot={snapshot} pending={write.pending} onToggle={write.onToggle} />;
}

/** DEBUG is read from the process env, so the row reports presence instead of offering a control. */
function ReadOnlyEnvRow({ snapshot, title, desc }: {
  snapshot: ConfigSnapshot;
  title: string;
  desc: string;
}) {
  const L = useVocab();
  const present = indexEnv(snapshot.env).DEBUG?.present === true;
  return (
    <SRow
      data-env-key="DEBUG"
      data-env-present={String(present)}
      data-writable="false"
      title={title}
      desc={desc}
      control={<SPill tone="neutral" mono>{present ? L.stSet : '—'}</SPill>}
    >
      <KeyLine>DEBUG</KeyLine>
    </SRow>
  );
}

function advancedFlagRows(args: {
  snapshot: ConfigSnapshot;
  settings: SettingsIndex;
  pending: boolean;
  onToggle: RuntimeSettingToggleRowProps['onToggle'];
  L: Vocab;
}): ReactNode[] {
  return ADVANCED_FLAGS.map((flag) => {
    if (flag.kind === 'env') {
      return <ReadOnlyEnvRow key={flag.env} snapshot={args.snapshot}
        title={args.L[flag.titleKey]} desc={args.L[flag.descKey]} />;
    }
    const entry = getSetting(args.settings, flag.setting);
    return <RuntimeSettingToggleRow key={flag.setting} settingKey={flag.setting}
      value={typeof entry?.value === 'boolean' ? entry.value : false}
      source={typeof entry?.value === 'boolean' ? entry.source : null}
      title={args.L[flag.titleKey]} desc={args.L[flag.descKey]}
      pending={args.pending} onToggle={args.onToggle} />;
  });
}

function ConcurrencyRow({ settings }: { settings: SettingsIndex }) {
  const L = useVocab();
  const entry = getSetting(settings, 'taskDispatchMaxConcurrent');
  const value = typeof entry?.value === 'number' ? entry.value : entry?.value === null ? null : undefined;
  return (
    <SRow
      data-setting-key="taskDispatchMaxConcurrent"
      data-setting-value={value === undefined ? 'missing' : String(value)}
      title={L.advConc}
      desc={L.stAdvConcNote}
      control={
        <SPill tone="neutral" mono>
          {typeof value === 'number' ? value : value === null ? L.stAuto : '—'}
        </SPill>
      }
    >
      <KeyLine>{`settings.taskDispatchMaxConcurrent · ${entry?.source ?? '—'}`}</KeyLine>
    </SRow>
  );
}

function NumberControl(props: {
  descriptor: NumberSettingDescriptor;
  draft: string;
  canSave: boolean;
  withinRange: boolean;
  onDraft: (draft: string) => void;
  onSave: () => void;
}) {
  const L = useVocab();
  const invalidTitle = `${L[props.descriptor.invalidKey]} (${numberSettingRangeLabel(props.descriptor)})`;
  return (
    <div style={CONTROL_STRIP_STYLE}>
      <input
        data-number-input={props.descriptor.setting} type="number" step={1} value={props.draft}
        min={props.descriptor.zeroMeansOff ? 0 : props.descriptor.min} max={props.descriptor.max}
        style={NUMBER_INPUT} onChange={(event) => props.onDraft(event.target.value)}
      />
      <SButton tone="neutral" data-number-save={props.descriptor.setting} disabled={!props.canSave}
        title={props.withinRange ? undefined : invalidTitle} onClick={props.onSave}>
        {L.stBuiltinSave}
      </SButton>
    </div>
  );
}

function NumberSettingRow(props: {
  descriptor: NumberSettingDescriptor;
  settings: SettingsIndex;
  pending: boolean;
  onSet: RuntimeSettingWriter['onSet'];
}) {
  const L = useVocab();
  const entry = getSetting(props.settings, props.descriptor.setting);
  const current = typeof entry?.value === 'number' ? entry.value : null;
  const [draft, setDraft] = useState(() => (current === null ? '' : String(current)));
  useEffect(() => setDraft(current === null ? '' : String(current)), [current]);
  const nextValue = parseWholeNumber(draft);
  const withinRange = numberSettingValid(props.descriptor, nextValue);
  const canSave = current !== null && withinRange && nextValue !== current && !props.pending;
  return (
    <SRow
      data-setting-key={props.descriptor.setting}
      data-setting-value={current === null ? 'missing' : String(current)}
      data-setting-source={entry?.source ?? 'missing'}
      title={L[props.descriptor.titleKey]} desc={L[props.descriptor.descKey]}
      control={
        <NumberControl descriptor={props.descriptor} draft={draft} canSave={canSave}
          withinRange={withinRange} onDraft={setDraft}
          onSave={() => { if (withinRange) props.onSet(props.descriptor.setting, nextValue); }} />
      }
    >
      <KeyLine>{`settings.${props.descriptor.setting} · ${entry?.source ?? '—'}`}</KeyLine>
    </SRow>
  );
}

function DurationFields(props: {
  settingKey: WritableSettingKey;
  draft: DurationDraft;
  canSave: boolean;
  invalid: boolean;
  onDraft: (draft: DurationDraft) => void;
  onSave: () => void;
}) {
  const L = useVocab();
  return (
    <>
      <span style={MONO_VALUE_STYLE}>{L.stBuiltinInterval}</span>
      <input type="number" min={1} value={props.draft.value} style={DURATION_INPUT}
        onChange={(event) => props.onDraft({ ...props.draft, value: Number(event.target.value) })} />
      <Select popupClassName="settings-surface settings-select-popup"
        data-duration-unit={props.settingKey} aria-label={L.stBuiltinInterval} density="bare"
        value={props.draft.unit} options={DURATION_UNITS} style={DURATION_SELECT}
        onValueChange={(unit) => props.onDraft({ ...props.draft, unit })}
      />
      <SButton tone="neutral" disabled={!props.canSave}
        title={props.invalid ? L.stBuiltinInvalidInterval : undefined} onClick={props.onSave}>
        {L.stBuiltinSave}
      </SButton>
    </>
  );
}

function DurationControl(props: {
  descriptor: BuiltinJobSettingDescriptor;
  entry: ConfigSettingEntry | undefined;
  pending: boolean;
  onSet: RuntimeSettingWriter['onSet'];
}) {
  const currentMs = typeof props.entry?.value === 'number' ? props.entry.value : null;
  const [draft, setDraft] = useState<DurationDraft>(() => (
    currentMs === null ? { value: 0, unit: 'sec' } : durationDraftFromMs(currentMs)
  ));
  useEffect(() => {
    if (currentMs !== null) setDraft(durationDraftFromMs(currentMs));
  }, [currentMs]);
  const nextMs = durationDraftToMs(draft.value, draft.unit);
  const save = () => { if (nextMs !== null) props.onSet(props.descriptor.interval, nextMs); };
  const canSave = currentMs !== null && nextMs !== null && nextMs !== currentMs && !props.pending;
  return (
    <div data-setting-key={props.descriptor.interval}
      data-setting-value={currentMs === null ? 'missing' : String(currentMs)}
      style={CONTROL_STRIP_STYLE}>
      <DurationFields settingKey={props.descriptor.interval} draft={draft}
        canSave={canSave} invalid={nextMs === null} onDraft={setDraft} onSave={save} />
    </div>
  );
}

function BuiltinJobRow(props: {
  descriptor: BuiltinJobSettingDescriptor;
  settings: SettingsIndex;
  pending: boolean;
  onToggle: RuntimeSettingToggleRowProps['onToggle'];
  onSet: RuntimeSettingWriter['onSet'];
}) {
  const L = useVocab();
  const enabledEntry = getSetting(props.settings, props.descriptor.enabled);
  const intervalEntry = getSetting(props.settings, props.descriptor.interval);
  const enabled = typeof enabledEntry?.value === 'boolean' ? enabledEntry.value : false;
  const onClick = enabledEntry && !props.pending
    ? () => props.onToggle(props.descriptor.enabled, !enabled) : undefined;
  return (
    <SRow
      data-setting-key={props.descriptor.enabled}
      data-setting-value={enabledEntry ? String(enabled) : 'missing'}
      title={L[props.descriptor.titleKey]}
      desc={L[props.descriptor.descKey]}
      control={
        <div style={CONTROL_STRIP_STYLE}>
          <DurationControl descriptor={props.descriptor} entry={intervalEntry}
            pending={props.pending} onSet={props.onSet} />
          <Toggle on={enabled} onClick={onClick} inert={!onClick} />
        </div>
      }
    />
  );
}

function BuiltinJobsSection(props: {
  settings: SettingsIndex;
  pending: boolean;
  onToggle: RuntimeSettingToggleRowProps['onToggle'];
  onSet: RuntimeSettingWriter['onSet'];
}) {
  const L = useVocab();
  return (
    <SSection label={L.stBuiltinJobsTitle}>
      <SRowGroup>
        {BUILTIN_JOB_SETTINGS.map((descriptor) => (
          <BuiltinJobRow key={descriptor.enabled} descriptor={descriptor} settings={props.settings}
            pending={props.pending} onToggle={props.onToggle} onSet={props.onSet} />
        ))}
      </SRowGroup>
    </SSection>
  );
}

function GpuMockRow({ snapshot }: { snapshot: ConfigSnapshot }) {
  const L = useVocab();
  const present = indexEnv(snapshot.env).CORTEX_GPU_MONITOR_MOCK?.present === true;
  return (
    <SRow
      title={L.stGpuMock}
      desc={L.advMock}
      control={<SPill tone="neutral" mono>{present ? L.stSet : '—'}</SPill>}
    >
      <KeyLine>CORTEX_GPU_MONITOR_MOCK</KeyLine>
    </SRow>
  );
}

interface AdvancedPanelViewProps {
  snapshot: ConfigSnapshot;
  pending: boolean;
  onToggle: RuntimeSettingToggleRowProps['onToggle'];
  onSet: RuntimeSettingWriter['onSet'];
}

export function AdvancedPanelView({ snapshot, pending, onToggle, onSet }: AdvancedPanelViewProps) {
  const L = useVocab();
  const settings = indexSettings(snapshot.settings);
  return (
    <>
      <SRowGroup>
        {advancedFlagRows({ snapshot, settings, pending, onToggle, L })}
      </SRowGroup>
      <SRowGroup>
        {ADVANCED_NUMBER_SETTINGS.map((descriptor) => (
          <NumberSettingRow key={descriptor.setting} descriptor={descriptor} settings={settings}
            pending={pending} onSet={onSet} />
        ))}
        <ConcurrencyRow settings={settings} />
        <GpuMockRow snapshot={snapshot} />
      </SRowGroup>
      <BuiltinJobsSection settings={settings} pending={pending} onToggle={onToggle} onSet={onSet} />
      <AppUpdateCard />
      <UiSignOutCard />
    </>
  );
}

export function AdvancedPanel({ snapshot }: { snapshot: ConfigSnapshot }) {
  const write = useRuntimeSettingWrite();
  return <AdvancedPanelView snapshot={snapshot} pending={write.pending}
    onToggle={write.onToggle} onSet={write.onSet} />;
}
