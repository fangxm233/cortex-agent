import '@/features/settings/ui/desktop-panels.css';
import { useState } from 'react';
import type { ConfigSnapshot } from '@cortex-agent/ui-contract';
import { Select } from '@/design';
import { useVocab } from '@/i18n';
import { matchesModelFilter, modelKey } from '@/lib/model-selection';
import { useModelsController, type ModelsController } from '@/features/settings/controllers/useModelsController';
import { favoriteThinkingControl, groupModelFacts, modelOptionLabel, thinkingFromValue, type ModelFact } from '@/features/settings/vm/models-panel-vm';
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

function FavoriteThinking({ c, fact }: { c: ModelsController; fact: ModelFact }) {
  const L = useVocab();
  const control = favoriteThinkingControl(fact, c.catalog, L);
  return <span className="settings-model-cell" data-label={L.stColThinking}>
    <Select aria-label={`${L.stColThinking} · ${modelOptionLabel(fact.ref)}`} title={L.stModelThinkingNote}
      value={control.value} options={control.options} disabled={c.pending || control.disabled}
      popupClassName="settings-surface settings-select-popup"
      onValueChange={value => c.setThinking(fact.ref, thinkingFromValue(value))} />
  </span>;
}

function FavoriteGroups({ controller: c }: { controller: ModelsController }) {
  const L = useVocab();
  return <SSection label={L.stModelFavorites}>
    {!c.facts.length && <SNotice tone="muted">{L.stNoFavorites}</SNotice>}
    {groupModelFacts(c.facts).map(([group, facts]) => <SSection key={group} label={group}>
      <SRowGroup data-model-group={group}>{facts.map(fact => <SRow className="settings-model-row" key={fact.key} data-model-row={fact.key}
        title={<span className="settings-model-name">{fact.ref.model} {fact.current && <SPill tone="accent">{L.default}</SPill>}</span>}
        control={<div className="settings-model-controls">
          <FavoriteThinking c={c} fact={fact} />
          <SLinkAction disabled={c.pending || fact.current} onClick={() => c.setDefault(fact.key)}>{L.stSetDefaultModel}</SLinkAction>
          <SLinkAction disabled={c.pending} onClick={() => c.remove(fact.ref)}>{L.stRemoveFavorite}</SLinkAction>
        </div>}
      />)}</SRowGroup>
    </SSection>)}
  </SSection>;
}

function Catalog({ controller: c }: { controller: ModelsController }) {
  const L = useVocab();
  const [filter, setFilter] = useState('');
  if (!c.catalogOpen) return <SLinkAction onClick={() => c.setCatalogOpen(true)}>{L.stAddFavorite}</SLinkAction>;
  const keys = new Set(c.facts.map(fact => fact.key));
  return <SSection label={L.stAllModels} action={<SLinkAction onClick={() => c.setCatalogOpen(false)}>{L.cancel}</SLinkAction>}>
    <input className="settings-control" data-model-filter aria-label={L.wbFilterModels} placeholder={L.wbFilterModels}
      value={filter} onChange={event => setFilter(event.target.value)} style={{ marginBottom: 8 }} />
    {c.catalogPending && <SNotice tone="muted">{L.stModelCatalogPending}</SNotice>}
    {c.catalogError && <SNotice tone="danger">{c.catalogError.message}</SNotice>}
    {!c.catalogPending && !c.catalogModels.length && <SNotice tone="muted">{L.stNoCatalogModels}</SNotice>}
    <SRowGroup>{c.catalogModels.filter(ref => matchesModelFilter(ref.model, filter)).map(ref => <SRow key={modelKey(ref)} title={modelOptionLabel(ref)} control={
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
