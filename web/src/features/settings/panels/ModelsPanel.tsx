import '@/features/settings/ui/desktop-panels.css';
import type { ConfigSnapshot } from '@cortex-agent/ui-contract';
import { Select } from '@/design';
import { useVocab } from '@/i18n';
import { modelKey } from '@/lib/model-selection';
import { useModelsController, type ModelsController } from '@/features/settings/controllers/useModelsController';
import { groupModelFacts, modelOptionLabel } from '@/features/settings/vm/models-panel-vm';
import { SLinkAction, SNotice, SPill, SRow, SRowGroup, SSection, S_CONTROL_STYLE } from '@/features/settings/ui/settings-ui';

function DefaultModelRow({ controller: c }: { controller: ModelsController }) {
  const L = useVocab();
  const current = c.snapshot?.models.default;
  return <SRowGroup><SRow title={L.stDefaultModel} desc={L.stModelDefaultNote} control={
    <Select aria-label={L.stDefaultModel} value={current ? modelKey(current) : ''}
      disabled={c.pending || !c.options.length} placeholder={L.stChooseModel}
      popupClassName="settings-surface settings-select-popup" style={S_CONTROL_STYLE}
      options={c.options.map(ref => ({ value: modelKey(ref), label: modelOptionLabel(ref) }))}
      onValueChange={c.setDefault} />
  } /></SRowGroup>;
}

function FavoriteGroups({ controller: c }: { controller: ModelsController }) {
  const L = useVocab();
  return <SSection label={L.stModelFavorites}>
    {!c.facts.length && <SNotice tone="muted">{L.stNoFavorites}</SNotice>}
    {groupModelFacts(c.facts).map(([group, facts]) => <SSection key={group} label={group}>
      <SRowGroup>{facts.map(fact => <div className="settings-model-row" key={fact.key} data-model-row={fact.key}>
        <span className="settings-model-name">{fact.ref.model} {fact.current && <SPill tone="accent">{L.default}</SPill>}</span>
        <span className="settings-model-cell" data-label={L.stColThinking}>{fact.thinking ?? L.default}</span>
        <SLinkAction disabled={c.pending || fact.current} onClick={() => c.setDefault(fact.key)}>{L.stSetDefaultModel}</SLinkAction>
        <SLinkAction disabled={c.pending} onClick={() => c.remove(fact.ref)}>{L.stRemoveFavorite}</SLinkAction>
      </div>)}</SRowGroup>
    </SSection>)}
  </SSection>;
}

function Catalog({ controller: c }: { controller: ModelsController }) {
  const L = useVocab();
  if (!c.catalogOpen) return <SLinkAction onClick={() => c.setCatalogOpen(true)}>{L.stAddFavorite}</SLinkAction>;
  const keys = new Set(c.facts.map(fact => fact.key));
  return <SSection label={L.stAllModels} action={<SLinkAction onClick={() => c.setCatalogOpen(false)}>{L.cancel}</SLinkAction>}>
    {c.catalogPending && <SNotice tone="muted">{L.stModelCatalogPending}</SNotice>}
    {c.catalogError && <SNotice tone="danger">{c.catalogError.message}</SNotice>}
    {!c.catalogPending && !c.catalogModels.length && <SNotice tone="muted">{L.stNoCatalogModels}</SNotice>}
    <SRowGroup>{c.catalogModels.map(ref => <SRow key={modelKey(ref)} title={modelOptionLabel(ref)} control={
      <SLinkAction disabled={c.pending || keys.has(modelKey(ref))} onClick={() => c.add(ref)}>
        {keys.has(modelKey(ref)) ? L.stFavorited : L.stAddFavorite}
      </SLinkAction>
    } />)}</SRowGroup>
  </SSection>;
}

export function ModelsPanelView({ controller }: { controller: ModelsController }) {
  return <div className="settings-models" data-settings-panel="models" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
    <DefaultModelRow controller={controller} />
    <FavoriteGroups controller={controller} />
    <Catalog controller={controller} />
  </div>;
}

export function ModelsPanel({ snapshot }: { snapshot: ConfigSnapshot }) {
  const controller = useModelsController(snapshot);
  return <ModelsPanelView controller={controller} />;
}
