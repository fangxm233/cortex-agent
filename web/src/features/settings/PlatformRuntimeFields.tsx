// input:  runtime settings snapshot and serialized setting writer
// output: notification routing editor and Web Feishu skill switch
// pos:    Runtime controls embedded in platform cards
// >>> Once updated, update this header and parent AGENTS.md <<<

import { useEffect, useState } from 'react';
import type { ConfigSnapshot } from '@cortex-agent/ui-contract';
import { useVocab } from '@/i18n';
import { PS_BLOCK_STYLE, psFieldStyle } from './platform-ui';
import { SButton, SFieldRow, SRow, SRowGroup, SSection, Toggle } from './settings-ui';

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
  const on = entry?.value === true;
  const locked = props.pending || typeof entry?.value !== 'boolean';
  return <section data-platform-runtime="feishuSkillsInWeb" style={PS_BLOCK_STYLE}>
    <SRowGroup>
      <SRow title={L.psSkills} desc={L.psSkillsHint} align="flex-start" control={
        <Toggle on={on} inert={locked} ariaLabel={L.psSkills}
          onClick={locked ? undefined : () => void props.onSave({ feishuSkillsInWeb: !on })} />
      } />
    </SRowGroup>
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
  const locked = props.pending || !entry;
  const label = props.platform === 'feishu' ? L.psFeishuRoute : L.psSlackRoute;
  return <section data-platform-runtime={key} style={PS_BLOCK_STYLE}>
    <SSection label={L.psRouting}>
      <SFieldRow label={label} hint={<>{L.psRouteHint} {props.platform === 'feishu' && L.psFeishuRouteHint}</>}>
        <input name={key} value={draft} maxLength={256} disabled={locked} aria-label={label}
          onChange={e => setDraft(e.target.value)} aria-invalid={!valid} style={psFieldStyle(locked)} />
      </SFieldRow>
      <div style={{ marginTop: 12 }}>
        <SButton tone="neutral" disabled={locked || !valid || draft === current}
          onClick={() => void props.onSave({ [key]: draft || null })}>{L.psSaveRoute}</SButton>
      </div>
    </SSection>
  </section>;
}

export function PlatformRuntimeFields(props: RuntimeProps) {
  return <><DestinationEditor {...props} />{props.platform === 'feishu' && <SkillSwitch {...props} />}</>;
}
