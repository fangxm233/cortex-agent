import { useNavigate } from 'react-router-dom';
import { mobileHeaderBack } from '@/mobile/mobile-navigation';
import { useVocab } from '@/i18n';
import { modelKey, modelLabel } from '@/lib/model-selection';
import { MButton } from '@/mobile/ui/kit';
import { useModelsController, type ModelsController } from '@/features/settings/controllers/useModelsController';
import { groupModelFacts } from '@/features/settings/vm/models-panel-vm';
import { MSettingsCard, MSettingsFeedback, MSettingsPage, MSettingsRow, MSettingsSelect } from './MSettingsControls';

function DefaultModel({ c }: { c: ModelsController }) {
  const L = useVocab();
  const current = c.snapshot?.models.default;
  return <MSettingsCard><MSettingsSelect label={L.stDefaultModel} value={current ? modelKey(current) : ''}
    disabled={c.pending || !c.options.length} onChange={event => c.setDefault(event.target.value)}>
    <option value="" disabled>{L.stChooseModel}</option>
    {c.options.map(ref => <option key={modelKey(ref)} value={modelKey(ref)}>{modelLabel(ref)}</option>)}
  </MSettingsSelect></MSettingsCard>;
}

function Favorites({ c }: { c: ModelsController }) {
  const L = useVocab();
  return <>
    {!c.facts.length && <MSettingsCard title={L.stModelFavorites}><MSettingsFeedback hint={L.stNoFavorites} /></MSettingsCard>}
    {groupModelFacts(c.facts).map(([group, facts]) => <MSettingsCard key={group} title={`${L.stModelFavorites} · ${group}`}>
      {facts.map(fact => <MSettingsRow key={fact.key} stacked title={fact.ref.model}
        sub={fact.thinking ?? L.default} trailing={<div className="mobile-settings-actions">
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
    {c.catalogModels.map(ref => <MSettingsRow key={modelKey(ref)} stacked title={modelLabel(ref)} trailing={
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
