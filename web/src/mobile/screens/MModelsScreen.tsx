import { useNavigate } from 'react-router-dom';
import { mobileHeaderBack } from '@/mobile/mobile-navigation';
import { useVocab } from '@/i18n';
import { modelKey } from '@/lib/model-selection';
import { MButton } from '@/mobile/ui/kit';
import { ProviderIcon } from '@/features/auth/ProviderIcon';
import { useModelsController, type ModelsController } from '@/features/settings/controllers/useModelsController';
import { favoriteThinkingControl, groupModelFacts, modelOptionLabel, thinkingFromValue, type ModelFact } from '@/features/settings/vm/models-panel-vm';
import { MSettingsCard, MSettingsFeedback, MSettingsPage, MSettingsRow, MSettingsSelect } from './MSettingsControls';

function DefaultModel({ c }: { c: ModelsController }) {
  const L = useVocab();
  const current = c.snapshot?.models.default;
  return <MSettingsCard><MSettingsSelect label={L.stDefaultModel} value={current ? modelKey(current) : ''}
    disabled={c.pending || !c.options.length} onChange={event => c.setDefault(event.target.value)}>
    <option value="" disabled>{L.stChooseModel}</option>
    {c.options.map(ref => <option key={modelKey(ref)} value={modelKey(ref)}>{modelOptionLabel(ref)}</option>)}
  </MSettingsSelect></MSettingsCard>;
}

function FavoriteThinking({ c, fact }: { c: ModelsController; fact: ModelFact }) {
  const L = useVocab();
  const control = favoriteThinkingControl(fact, c.catalog, L);
  return <MSettingsSelect label={L.stColThinking} aria-label={`${L.stColThinking} · ${modelOptionLabel(fact.ref)}`}
    title={L.stModelThinkingNote} value={control.value} disabled={c.pending || control.disabled}
    onChange={event => c.setThinking(fact.ref, thinkingFromValue(event.target.value))}>
    {control.options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>
      {option.label}
    </option>)}
  </MSettingsSelect>;
}

function Favorites({ c }: { c: ModelsController }) {
  const L = useVocab();
  return <>
    {!c.facts.length && <MSettingsCard title={L.stModelFavorites}><MSettingsFeedback hint={L.stNoFavorites} /></MSettingsCard>}
    {groupModelFacts(c.facts).map(([group, facts]) => <MSettingsCard key={group} title={
      <span className="settings-model-provider">
        <ProviderIcon provider={facts[0].ref.provider || facts[0].ref.backend} />
        <span>{L.stModelFavorites} · {group}</span>
      </span>
    }>
      {facts.map(fact => <MSettingsRow key={fact.key} stacked title={fact.ref.model}
        trailing={<div className="mobile-settings-actions">
          <FavoriteThinking c={c} fact={fact} />
          <MButton compact variant="accent-outline" disabled={c.pending || fact.current}
            onClick={() => c.setDefault(fact.key)}>{fact.current ? L.default : L.stSetDefaultModel}</MButton>
          <MButton compact variant="danger-outline" disabled={c.pending}
            onClick={() => c.remove(fact.ref)}>{L.stRemoveFavorite}</MButton>
        </div>} />)}
    </MSettingsCard>)}
  </>;
}

function Catalog({ c }: { c: ModelsController }) {
  const L = useVocab();
  if (!c.catalogOpen) return <MButton variant="accent-outline" onClick={() => c.setCatalogOpen(true)}>{L.stAddFavorite}</MButton>;
  const keys = new Set(c.facts.map(fact => fact.key));
  return <MSettingsCard title={L.stAllModels}>
    <MSettingsFeedback hint={c.catalogPending ? L.stModelCatalogPending : undefined} error={c.catalogError?.message} />
    {!c.catalogPending && !c.catalogModels.length && <MSettingsFeedback hint={L.stNoCatalogModels} />}
    {c.catalogModels.map(ref => <MSettingsRow key={modelKey(ref)} stacked title={
      <span className="settings-model-provider">
        <ProviderIcon provider={ref.provider || ref.backend} />
        <span>{modelOptionLabel(ref)}</span>
      </span>
    } trailing={
      <MButton compact variant="accent-outline" disabled={c.pending || keys.has(modelKey(ref))} onClick={() => c.add(ref)}>
        {keys.has(modelKey(ref)) ? L.stFavorited : L.stAddFavorite}
      </MButton>
    } />)}
    <MButton compact variant="accent-outline" onClick={() => c.setCatalogOpen(false)}>{L.cancel}</MButton>
  </MSettingsCard>;
}

export function MModelsView({ controller: c, onBack }: { controller: ModelsController; onBack: () => void }) {
  const L = useVocab();
  return <MSettingsPage title={L.stNavModels} onBack={onBack}>
    <MSettingsFeedback hint={c.loading ? L.stLoadingConfig : undefined} error={c.error?.message} />
    {c.snapshot && <><DefaultModel c={c} /><Favorites c={c} /><Catalog c={c} /></>}
  </MSettingsPage>;
}

export function MModelsScreen() {
  const navigate = useNavigate();
  const controller = useModelsController();
  return <MModelsView controller={controller} onBack={() => mobileHeaderBack(navigate, '/m/settings')} />;
}
