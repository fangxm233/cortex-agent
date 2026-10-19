import '@/features/settings/ui/desktop-panels.css';
import { useState } from 'react';
import type { ConfigSnapshot } from '@cortex-agent/ui-contract';
import { Select } from '@/design';
import { ProviderIcon } from '@/features/auth/ProviderIcon';
import { useVocab } from '@/i18n';
import { matchesModelFilter, modelKey } from '@/lib/model-selection';
import { useModelsController, type ModelsController } from '@/features/settings/controllers/useModelsController';
import { favoriteThinkingControl, groupModelFacts, modelOptionLabel, thinkingFromValue, type ModelFact } from '@/features/settings/vm/models-panel-vm';
import { SLinkAction, SMeta, SNotice, SRow, SRowGroup, SSection, SSubheading, S_CONTROL_STYLE } from '@/features/settings/ui/settings-ui';

function DefaultModelRow({ controller: c }: { controller: ModelsController }) {
  const L = useVocab();
  const current = c.snapshot?.models.default;
  return <SRowGroup><SRow title={L.stDefaultModel} desc={L.stModelDefaultNote} control={
    <Select aria-label={L.stDefaultModel} value={current ? modelKey(current) : ''}
      disabled={c.pending || !c.options.length} placeholder={L.stChooseModel}
      popupClassName="settings-surface settings-select-popup" style={{ ...S_CONTROL_STYLE, width: 300, maxWidth: '100%' }}
      options={c.options.map(ref => ({ value: modelKey(ref), label: modelOptionLabel(ref) }))}
      onValueChange={c.setDefault} />
  } /></SRowGroup>;
}

function FavoriteThinking({ c, fact }: { c: ModelsController; fact: ModelFact }) {
  const L = useVocab();
  const control = favoriteThinkingControl(fact, c.catalog, L);
  return <Select aria-label={`${L.stColThinking} · ${modelOptionLabel(fact.ref)}`} title={L.stModelThinkingNote}
    value={control.value} options={control.options} disabled={c.pending || control.disabled}
    popupClassName="settings-surface settings-select-popup"
    onValueChange={value => c.setThinking(fact.ref, thinkingFromValue(value))} />;
}

function RemoveIcon() {
  return <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}
    strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>;
}

/** "Set as default" shows on hover or keyboard focus; removing is a quiet × with a spoken name. */
function FavoriteControls({ c, fact }: { c: ModelsController; fact: ModelFact }) {
  const L = useVocab();
  return <div className="settings-model-controls">
    <span className="settings-model-default">
      <SLinkAction disabled={c.pending || fact.current} onClick={() => c.setDefault(fact.key)}>{L.stSetDefaultModel}</SLinkAction>
    </span>
    <FavoriteThinking c={c} fact={fact} />
    <button type="button" className="settings-model-remove" disabled={c.pending}
      aria-label={`${L.stRemoveFavorite} · ${fact.ref.model}`} title={L.stRemoveFavorite}
      onClick={() => c.remove(fact.ref)}><RemoveIcon /></button>
  </div>;
}

function FavoriteRow({ c, fact }: { c: ModelsController; fact: ModelFact }) {
  const L = useVocab();
  return <SRow className="settings-model-row" data-model-row={fact.key} data-current={fact.current ? '' : undefined}
    title={<span className="settings-model-name">{fact.ref.model}{fact.current && <> <SMeta>{L.default}</SMeta></>}</span>}
    control={<FavoriteControls c={c} fact={fact} />} />;
}

function FavoriteGroups({ controller: c }: { controller: ModelsController }) {
  const L = useVocab();
  return <SSection label={L.stModelFavorites} action={c.facts.length ? String(c.facts.length) : undefined}>
    {!c.facts.length && <SNotice tone="muted">{L.stNoFavorites}</SNotice>}
    {groupModelFacts(c.facts).map(([group, facts]) => <div key={group} className="settings-model-group settings-flush">
      <SSubheading>
        <span className="settings-model-provider">
          <ProviderIcon provider={facts[0].ref.provider || facts[0].ref.backend} />
          <span>{group}</span>
        </span>
      </SSubheading>
      <SRowGroup data-model-group={group}>{facts.map(fact => <FavoriteRow key={fact.key} c={c} fact={fact} />)}</SRowGroup>
    </div>)}
  </SSection>;
}

function Catalog({ controller: c }: { controller: ModelsController }) {
  const L = useVocab();
  const [filter, setFilter] = useState('');
  if (!c.catalogOpen) return <SLinkAction onClick={() => c.setCatalogOpen(true)}>{L.stAddFavorite}</SLinkAction>;
  const keys = new Set(c.facts.map(fact => fact.key));
  return <SSection label={L.stAllModels} action={<SLinkAction onClick={() => c.setCatalogOpen(false)}>{L.cancel}</SLinkAction>}>
    <input className="settings-control" data-model-filter aria-label={L.wbFilterModels} placeholder={L.wbFilterModels}
      value={filter} onChange={event => setFilter(event.target.value)} style={{ marginBottom: 4 }} />
    {c.catalogPending && <SNotice tone="muted">{L.stModelCatalogPending}</SNotice>}
    {c.catalogError && <SNotice tone="danger">{c.catalogError.message}</SNotice>}
    {!c.catalogPending && !c.catalogModels.length && <SNotice tone="muted">{L.stNoCatalogModels}</SNotice>}
    <SRowGroup>{c.catalogModels.filter(ref => matchesModelFilter(ref.model, filter)).map(ref => <SRow key={modelKey(ref)} title={
      <span className="settings-model-provider">
        <ProviderIcon provider={ref.provider || ref.backend} />
        <span>{modelOptionLabel(ref)}</span>
      </span>
    } control={
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
