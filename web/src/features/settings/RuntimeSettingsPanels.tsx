// input:  config snapshot/mutation, localized copy, settings primitives
// output: writable Notifications and Advanced desktop panels
// pos:    Runtime settings read/write surface for desktop settings
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useState, type CSSProperties } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ConfigSnapshot, ConfigSettingEntry } from '@cortex-agent/ui-contract';
import { useToast } from '@/design';
import { useVocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { PlatformAvatar, PresencePill } from './SettingsPanels';
import { SCard, SCardHeader, Toggle } from './settings-ui';
import {
  ADVANCED_FLAGS,
  NOTIFY_SETTINGS,
  getSetting,
  hasAnyKey,
  indexEnv,
  indexSettings,
  type SettingsIndex,
  type WritableSettingKey,
} from './platform-env';

export type { WritableSettingKey } from './platform-env';

type SettingsSetArgs = {
  section: 'settings';
  value: Partial<Record<WritableSettingKey, boolean>>;
};
type SettingSource = ConfigSettingEntry['source'];

export interface CommitSettingDeps {
  set: (args: SettingsSetArgs) => Promise<unknown>;
  refresh: () => Promise<unknown>;
  onError: (message: string) => void;
  onPending?: (pending: boolean) => void;
}

export async function commitSettingToggle(
  deps: CommitSettingDeps,
  key: WritableSettingKey,
  nextValue: boolean,
): Promise<void> {
  deps.onPending?.(true);
  try {
    await deps.set({ section: 'settings', value: { [key]: nextValue } });
    await deps.refresh();
  } catch (error) {
    deps.onError(error instanceof Error ? error.message : String(error));
  } finally {
    deps.onPending?.(false);
  }
}

const MONO = "'IBM Plex Mono',monospace";
const ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '10px 14px',
  borderBottom: '1px solid var(--proto-alt)',
};
const TITLE: CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--proto-ink)' };
const DESC: CSSProperties = { fontSize: 10.5, color: 'var(--proto-muted-2)', marginTop: 1 };
const KEY: CSSProperties = {
  font: `400 9px ${MONO}`,
  color: 'var(--proto-faint)',
  flex: 'none',
};

function useRuntimeSettingWrite(): {
  pending: boolean;
  onToggle: (key: WritableSettingKey, nextValue: boolean) => void;
} {
  const L = useVocab();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [committing, setCommitting] = useState(false);
  const mutation = useMutation(trpc.config.set.mutationOptions());
  const pending = committing || mutation.isPending;
  const onToggle = (key: WritableSettingKey, nextValue: boolean) => {
    if (pending) return;
    void commitSettingToggle({
      set: (args) => mutation.mutateAsync(args),
      refresh: () => queryClient.invalidateQueries(trpc.config.get.queryFilter({})),
      onError: (message) => toast({ title: `${L.stToastWriteFailed}: ${message}`, tone: 'failed' }),
      onPending: setCommitting,
    }, key, nextValue);
  };
  return { pending, onToggle };
}

export interface RuntimeSettingToggleRowProps {
  settingKey: WritableSettingKey;
  value: boolean;
  source: SettingSource | null;
  title: string;
  desc: string;
  pending: boolean;
  onToggle: (key: WritableSettingKey, nextValue: boolean) => void;
}

export function RuntimeSettingToggleRow(props: RuntimeSettingToggleRowProps) {
  const onClick = props.source && !props.pending
    ? () => props.onToggle(props.settingKey, !props.value)
    : undefined;
  return (
    <div
      data-setting-key={props.settingKey}
      data-setting-value={props.source ? String(props.value) : 'missing'}
      data-setting-source={props.source ?? 'missing'}
      style={ROW}
    >
      <Toggle on={props.value} onClick={onClick} inert={!onClick} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={TITLE}>{props.title}</div>
        <div style={DESC}>{props.desc}</div>
      </div>
      <span style={KEY}>{`settings.${props.settingKey} · ${props.source ?? '—'}`}</span>
    </div>
  );
}

function SettingsToggleList({
  descriptors,
  settings,
  pending,
  onToggle,
  threshold,
}: {
  descriptors: typeof NOTIFY_SETTINGS;
  settings: SettingsIndex;
  pending: boolean;
  onToggle: RuntimeSettingToggleRowProps['onToggle'];
  threshold?: number;
}) {
  const L = useVocab();
  return descriptors.map((descriptor) => {
    const entry = getSetting(settings, descriptor.setting);
    const value = typeof entry?.value === 'boolean' ? entry.value : false;
    const suffix = descriptor.setting === 'turnNotify' && threshold !== undefined ? ` · ${threshold}s` : '';
    return (
      <RuntimeSettingToggleRow
        key={descriptor.setting}
        settingKey={descriptor.setting}
        value={value}
        source={typeof entry?.value === 'boolean' ? entry.source : null}
        title={L[descriptor.titleKey]}
        desc={`${L[descriptor.descKey]}${suffix}`}
        pending={pending}
        onToggle={onToggle}
      />
    );
  });
}

function NotificationRouting({ snapshot, settings }: { snapshot: ConfigSnapshot; settings: SettingsIndex }) {
  const L = useVocab();
  const slackChannel = getSetting(settings, 'adminChannel')?.value;
  const feishuChannel = getSetting(settings, 'feishuAdminChannel')?.value;
  return (
    <SCard style={{ marginTop: 12 }}>
      <SCardHeader title={L.stNotifyRoutingTitle} right={L.stNotifyRoutingRight} />
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
        last
      />
    </SCard>
  );
}

function RoutingRow(props: {
  platform: string;
  glyph: string;
  present: boolean;
  setting: 'adminChannel' | 'feishuAdminChannel';
  channel: string | null;
  last?: boolean;
}) {
  return (
    <div style={{ ...ROW, gap: 10, borderBottom: props.last ? undefined : ROW.borderBottom }}>
      <PlatformAvatar glyph={props.glyph} />
      <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--proto-ink)' }}>{props.platform}</span>
      <PresencePill present={props.present} />
      <span style={{ marginLeft: 'auto', font: `400 9.5px ${MONO}`, color: 'var(--proto-muted-2)' }}>
        {`settings.${props.setting}: `}
        <span style={{ color: props.channel ? 'var(--proto-muted)' : 'var(--proto-faint)' }}>
          {props.channel ?? '—'}
        </span>
      </span>
    </div>
  );
}

function ApprovalReminder() {
  const L = useVocab();
  return (
    <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px',
      background: 'var(--proto-amber-bg)', border: '1px solid var(--proto-amber-border)',
      borderRadius: 9, maxWidth: 760, boxSizing: 'border-box' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--proto-amber)', flex: 'none' }} />
      <span style={{ fontSize: 10.5, color: 'var(--proto-amber-fg)' }}>{L.stApprovalReminderNote}</span>
    </div>
  );
}

function RecentNotifications() {
  const L = useVocab();
  return (
    <SCard style={{ marginTop: 12, maxWidth: 760 }}>
      <SCardHeader title={L.stRecentNotifications} right={L.stRecentNotifRight} />
      <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--proto-line-3)',
          flex: 'none', marginTop: 5 }} />
        <span style={{ fontSize: 10.5, color: 'var(--proto-muted-3)', lineHeight: 1.6 }}>
          {L.stRecentNotifNote}
        </span>
      </div>
    </SCard>
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
  const settings = indexSettings(snapshot.settings);
  const thresholdEntry = getSetting(settings, 'turnNotifyThresholdS');
  const threshold = typeof thresholdEntry?.value === 'number' ? thresholdEntry.value : undefined;
  return (
    <>
      <SCard><SettingsToggleList descriptors={NOTIFY_SETTINGS} settings={settings} pending={pending}
        onToggle={onToggle} threshold={threshold} /></SCard>
      <NotificationRouting snapshot={snapshot} settings={settings} />
      <ApprovalReminder />
      <RecentNotifications />
    </>
  );
}

export function NotificationsPanel({ snapshot }: { snapshot: ConfigSnapshot }) {
  const write = useRuntimeSettingWrite();
  return <NotificationsPanelView snapshot={snapshot} pending={write.pending} onToggle={write.onToggle} />;
}

function ReadOnlyEnvToggleRow({ snapshot, title, desc }: {
  snapshot: ConfigSnapshot;
  title: string;
  desc: string;
}) {
  const present = indexEnv(snapshot.env).DEBUG?.present === true;
  return (
    <div data-env-key="DEBUG" data-env-present={String(present)} data-writable="false" style={ROW}>
      <Toggle on={present} inert />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={TITLE}>{title}</div>
        <div style={DESC}>{desc}</div>
      </div>
      <span style={KEY}>DEBUG</span>
    </div>
  );
}

function AdvancedToggleList(props: {
  snapshot: ConfigSnapshot;
  settings: SettingsIndex;
  pending: boolean;
  onToggle: RuntimeSettingToggleRowProps['onToggle'];
}) {
  const L = useVocab();
  return ADVANCED_FLAGS.map((flag) => {
    if (flag.kind === 'env') {
      return <ReadOnlyEnvToggleRow key={flag.env} snapshot={props.snapshot}
        title={L[flag.titleKey]} desc={L[flag.descKey]} />;
    }
    const entry = getSetting(props.settings, flag.setting);
    return <RuntimeSettingToggleRow key={flag.setting} settingKey={flag.setting}
      value={typeof entry?.value === 'boolean' ? entry.value : false}
      source={typeof entry?.value === 'boolean' ? entry.source : null}
      title={L[flag.titleKey]} desc={L[flag.descKey]} pending={props.pending} onToggle={props.onToggle} />;
  });
}

function ConcurrencyRow({ settings }: { settings: SettingsIndex }) {
  const L = useVocab();
  const entry = getSetting(settings, 'taskDispatchMaxConcurrent');
  const value = typeof entry?.value === 'number' ? entry.value : entry?.value === null ? null : undefined;
  return (
    <div data-setting-key="taskDispatchMaxConcurrent" data-setting-value={value === undefined ? 'missing' : String(value)} style={ROW}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={TITLE}>{L.advConc}</div>
        <div style={DESC}>{L.stAdvConcNote}</div>
      </div>
      <span style={{ font: `500 10.5px ${MONO}`, color: value === undefined ? 'var(--proto-faint)' : 'var(--proto-ink)',
        border: '1px solid var(--proto-line)', borderRadius: 7, padding: '4px 11px' }}>
        {typeof value === 'number' ? value : value === null ? L.stAuto : '—'}
      </span>
      <span style={KEY}>{`settings.taskDispatchMaxConcurrent · ${entry?.source ?? '—'}`}</span>
    </div>
  );
}

function GpuMockRow({ snapshot }: { snapshot: ConfigSnapshot }) {
  const L = useVocab();
  const present = indexEnv(snapshot.env).CORTEX_GPU_MONITOR_MOCK?.present === true;
  return (
    <div style={{ ...ROW, borderBottom: undefined }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={TITLE}>{L.stGpuMock}</div>
        <div style={DESC}>{L.advMock}</div>
      </div>
      <span style={{ font: `400 10.5px ${MONO}`, color: 'var(--proto-faint)',
        border: '1px dashed var(--proto-line-3)', borderRadius: 7, padding: '4px 11px' }}>
        {present ? L.stSet : '—'}
      </span>
      <span style={KEY}>CORTEX_GPU_MONITOR_MOCK</span>
    </div>
  );
}

export function AdvancedPanelView({
  snapshot,
  pending,
  onToggle,
}: {
  snapshot: ConfigSnapshot;
  pending: boolean;
  onToggle: RuntimeSettingToggleRowProps['onToggle'];
}) {
  const settings = indexSettings(snapshot.settings);
  return (
    <SCard style={{ marginTop: 12, maxWidth: 760 }}>
      <AdvancedToggleList snapshot={snapshot} settings={settings} pending={pending} onToggle={onToggle} />
      <ConcurrencyRow settings={settings} />
      <GpuMockRow snapshot={snapshot} />
    </SCard>
  );
}

export function AdvancedPanel({ snapshot }: { snapshot: ConfigSnapshot }) {
  const write = useRuntimeSettingWrite();
  return <AdvancedPanelView snapshot={snapshot} pending={write.pending} onToggle={write.onToggle} />;
}
