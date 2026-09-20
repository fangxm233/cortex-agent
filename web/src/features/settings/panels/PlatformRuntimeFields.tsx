// input:  runtime settings snapshot and serialized setting writer
// output: notification routing editor and Web Feishu skill switch
// pos:    Runtime controls embedded in platform cards
// >>> Once updated, update this header and parent CORTEX.md <<<

import { useEffect, useState } from 'react';
import type { ConfigSnapshot } from '@cortex-agent/ui-contract';
import { useVocab } from '@/i18n';

export type PlatformRuntimePatch = {
  adminChannel?: string | null; feishuAdminChannel?: string | null; feishuSkillsInWeb?: boolean;
};
interface RuntimeProps {
  platform: 'feishu' | 'slack'; settings: ConfigSnapshot['settings']; pending: boolean;
  onSave: (patch: PlatformRuntimePatch) => Promise<boolean>;
  onDirtyChange: (dirty: boolean) => void;
}

function SkillSwitch(props: RuntimeProps) {
  const L = useVocab();
  const entry = props.settings?.find(s => s.key === 'feishuSkillsInWeb');
  return <section className="ps-runtime">
    <label className="ps-check"><input type="checkbox" checked={entry?.value === true}
      disabled={props.pending || typeof entry?.value !== 'boolean'}
      onChange={e => void props.onSave({ feishuSkillsInWeb: e.target.checked })} />{L.psSkills}</label>
    <p className="ps-hint">{L.psSkillsHint}</p>
  </section>;
}

function DestinationEditor(props: RuntimeProps) {
  const L = useVocab();
  const key = props.platform === 'feishu' ? 'feishuAdminChannel' : 'adminChannel';
  const entry = props.settings?.find(s => s.key === key);
  const current = typeof entry?.value === 'string' ? entry.value : '';
  const [draft, setDraft] = useState(current);
  useEffect(() => { setDraft(current); }, [current]);
  useEffect(() => { props.onDirtyChange(draft !== current); }, [draft, current, props.onDirtyChange]);
  const valid = /^[^\s\u0000-\u001f\u007f]{0,256}$/.test(draft);
  return <section className="ps-runtime">
    <h3>{L.psRouting}</h3>
    <label className="ps-field">{props.platform === 'feishu' ? L.psFeishuRoute : L.psSlackRoute}
      <input name={key} value={draft} maxLength={256} disabled={props.pending || !entry}
        onChange={e => setDraft(e.target.value)} aria-invalid={!valid} />
    </label>
    <p className="ps-hint">{L.psRouteHint} {props.platform === 'feishu' && L.psFeishuRouteHint}</p>
    <button className="ps-button" type="button" disabled={props.pending || !entry || !valid || draft === current}
      onClick={() => void props.onSave({ [key]: draft || null })}>{L.psSaveRoute}</button>
  </section>;
}

export function PlatformRuntimeFields(props: RuntimeProps) {
  return <><DestinationEditor {...props} />{props.platform === 'feishu' && <SkillSwitch {...props} />}</>;
}
