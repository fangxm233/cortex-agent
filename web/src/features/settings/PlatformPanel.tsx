// input:  redacted config, API destination and shared platform writer
// output: functional responsive Platform settings panel
// pos:    Desktop/mobile platform setup and runtime settings
// >>> Once updated, update this header and parent CORTEX.md <<<

import { useCallback, useEffect, useState } from 'react';
import type { ConfigSnapshot, PlatformSettingsSnapshot, PlatformSettingsPatch } from '@cortex-agent/ui-contract';
import { useVocab } from '@/i18n';
import { apiBase } from '@/lib/desktop-config';
import { PlatformConnectionFields } from './PlatformConnectionFields';
import { PlatformRuntimeFields, type PlatformRuntimePatch } from './PlatformRuntimeFields';
import { connectionPatch, hasConnectionChanges, FIELD_LABELS, type PlatformDraft } from './platform-settings-vm';
import { safeCredentialTransport } from '@/lib/sensitive-transport';
import { usePlatformSettings, type PlatformWriteFeedback } from './usePlatformSettings';
import './platform-settings.css';

interface CardProps {
  platform: PlatformSettingsSnapshot; settings: ConfigSnapshot['settings'];
  pending: boolean; secure: boolean;
  saveConnection: (patch: PlatformSettingsPatch) => Promise<boolean>;
  saveRuntime: (patch: PlatformRuntimePatch) => Promise<boolean>;
  onDirtyChange: (platform: string, dirty: boolean) => void;
}

function PlatformHeader({ platform }: { platform: PlatformSettingsSnapshot }) {
  const L = useVocab();
  const title = platform.platform === 'feishu' ? L.psFeishu : L.psSlack;
  const status = !platform.enabled ? L.psDisabled : platform.missing.length ? L.psMissing : L.psReady;
  const guide = platform.platform === 'feishu' ? 'https://open.feishu.cn/document/develop-an-echo-bot/introduction'
    : 'https://fangxm233.github.io/cortex-agent/slack-setup/';
  return <header className="ps-header"><div className="ps-heading">
    <span className={`ps-avatar ps-${platform.platform}`}>{platform.platform === 'feishu' ? '飞' : 'S'}</span>
    <h2>{title}</h2><a href={guide} target="_blank" rel="noreferrer">{L.psGuide}</a>
  </div><span className="ps-status">{status}</span>
    {platform.missing.length > 0 && <p className="ps-hint">{L.psMissing}: {platform.missing.map(key => L[FIELD_LABELS[key]]).join(', ')}</p>}
    <p className="ps-hint">{L.psStatusHint}</p>
    {platform.pendingRestart && <p className="ps-warning">{L.psPending}</p>}
  </header>;
}

function ConnectionEditor(props: CardProps & {
  enabled: boolean; setEnabled: (value: boolean) => void; draft: PlatformDraft;
  setDraft: (draft: PlatformDraft) => void; dirty: boolean; onSave: () => void; onReset: () => void;
}) {
  const L = useVocab();
  return <form className="ps-connection" onSubmit={event => { event.preventDefault(); props.onSave(); }}>
    <h3>{L.psSetup}</h3>
    <label className="ps-check"><input type="checkbox" checked={props.enabled}
      disabled={props.pending || !props.secure} onChange={event => props.setEnabled(event.target.checked)} />{L.psEnabled}</label>
    <p className="ps-hint">{L.psEnableHint}</p>
    <PlatformConnectionFields fields={props.platform.fields} draft={props.draft} disabled={props.pending || !props.secure}
      onChange={(key, value) => props.setDraft({ ...props.draft, [key]: value })} />
    <div className="ps-actions"><button className="ps-button ps-primary" type="submit"
      disabled={!props.dirty || props.pending || !props.secure}>{props.pending ? L.psSaving : L.psSave}</button>
      <button className="ps-link" type="button" disabled={!props.dirty || props.pending} onClick={props.onReset}>{L.psReset}</button></div>
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
  return <article className="ps-card" data-platform={props.platform.platform}>
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
  if (!props.snapshot.platforms) return <p className="ps-warning">{L.psUnavailable}</p>;
  return <div className="ps-panel">
    <p className="ps-intro">{L.psIntro}</p>
    {!props.secure && <p className="ps-warning" role="alert">{L.psHttps}</p>}
    {props.feedback && <p className="ps-feedback" role="status">{feedback[props.feedback]}</p>}
    <div className="ps-grid">{props.snapshot.platforms.map(platform => <PlatformCard key={platform.platform}
      {...props} platform={platform} settings={props.snapshot.settings} />)}</div>
    <p className="ps-footer">{L.psRestart}</p>
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
