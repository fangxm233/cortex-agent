import { useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { mobileHeaderBack } from '@/mobile/mobile-navigation';
import { useVocab } from '@/i18n';
import { modelKey } from '@/lib/model-selection';
import { MButton, MC, MGroup, M_NUM } from '@/mobile/ui/kit';
import { ProviderIcon } from '@/features/auth/ProviderIcon';
import { useModelsController, type ModelsController } from '@/features/settings/controllers/useModelsController';
import { favoriteThinkingControl, groupModelFacts, modelOptionLabel, thinkingFromValue, type ModelFact } from '@/features/settings/vm/models-panel-vm';
import {
  MSET_INSET, MSET_SUB, MSET_TITLE, MSettingsFeedback, MSettingsGroupLabel, MSettingsPage, MSettingsRow,
  MSettingsSection, MSettingsSelect, MSettingsSheet,
} from './MSettingsControls';

const PAD = `11px ${MSET_INSET}px`;
const ROW_BUTTON: CSSProperties = {
  width: '100%', minHeight: 44, border: 0, background: 'transparent', padding: `12px ${MSET_INSET}px`,
  display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', color: MC.ink, cursor: 'pointer',
};

function DefaultModel({ c }: { c: ModelsController }) {
  const L = useVocab();
  const current = c.snapshot?.models.default;
  return <MSettingsSection><div style={{ padding: PAD }}>
    <MSettingsSelect label={L.stDefaultModel} value={current ? modelKey(current) : ''}
      disabled={c.pending || !c.options.length} onChange={event => c.setDefault(event.target.value)}>
      <option value="" disabled>{L.stChooseModel}</option>
      {c.options.map(ref => <option key={modelKey(ref)} value={modelKey(ref)}>{modelOptionLabel(ref)}</option>)}
    </MSettingsSelect>
  </div></MSettingsSection>;
}

function FavoriteRow({ fact, onOpen }: { fact: ModelFact; onOpen: (key: string) => void }) {
  const L = useVocab();
  return <button type="button" data-model-favorite={fact.key} onClick={() => onOpen(fact.key)} style={ROW_BUTTON}>
    <span style={{ minWidth: 0, flex: 1 }}>
      <span style={{ ...MSET_TITLE, display: 'block' }}>{fact.ref.model}</span>
      {fact.current && <span style={{ ...MSET_SUB, display: 'block', marginTop: 2 }}>{L.default}</span>}
    </span>
    <span style={{ fontSize: 13, color: MC.muted, flex: 'none', ...M_NUM }}>{fact.thinking ?? L.stThinkingBackendDefault}</span>
    <span aria-hidden="true" style={{ color: MC.faint, fontSize: 15, flex: 'none' }}>›</span>
  </button>;
}

function Favorites({ c, onOpen }: { c: ModelsController; onOpen: (key: string) => void }) {
  const L = useVocab();
  if (!c.facts.length) {
    return <MSettingsSection title={L.stModelFavorites}>
      <div style={{ padding: PAD }}><MSettingsFeedback hint={L.stNoFavorites} /></div>
    </MSettingsSection>;
  }
  return <>{groupModelFacts(c.facts).map(([group, facts]) => <MSettingsSection key={group} title={
    <span className="settings-model-provider">
      <ProviderIcon provider={facts[0].ref.provider || facts[0].ref.backend} />
      <span>{L.stModelFavorites} · {group}</span>
    </span>
  }>
    {facts.map(fact => <FavoriteRow key={fact.key} fact={fact} onOpen={onOpen} />)}
  </MSettingsSection>)}</>;
}

function ThinkingOption({ label, checked, disabled, onPick }: {
  label: string; checked: boolean; disabled: boolean; onPick: () => void;
}) {
  return <button type="button" role="radio" aria-checked={checked} disabled={disabled}
    onClick={() => { if (!checked) onPick(); }} style={{ ...ROW_BUTTON, cursor: disabled ? 'default' : 'pointer' }}>
    <span style={{ flex: 1, minWidth: 0, fontWeight: checked ? 600 : 500 }}>{label}</span>
    {checked && <span aria-hidden="true" style={{ fontWeight: 700, flex: 'none' }}>✓</span>}
  </button>;
}

function ThinkingOptions({ c, fact }: { c: ModelsController; fact: ModelFact }) {
  const L = useVocab();
  const control = favoriteThinkingControl(fact, c.catalog, L);
  const locked = c.pending || control.disabled;
  return <div role="radiogroup" aria-label={`${L.stColThinking} · ${modelOptionLabel(fact.ref)}`}>
    <MGroup inset={MSET_INSET}>
      {control.options.map(option => <ThinkingOption key={option.value} label={option.label}
        checked={option.value === control.value} disabled={locked || !!option.disabled}
        onPick={() => c.setThinking(fact.ref, thinkingFromValue(option.value))} />)}
    </MGroup>
  </div>;
}

function FavoriteSheet({ c, fact, onClose }: { c: ModelsController; fact: ModelFact; onClose: () => void }) {
  const L = useVocab();
  return <MSettingsSheet onClose={onClose}>
    <div data-model-sheet={fact.key}>
      <div className="settings-model-provider" style={{ fontSize: 17, fontWeight: 650, color: MC.ink, padding: `0 ${MSET_INSET}px 12px` }}>
        <ProviderIcon provider={fact.ref.provider || fact.ref.backend} />
        <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{modelOptionLabel(fact.ref)}</span>
      </div>
      <MSettingsGroupLabel>{L.stColThinking}</MSettingsGroupLabel>
      <ThinkingOptions c={c} fact={fact} />
      <div style={{ ...MSET_SUB, padding: `4px ${MSET_INSET}px 0` }}>{L.stModelThinkingNote}</div>
      <div style={{ display: 'flex', gap: 8, padding: `16px ${MSET_INSET}px 4px` }}>
        <MButton variant="danger-outline" disabled={c.pending} style={{ flex: 1 }}
          onClick={() => { c.remove(fact.ref); onClose(); }}>{L.stRemoveFavorite}</MButton>
        <MButton variant="ink" disabled={c.pending || fact.current} style={{ flex: 1 }}
          onClick={() => c.setDefault(fact.key)}>{fact.current ? L.default : L.stSetDefaultModel}</MButton>
      </div>
    </div>
  </MSettingsSheet>;
}

function Catalog({ c }: { c: ModelsController }) {
  const L = useVocab();
  if (!c.catalogOpen) return <MButton variant="outline" onClick={() => c.setCatalogOpen(true)}>{L.stAddFavorite}</MButton>;
  const keys = new Set(c.facts.map(fact => fact.key));
  const feedback = c.catalogPending || c.catalogError || !c.catalogModels.length;
  return <><MSettingsSection title={L.stAllModels}>
    {feedback && <div style={{ padding: PAD }}>
      <MSettingsFeedback hint={c.catalogPending ? L.stModelCatalogPending : undefined} error={c.catalogError?.message} />
      {!c.catalogPending && !c.catalogModels.length && <MSettingsFeedback hint={L.stNoCatalogModels} />}
    </div>}
    {c.catalogModels.map(ref => <MSettingsRow key={modelKey(ref)} title={
      <span className="settings-model-provider">
        <ProviderIcon provider={ref.provider || ref.backend} />
        <span>{modelOptionLabel(ref)}</span>
      </span>
    } trailing={
      <MButton compact variant="outline" disabled={c.pending || keys.has(modelKey(ref))} onClick={() => c.add(ref)}>
        {keys.has(modelKey(ref)) ? L.stFavorited : L.stAddFavorite}
      </MButton>
    } />)}
  </MSettingsSection>
  <MButton compact variant="outline" onClick={() => c.setCatalogOpen(false)}>{L.cancel}</MButton></>;
}

export function MModelsView({ controller: c, onBack }: { controller: ModelsController; onBack: () => void }) {
  const L = useVocab();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const open = openKey === null ? undefined : c.facts.find(fact => fact.key === openKey);
  return <MSettingsPage title={L.stNavModels} onBack={onBack}>
    <MSettingsFeedback hint={c.loading ? L.stLoadingConfig : undefined} error={c.error?.message} />
    {c.snapshot && <><DefaultModel c={c} /><Favorites c={c} onOpen={setOpenKey} /><Catalog c={c} /></>}
    {open && <FavoriteSheet c={c} fact={open} onClose={() => setOpenKey(null)} />}
  </MSettingsPage>;
}

export function MModelsScreen() {
  const navigate = useNavigate();
  const controller = useModelsController();
  return <MModelsView controller={controller} onBack={() => mobileHeaderBack(navigate, '/m/settings')} />;
}
