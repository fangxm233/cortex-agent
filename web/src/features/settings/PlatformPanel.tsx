// input:  redacted config, API destination and shared platform writer
// output: functional responsive Platform settings panel
// pos:    Desktop/mobile platform setup and runtime settings
// >>> Once updated, update this header and parent AGENTS.md <<<

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import type { ConfigSnapshot, PlatformSettingsSnapshot, PlatformSettingsPatch } from '@cortex-agent/ui-contract';
import { useVocab, type Vocab } from '@/i18n';
import { apiBase } from '@/lib/desktop-config';
import { PlatformConnectionFields } from './PlatformConnectionFields';
import { PlatformRuntimeFields, type PlatformRuntimePatch } from './PlatformRuntimeFields';
import { connectionPatch, hasConnectionChanges, FIELD_LABELS, type PlatformDraft } from './platform-settings-vm';
import { PS_BLOCK_STYLE, PS_HINT_STYLE } from './platform-ui';
import { PlatformAvatar } from './SettingsPanels';
import {
  CARD_STYLE, SButton, SLinkAction, SNotice, SPill, SRow, SRowGroup, SSection, Toggle,
  type SPillTone,
} from './settings-ui';
import { safeCredentialTransport } from '@/lib/sensitive-transport';
import { usePlatformSettings, type PlatformWriteFeedback } from './usePlatformSettings';
import './platform-settings.css';

const HEADING_STYLE: CSSProperties = { margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)' };
const GUIDE_STYLE: CSSProperties = { marginLeft: 'auto', fontSize: 11.5, fontWeight: 600, color: 'var(--proto-accent)' };
const PROSE_STYLE: CSSProperties = { margin: 0, fontSize: 12.5, lineHeight: 1.7, color: 'var(--proto-muted-2)' };

interface CardProps {
  platform: PlatformSettingsSnapshot; settings: ConfigSnapshot['settings'];
  pending: boolean; secure: boolean;
  saveConnection: (patch: PlatformSettingsPatch) => Promise<boolean>;
  saveRuntime: (patch: PlatformRuntimePatch) => Promise<boolean>;
  onDirtyChange: (platform: string, dirty: boolean) => void;
}

// Configuration completeness, not connection state — three states the pill tones apart.
function statusPill(platform: PlatformSettingsSnapshot, L: Vocab): { tone: SPillTone; label: string } {
  if (!platform.enabled) return { tone: 'neutral', label: L.psDisabled };
  if (platform.missing.length) return { tone: 'amber', label: L.psMissing };
  return { tone: 'success', label: L.psReady };
}

function PlatformHeaderNotes({ platform }: { platform: PlatformSettingsSnapshot }) {
  const L = useVocab();
  return <>
    {platform.missing.length > 0 && <p style={PS_HINT_STYLE}>{L.psMissing}: {platform.missing.map(key => L[FIELD_LABELS[key]]).join(', ')}</p>}
    <p style={PS_HINT_STYLE}>{L.psStatusHint}</p>
    {platform.pendingRestart && <div style={{ marginTop: 12 }}><SNotice tone="amber">{L.psPending}</SNotice></div>}
  </>;
}

function PlatformHeader({ platform }: { platform: PlatformSettingsSnapshot }) {
  const L = useVocab();
  const title = platform.platform === 'feishu' ? L.psFeishu : L.psSlack;
  const status = statusPill(platform, L);
  const guide = platform.platform === 'feishu' ? 'https://open.feishu.cn/document/develop-an-echo-bot/introduction'
    : 'https://fangxm233.github.io/cortex-agent/slack-setup/';
  return <header style={{ padding: '14px 16px' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <PlatformAvatar glyph={platform.platform === 'feishu' ? '飞' : 'S'} />
      <h2 style={HEADING_STYLE}>{title}</h2>
      <SPill tone={status.tone}>{status.label}</SPill>
      <a href={guide} target="_blank" rel="noreferrer" style={GUIDE_STYLE}>{L.psGuide}</a>
    </div>
    <PlatformHeaderNotes platform={platform} />
  </header>;
}

// The form stays a form so Enter inside a field still saves; the kit button is always
// `type="button"`, so it calls the same handler directly instead of submitting.
function ConnectionEditor(props: CardProps & {
  enabled: boolean; setEnabled: (value: boolean) => void; draft: PlatformDraft;
  setDraft: (draft: PlatformDraft) => void; dirty: boolean; onSave: () => void; onReset: () => void;
}) {
  const L = useVocab();
  const locked = props.pending || !props.secure;
  return <form style={PS_BLOCK_STYLE} onSubmit={event => { event.preventDefault(); props.onSave(); }}>
    <SSection label={L.psSetup}>
      <SRowGroup>
        <SRow title={L.psEnabled} desc={L.psEnableHint} align="flex-start" control={
          <Toggle on={props.enabled} inert={locked} ariaLabel={L.psEnabled}
            onClick={locked ? undefined : () => props.setEnabled(!props.enabled)} />
        } />
      </SRowGroup>
    </SSection>
    <PlatformConnectionFields fields={props.platform.fields} draft={props.draft} disabled={locked}
      onChange={(key, value) => props.setDraft({ ...props.draft, [key]: value })} />
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14, marginTop: 16 }}>
      <SButton tone="accent" disabled={!props.dirty || locked} onClick={props.onSave}>
        {props.pending ? L.psSaving : L.psSave}
      </SButton>
      <SLinkAction disabled={!props.dirty || props.pending} onClick={props.onReset}>{L.psReset}</SLinkAction>
    </div>
  </form>;
}

export function PlatformCard(props: CardProps) {
  const [enabled, setEnabled] = useState(props.platform.enabled);
  const [draft, setDraft] = useState<PlatformDraft>({});
  const [routeDirty, setRouteDirty] = useState(false);
  const patch = connectionPatch(props.platform, enabled, draft);
  const dirty = hasConnectionChanges(patch);
  useEffect(() => { setEnabled(props.platform.enabled); }, [props.platform.enabled]);
  useEffect(() => { props.onDirtyChange(props.platform.platform, dirty || routeDirty); },
    [dirty, routeDirty, props.platform.platform, props.onDirtyChange]);
  const reset = () => { setDraft({}); setEnabled(props.platform.enabled); };
  const save = async () => {
    if (!dirty || props.pending || !props.secure) return;
    if (await props.saveConnection(patch)) setDraft({});
  };
  return <article data-platform={props.platform.platform} style={{ ...CARD_STYLE, minWidth: 0, overflow: 'hidden' }}>
    <PlatformHeader platform={props.platform} />
    <ConnectionEditor {...props} enabled={enabled} setEnabled={setEnabled} draft={draft} setDraft={setDraft}
      dirty={dirty} onSave={() => void save()} onReset={reset} />
    <PlatformRuntimeFields platform={props.platform.platform} settings={props.settings} pending={props.pending}
      onSave={props.saveRuntime} onDirtyChange={setRouteDirty} />
  </article>;
}

export function PlatformPanelView(props: {
  snapshot: ConfigSnapshot; secure: boolean; pending: boolean; feedback: PlatformWriteFeedback;
  saveConnection: CardProps['saveConnection']; saveRuntime: CardProps['saveRuntime'];
  onDirtyChange: CardProps['onDirtyChange'];
}) {
  const L = useVocab();
  const feedback = { saved: L.psSaved, runtimeSaved: L.psRuntimeSaved, failed: L.psFailed, refreshFailed: L.psRefreshFailed };
  if (!props.snapshot.platforms) return <SNotice tone="amber">{L.psUnavailable}</SNotice>;
  // `.ps-panel` owns the vertical rhythm here rather than the settings sheet, because the mobile
  // platform screen hosts this same view without the sheet's panel stack.
  return <div className="ps-panel">
    <p style={PROSE_STYLE}>{L.psIntro}</p>
    {!props.secure && <SNotice tone="amber" role="alert">{L.psHttps}</SNotice>}
    {props.feedback && <SNotice tone="accent" role="status">{feedback[props.feedback]}</SNotice>}
    <div className="ps-grid">{props.snapshot.platforms.map(platform => <PlatformCard key={platform.platform}
      {...props} platform={platform} settings={props.snapshot.settings} />)}</div>
    <p style={PROSE_STYLE}>{L.psRestart}</p>
  </div>;
}

export function PlatformPanel({ snapshot, onDirtyChange }: {
  snapshot: ConfigSnapshot; onDirtyChange?: (dirty: boolean) => void;
}) {
  const write = usePlatformSettings();
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const dirtyChanged = useCallback((platform: string, value: boolean) => {
    setDirty(current => current[platform] === value ? current : { ...current, [platform]: value });
  }, []);
  useEffect(() => { onDirtyChange?.(Object.values(dirty).some(Boolean)); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const secure = safeCredentialTransport(apiBase(), globalThis.location?.href ?? '');
  return <PlatformPanelView snapshot={snapshot} secure={secure} {...write} onDirtyChange={dirtyChanged} />;
}
