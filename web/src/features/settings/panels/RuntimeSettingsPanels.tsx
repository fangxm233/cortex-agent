import { Fragment, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { LocalNotificationsCard } from './LocalNotificationsCard';
import type { ConfigSnapshot, ConfigSettingEntry, SystemNoticeEntry } from '@cortex-agent/ui-contract';
import { Select, relativeAge } from '@/design';
import { useLang, useVocab, type Vocab } from '@/i18n';
import {
  noticeHistoryCaption, noticeHistoryNote, useNoticeHistory,
} from '@/features/notifications/useNoticeHistory';
import { PresenceStatus } from './SettingsPanels';
import {
  ROW_STYLE,
  SButton,
  SDot,
  SMeta,
  SRow,
  SRowGroup,
  SSection,
  S_CONTROL_STYLE,
  Toggle,
} from '@/features/settings/ui/settings-ui';
import { AppUpdateRow, useAppUpdateController } from './AppUpdateCard';
import { AutostartRow } from './AutostartCard';
import { UninstallRow, useUninstallController } from './UninstallCard';
import { UiSignOutRow } from './UiSignOutCard';
import { StopServerRow } from './StopServerCard';
import { useAutostartController } from '@/features/settings/controllers/useAutostartController';
import { useLocalServerController } from '@/features/settings/controllers/useLocalServerController';
import { useUiSignOut } from '@/features/settings/controllers/useUiSignOut';
import {
  ADVANCED_SECTIONS,
  advancedToggleState,
  envFlagOn,
  visibleAdvancedRows,
  type AdvancedEnvRow,
  type AdvancedRow,
  type AdvancedSection,
  type AdvancedToggleRow,
} from '@/features/settings/vm/advanced-sections';
import {
  NOTIFY_SETTINGS,
  durationDraftFromMs,
  durationDraftToMs,
  durationUnits,
  hasAnyKey,
  indexEnv,
  indexSettings,
  numberSettingLoaded,
  numberSettingRangeLabel,
  parseNumberSettingDraft,
  type BuiltinJobSettingDescriptor,
  type DurationDraft,
  type EnvIndex,
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

// Captions, ages and interval words are UI face with tabular figures; only a literal id (a channel
// id) is set in the code face where it appears.
const VALUE_STYLE: CSSProperties = {
  fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'var(--proto-muted-2)', minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere',
};
// Controls keep their compact widths, but wrap as a unit below the row's text when needed.
const CONTROL_STRIP_STYLE: CSSProperties = {
  display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, minWidth: 0, maxWidth: '100%',
};
const NUMBER_INPUT: CSSProperties = { ...S_CONTROL_STYLE, width: 96 };
const DURATION_INPUT: CSSProperties = { ...S_CONTROL_STYLE, width: 64 };
const DURATION_SELECT: CSSProperties = { ...S_CONTROL_STYLE, width: 78, cursor: 'pointer' };

export interface RuntimeSettingToggleRowProps {
  settingKey: WritableBooleanSettingKey;
  value: boolean;
  source: SettingSource | null;
  title: string;
  desc?: string;
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
    />
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
    const entry = args.settings[descriptor.setting];
    const suffix = descriptor.setting === 'turnNotify' && args.threshold !== undefined
      ? ` ${args.threshold}s`
      : '';
    return (
      <RuntimeSettingToggleRow
        key={descriptor.setting}
        settingKey={descriptor.setting}
        value={typeof entry?.value === 'boolean' ? entry.value : false}
        source={typeof entry?.value === 'boolean' ? entry.source : null}
        title={args.L[descriptor.titleKey]}
        desc={descriptor.descKey && `${args.L[descriptor.descKey]}${suffix}`}
        pending={args.pending}
        onToggle={args.onToggle}
      />
    );
  });
}

function NotificationRouting({ snapshot, settings }: { snapshot: ConfigSnapshot; settings: SettingsIndex }) {
  const L = useVocab();
  const slackChannel = settings.adminChannel?.value;
  const feishuChannel = settings.feishuAdminChannel?.value;
  return (
    <SSection label={L.stNotifyRoutingTitle}
      action={<span style={VALUE_STYLE}>{L.stNotifyRoutingRight}</span>}>
      <SRowGroup>
        <RoutingRow
          platform="Slack"
          present={hasAnyKey(snapshot.env, 'SLACK_')}
          channel={typeof slackChannel === 'string' ? slackChannel : null}
        />
        <RoutingRow
          platform={L.setFeishu}
          present={hasAnyKey(snapshot.env, 'FEISHU_')}
          channel={typeof feishuChannel === 'string' ? feishuChannel : null}
        />
      </SRowGroup>
    </SSection>
  );
}

function RoutingRow(props: {
  platform: string;
  present: boolean;
  channel: string | null;
}) {
  return (
    <SRow
      title={
        <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          {props.platform}
          <PresenceStatus present={props.present} />
        </span>
      }
      control={
        <span style={VALUE_STYLE}>
          <span style={{ color: props.channel ? 'var(--proto-muted)' : 'var(--proto-faint)', fontFamily: props.channel ? MONO : undefined }}>
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
  const lang = useLang();
  return (
    <div style={{ ...ROW_STYLE, alignItems: 'flex-start' }}>
      <span style={{ width: 16, flex: 'none', display: 'flex', justifyContent: 'center', paddingTop: 7 }}>
        <SDot color={NOTICE_LEVEL_COLOR[entry.level]} size={7} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {entry.title ? (
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)' }}>{entry.title}</div>
        ) : null}
        <div style={{ ...NOTICE_BODY_STYLE, marginTop: entry.title ? 3 : 0 }}>{entry.text}</div>
      </div>
      <span style={{ ...VALUE_STYLE, color: 'var(--proto-muted-2)', paddingTop: 2 }}>
        {relativeAge(entry.ts, lang)}
      </span>
    </div>
  );
}

function NoticeNote({ text }: { text: string }) {
  return <div style={{ fontSize: 13, color: 'var(--proto-muted-2)' }}>{text}</div>;
}

/** The system notices the server actually broadcast (same stream the routing card fans out), read
 *  from its in-memory ring via `system.notices` and kept live by the `system.notice` event. */
function RecentNotifications() {
  const L = useVocab();
  const history = useNoticeHistory();
  const note = noticeHistoryNote(L, history);
  return (
    <SSection label={L.stRecentNotifications}
      action={<span style={VALUE_STYLE}>{noticeHistoryCaption(L, history)}</span>}>
      {note !== null
        ? <NoticeNote text={note} />
        : <SRowGroup>{history.entries.map((entry) => <NoticeRow key={entry.id} entry={entry} />)}</SRowGroup>}
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
  const thresholdEntry = settings.turnNotifyThresholdS;
  const threshold = typeof thresholdEntry?.value === 'number' ? thresholdEntry.value : undefined;
  return (
    <>
      <LocalNotificationsCard />
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

/** A flag set in the server's environment: its state is shown, it is changed outside Cortex. */
function EnvFlagRow({ row, env }: { row: AdvancedEnvRow; env: EnvIndex }) {
  const L = useVocab();
  const on = envFlagOn(env[row.env]);
  return (
    <SRow
      data-env-key={row.env}
      data-env-present={String(on)}
      data-writable="false"
      title={L[row.titleKey]}
      control={<SMeta>{on ? L.stSet : '—'}</SMeta>}
    />
  );
}

function AdvancedToggle({ row, settings, pending, onToggle }: {
  row: AdvancedToggleRow;
  settings: SettingsIndex;
  pending: boolean;
  onToggle: RuntimeSettingToggleRowProps['onToggle'];
}) {
  const L = useVocab();
  const entry = settings[row.setting];
  const state = advancedToggleState(row, settings);
  const onClick = state.editable && !pending ? () => onToggle(row.setting, state.next) : undefined;
  return (
    <SRow
      data-setting-key={row.setting}
      data-setting-value={entry ? String(entry.value) : 'missing'}
      data-setting-source={entry?.source ?? 'missing'}
      title={L[row.titleKey]}
      desc={row.descKey && L[row.descKey]}
      control={<Toggle on={state.on} onClick={onClick} inert={!onClick} ariaLabel={L[row.titleKey]} />}
    />
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
  const placeholderKey = props.descriptor.nullable?.placeholderKey;
  return (
    <div style={CONTROL_STRIP_STYLE}>
      <input
        data-number-input={props.descriptor.setting} type="number" step={1} value={props.draft}
        min={props.descriptor.min} max={props.descriptor.max}
        placeholder={placeholderKey ? L[placeholderKey] : undefined}
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
  const entry = props.settings[props.descriptor.setting];
  const current = typeof entry?.value === 'number' ? entry.value : null;
  const [draft, setDraft] = useState(() => (current === null ? '' : String(current)));
  useEffect(() => setDraft(current === null ? '' : String(current)), [current]);
  const next = parseNumberSettingDraft(props.descriptor, draft);
  const canSave = numberSettingLoaded(props.descriptor, entry) && next.valid
    && next.value !== current && !props.pending;
  return (
    <SRow
      data-setting-key={props.descriptor.setting}
      data-setting-value={entry === undefined ? 'missing' : String(entry.value)}
      data-setting-source={entry?.source ?? 'missing'}
      title={L[props.descriptor.titleKey]}
      desc={props.descriptor.descKey && L[props.descriptor.descKey]}
      control={
        <NumberControl descriptor={props.descriptor} draft={draft} canSave={canSave}
          withinRange={next.valid} onDraft={setDraft}
          onSave={() => { if (next.valid) props.onSet(props.descriptor.setting, next.value); }} />
      }
    />
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
      <span style={VALUE_STYLE}>{L.stBuiltinInterval}</span>
      <input type="number" min={1} value={props.draft.value} style={DURATION_INPUT}
        onChange={(event) => props.onDraft({ ...props.draft, value: Number(event.target.value) })} />
      <Select popupClassName="settings-surface settings-select-popup"
        data-duration-unit={props.settingKey} aria-label={L.stBuiltinInterval} density="bare"
        value={props.draft.unit} options={durationUnits(L)} style={DURATION_SELECT}
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
  const enabledEntry = props.settings[props.descriptor.enabled];
  const intervalEntry = props.settings[props.descriptor.interval];
  const enabled = typeof enabledEntry?.value === 'boolean' ? enabledEntry.value : false;
  const onClick = enabledEntry && !props.pending
    ? () => props.onToggle(props.descriptor.enabled, !enabled) : undefined;
  return (
    <SRow
      data-setting-key={props.descriptor.enabled}
      data-setting-value={enabledEntry ? String(enabled) : 'missing'}
      title={L[props.descriptor.titleKey]}
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

interface AdvancedRowContext {
  settings: SettingsIndex;
  env: EnvIndex;
  pending: boolean;
  onToggle: RuntimeSettingToggleRowProps['onToggle'];
  onSet: RuntimeSettingWriter['onSet'];
}

type AdvancedRowView<K extends AdvancedRow['kind']> = (
  row: Extract<AdvancedRow, { kind: K }>, ctx: AdvancedRowContext,
) => ReactNode;

const ADVANCED_ROW_VIEWS: { [K in AdvancedRow['kind']]: AdvancedRowView<K> } = {
  toggle: (row, ctx) => <AdvancedToggle key={row.setting} row={row} settings={ctx.settings}
    pending={ctx.pending} onToggle={ctx.onToggle} />,
  env: (row, ctx) => <EnvFlagRow key={row.env} row={row} env={ctx.env} />,
  number: (row, ctx) => <NumberSettingRow key={row.descriptor.setting} descriptor={row.descriptor}
    settings={ctx.settings} pending={ctx.pending} onSet={ctx.onSet} />,
  job: (row, ctx) => <BuiltinJobRow key={row.descriptor.enabled} descriptor={row.descriptor}
    settings={ctx.settings} pending={ctx.pending} onToggle={ctx.onToggle} onSet={ctx.onSet} />,
};

function renderAdvancedRow(row: AdvancedRow, ctx: AdvancedRowContext): ReactNode {
  return (ADVANCED_ROW_VIEWS[row.kind] as AdvancedRowView<AdvancedRow['kind']>)(row, ctx);
}

function AdvancedSectionView({ section, ctx, extra }: {
  section: AdvancedSection;
  ctx: AdvancedRowContext;
  /** A row this section lists on some clients only, already known to be shown. */
  extra?: ReactNode;
}) {
  const L = useVocab();
  return (
    <SSection label={L[section.titleKey]} data-advanced-section={section.key}>
      <SRowGroup>
        {visibleAdvancedRows(section, ctx.env).map((row) => renderAdvancedRow(row, ctx))}
        {extra}
      </SRowGroup>
    </SSection>
  );
}

/** Actions that belong to this app or browser rather than the server; the section hides when none apply. */
function DeviceSection() {
  const L = useVocab();
  const autostart = useAutostartController();
  const signOut = useUiSignOut();
  const uninstall = useUninstallController();
  const server = useLocalServerController();
  const rows = [
    { key: 'autostart', shown: autostart.state !== null, node: <AutostartRow controller={autostart} /> },
    { key: 'stop-server', shown: server.offered, node: <StopServerRow controller={server} /> },
    { key: 'sign-out', shown: signOut.offered, node: <UiSignOutRow controller={signOut} /> },
    { key: 'uninstall', shown: uninstall.offered, node: <UninstallRow controller={uninstall} /> },
  ].filter((row) => row.shown);
  if (rows.length === 0) return null;
  return (
    <SSection label={L.stAdvSecDevice} data-advanced-section="device">
      <SRowGroup>{rows.map((row) => <Fragment key={row.key}>{row.node}</Fragment>)}</SRowGroup>
    </SSection>
  );
}

interface AdvancedPanelViewProps {
  snapshot: ConfigSnapshot;
  pending: boolean;
  onToggle: RuntimeSettingToggleRowProps['onToggle'];
  onSet: RuntimeSettingWriter['onSet'];
}

export function AdvancedPanelView({ snapshot, pending, onToggle, onSet }: AdvancedPanelViewProps) {
  const appUpdate = useAppUpdateController();
  const ctx: AdvancedRowContext = {
    settings: indexSettings(snapshot.settings), env: indexEnv(snapshot.env), pending, onToggle, onSet,
  };
  const appUpdateRow = appUpdate.prefs ? <AppUpdateRow controller={appUpdate} /> : null;
  return (
    <>
      {ADVANCED_SECTIONS.map((section) => (
        <AdvancedSectionView key={section.key} section={section} ctx={ctx}
          extra={section.key === 'updates' ? appUpdateRow : null} />
      ))}
      <DeviceSection />
    </>
  );
}

export function AdvancedPanel({ snapshot }: { snapshot: ConfigSnapshot }) {
  const write = useRuntimeSettingWrite();
  return <AdvancedPanelView snapshot={snapshot} pending={write.pending}
    onToggle={write.onToggle} onSet={write.onSet} />;
}
