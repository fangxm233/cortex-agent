import { useState } from 'react';
import { useVocab } from '@/i18n';
import { useSettings } from '@/features/settings/useSettings';
import { SelectionPane as PaneMotion } from '@/design/SelectionPane';
import type {
  ModeOption, ModelOption, SelectionPane, SelectionRootRow, ThinkingOption,
} from '@/features/session/list/selection-menu';
import {
  Divider, MenuCard, MenuRow, Note, rowBackground, SectionTitle, type HoverProps,
  MENU_BUTTON_STYLE, MENU_FOCUS, MENU_ROW_PAD_X,
} from '@/design/MenuChrome';

import { groupModelOptions } from '@/features/session/list/selection-menu';
import { matchesModelFilter, modelKey, modelLabel } from '@/lib/model-selection';

// The engine menu. Model names, levels and modes are names, not code, so every row is in the UI
// face: an ink label, its value muted on the right, and an ink tick on what runs now.

function Caret({ back = false }: { back?: boolean }): JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
      <path d={back ? 'm10 4-4 4 4 4' : 'm6 4 4 4-4 4'} />
    </svg>
  );
}

function DrillRow({ row, onOpen, hover, setHover }: {
  row: SelectionRootRow;
  onOpen: () => void;
} & HoverProps): JSX.Element {
  const id = `pane:${row.key}`;
  return (
    <button
      type="button"
      className={MENU_FOCUS}
      onMouseEnter={() => setHover(id)}
      onMouseLeave={() => setHover(hover === id ? null : hover)}
      onClick={(event) => { event.stopPropagation(); onOpen(); }}
      data-selection-pane={row.key}
      style={{
        ...MENU_BUTTON_STYLE,
        display: 'flex', alignItems: 'center', gap: 8, padding: `7px ${MENU_ROW_PAD_X}px`, cursor: 'pointer',
        background: rowBackground(id, hover, false),
      }}
    >
      <span style={{ fontSize: 13, color: 'var(--proto-ink-2)', flex: 'none' }}>
        {row.label}
      </span>
      <span style={{
        marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0,
        fontSize: 12.5, color: 'var(--proto-muted)',
      }}>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.value}</span>
        <Caret />
      </span>
    </button>
  );
}

function BackRow({ title, onBack, hover, setHover }: {
  title: string;
  onBack: () => void;
} & HoverProps): JSX.Element {
  // The rule under the back row is its own divider rather than the row's border, so it is inset
  // like every other rule and the row's hover tint keeps its rounded corners.
  return (
    <>
      <button
        type="button"
        className={MENU_FOCUS}
        onMouseEnter={() => setHover('back')}
        onMouseLeave={() => setHover(hover === 'back' ? null : hover)}
        onClick={(event) => { event.stopPropagation(); onBack(); }}
        data-selection-back="true"
        style={{
          ...MENU_BUTTON_STYLE,
          display: 'flex', alignItems: 'center', gap: 7, padding: `6px ${MENU_ROW_PAD_X}px`, cursor: 'pointer',
          background: rowBackground('back', hover, false),
        }}
      >
        <span style={{ display: 'inline-flex', color: 'var(--proto-muted)' }}><Caret back /></span>
        <span style={{ font: '550 12px/1.4 var(--font-ui)', color: 'var(--proto-muted)' }}>
          {title}
        </span>
      </button>
      <Divider />
    </>
  );
}

/** A sub-heading inside a pane — a backend or an endpoint — drawn as a labelled rule so it reads as
 *  a break between rows rather than as one more row. */
function GroupLabel({ text }: { text: string }): JSX.Element {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6, padding: `6px ${MENU_ROW_PAD_X}px 2px`,
      font: '400 11.5px/1.4 var(--font-ui)', color: 'var(--proto-faint)',
    }}>
      <span style={{ flex: 'none' }}>{text}</span>
      <span style={{ flex: 1, height: 1, background: 'var(--proto-line)' }} />
    </div>
  );
}

export type { SelectionPane };
export interface SelectionMenuProps {
  favorites: ModelOption[];
  modelGroups: Array<{ group: string; backend: string; options: ModelOption[] }>;
  thinking: ThinkingOption[];
  modes: ModeOption[];
  rootRows: SelectionRootRow[];
  modelsReady: boolean;
  pane: SelectionPane;
  setPane: (pane: SelectionPane) => void;
  onClose: () => void;
  onPickFavorite: (option: ModelOption) => void;
  onPickModel: (option: ModelOption) => void;
  onToggleFavorite: (option: ModelOption) => void;
  onPickThinking: (level: string | null) => void;
  onPickMode: (mode: string) => void;
}

function FavoriteRow({ option, onPick, hover, setHover }: { option: ModelOption; onPick: () => void } & HoverProps) {
  const L = useVocab();
  const id = `favorite:${modelKey(option.selection)}`;
  return (
    <button type="button" disabled={option.disabled} aria-pressed={option.active} className={MENU_FOCUS}
      data-selection-row={id} title={option.disabled ? L.wbModelCrossBackend : option.id}
      onMouseEnter={() => setHover(id)} onMouseLeave={() => setHover(null)}
      onClick={(event) => { event.stopPropagation(); onPick(); }}
      style={{ ...MENU_BUTTON_STYLE, display: 'flex', gap: 8, alignItems: 'center', padding: `7px ${MENU_ROW_PAD_X}px`,
        opacity: option.disabled ? 0.45 : 1, cursor: option.disabled ? 'default' : 'pointer', background: rowBackground(id, hover, option.active) }}>
      <span style={{
        fontSize: 13, fontWeight: option.active ? 550 : 400, color: option.active ? 'var(--proto-ink)' : 'var(--proto-ink-2)',
        flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{modelLabel(option.selection)}</span>
      <span style={{ fontSize: 12.5, color: 'var(--proto-muted)', flex: 'none', textAlign: 'right' }}>{option.selection.thinking ?? L.default}</span>
      <span style={{ width: 12, flex: 'none', color: 'var(--proto-ink)', fontSize: 12, fontWeight: 700 }}>{option.active ? '✓' : ''}</span>
    </button>
  );
}

function SelectionHeader({ onClose }: { onClose: () => void }) {
  const L = useVocab();
  const { openSection } = useSettings();
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
    <SectionTitle text={L.wbFavorites} />
    <button type="button" className={MENU_FOCUS} data-selection-settings
      onClick={(event) => { event.stopPropagation(); onClose(); openSection('models'); }}
      style={{ border: 0, background: 'transparent', color: 'var(--proto-accent)',
        font: '400 12px/1.4 var(--font-ui)', padding: `6px ${MENU_ROW_PAD_X}px 3px`, cursor: 'pointer' }}>
      {L.wbModelSettings}
    </button>
  </div>;
}

function RootPane({ props, shared }: { props: SelectionMenuProps; shared: HoverProps }) {
  const L = useVocab();
  const groups = groupModelOptions(props.favorites, props.favorites.find((o) => o.active)?.backend ?? '');
  return <>
    <SelectionHeader onClose={props.onClose} />
    {groups.map((group) => <div key={`${group.backend}:${group.group}`}>
      <GroupLabel text={group.group} />
      {group.options.map((option) => <FavoriteRow key={modelKey(option.selection)} option={option} onPick={() => props.onPickFavorite(option)} {...shared} />)}
    </div>)}
    {!props.favorites.length && <Note text={L.wbFavoritesEmpty} />}
    <Divider />
    {props.rootRows.map((row) => <DrillRow key={row.key} row={row} onOpen={() => props.setPane(row.key)} {...shared} />)}
  </>;
}

function CatalogRow({ option, props, shared }: { option: ModelOption; props: SelectionMenuProps; shared: HoverProps }) {
  const L = useVocab();
  return <div style={{ display: 'flex', alignItems: 'center' }}>
    <MenuRow id={`model:${modelKey(option.selection)}`} label={option.id} active={option.active}
      disabled={option.disabled} onPick={() => props.onPickModel(option)} {...shared} />
    <button type="button" className={MENU_FOCUS} aria-pressed={option.favorite}
      aria-label={`${option.favorite ? L.wbRemoveFavorite : L.wbAddFavorite}: ${option.id}`}
      onClick={(event) => { event.stopPropagation(); props.onToggleFavorite(option); }}
      style={{ border: 0, background: 'transparent', color: option.favorite ? 'var(--proto-ink)' : 'var(--proto-faint)', padding: '5px 9px', cursor: 'pointer' }}>
      {option.favorite ? '★' : '☆'}
    </button>
  </div>;
}

function ModelPane({ props, shared }: { props: SelectionMenuProps; shared: HoverProps }) {
  const L = useVocab();
  const [filter, setFilter] = useState('');
  const groups = props.modelGroups.map((group) => ({ ...group,
    options: group.options.filter((option) => matchesModelFilter(option.id, filter)),
  })).filter((group) => group.options.length);
  return <>
    <BackRow title={L.wbAllModels} onBack={() => props.setPane('root')} {...shared} />
    <div style={{ padding: '4px 0' }} onClick={(event) => event.stopPropagation()}>
      <input data-selection-filter="model" aria-label={L.wbFilterModels} placeholder={L.wbFilterModels}
        value={filter} onChange={(event) => setFilter(event.target.value)} className={MENU_FOCUS}
        style={{ width: '100%', boxSizing: 'border-box', font: '400 12.5px var(--font-ui)', color: 'var(--proto-ink)', background: 'var(--material-inset-bg)', border: '1px solid var(--proto-line)', borderRadius: 'var(--r-chip)', padding: `5px ${MENU_ROW_PAD_X}px` }} />
    </div>
    {groups.map((group) => <div key={`${group.backend}:${group.group}`}>
      <GroupLabel text={group.group} />
      {group.options.map((option) => <CatalogRow key={modelKey(option.selection)} option={option} props={props} shared={shared} />)}
    </div>)}
    {!props.modelsReady && <Note text={L.wbModelsPending} />}
  </>;
}

function DetailPane({ props, shared }: { props: SelectionMenuProps; shared: HoverProps }) {
  const L = useVocab();
  const thinking = props.pane === 'thinking';
  return <>
    <BackRow title={thinking ? L.wbThinking : L.wbRoute} onBack={() => props.setPane('root')} {...shared} />
    {thinking ? props.thinking.map((option) => <MenuRow key={option.level ?? 'default'} id={`thinking:${option.level ?? 'default'}`}
      label={option.level ?? L.wbThinkingDefault} active={option.active} onPick={() => props.onPickThinking(option.level)} {...shared} />)
      : props.modes.map((option) => <MenuRow key={option.mode} id={`mode:${option.mode}`} label={option.mode}
        active={option.active} onPick={() => props.onPickMode(option.mode)} {...shared} />)}
  </>;
}

export function SelectionMenu(props: SelectionMenuProps): JSX.Element {
  const [hover, setHover] = useState<string | null>(null);
  const shared = { hover, setHover };
  return <MenuCard kind="selection" level={props.pane} minWidth={336} className="selection-menu">
    <PaneMotion pane={props.pane}>
      {props.pane === 'root' && <RootPane props={props} shared={shared} />}
      {props.pane === 'model' && <ModelPane props={props} shared={shared} />}
      {(props.pane === 'thinking' || props.pane === 'mode') && <DetailPane props={props} shared={shared} />}
    </PaneMotion>
  </MenuCard>;
}
