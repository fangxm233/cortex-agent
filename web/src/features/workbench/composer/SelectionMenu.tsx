// input:  React, selection options, MenuChrome
// output: SelectionMenu, SelectionPane, SelectionMenuProps
// pos:    Engine picker with readable keyboard-accessible rows
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { useState } from 'react';
import { useVocab } from '@/i18n';
import type {
  ModeOption, ModelOption, ProfileOption, SelectionRootRow, ThinkingOption,
} from '@/features/session/list/selection-menu';
import {
  Divider, MenuCard, MenuRow, MONO as mono, Note, rowBackground, SectionTitle, type HoverProps,
  MENU_BUTTON_STYLE, MENU_FOCUS,
} from '@/design/MenuChrome';

// The composer's engine picker, anchored above or below its position:relative chip.
//
// Two levels, because the flat list had grown to ~46 rows on a host with three gateway endpoints.
// The ROOT is the profile list — a profile is the whole engine (backend, route, fallback chain) and
// switching one is the common move, so it stays one click away — plus one collapsed row per
// override, each showing the value that is EFFECTIVE right now rather than "follow profile". Those
// rows drill into a pane of their own: model, thinking level, and the endpoint's billing route where
// it offers more than one (`buildModeOptions` returns nothing when it does not, and the row goes).
//
// It is the PROFILE and its refinements, and nothing else. Which environment the conversation runs
// in is a separate axis with a chip and a menu of its own (AgentMenu), because an agent is not one
// more thing a profile can be overridden with.
//
// Nothing unpickable is drawn here: a live conversation cannot change backend, so the other
// backend's models are not offered at all — one footer line reports how many were held back and
// why, which is the whole of what a screen of greyed-out rows used to say. (The agent menu is the
// list short enough to do the opposite, and says so itself.)

/** Above this many rows, a pane earns a filter box — a claude endpoint alone lists 17 ids. */
const FILTER_THRESHOLD = 10;

/** A collapsed override on the root: label, the value in force, and a dot when that value is the
 *  session's own choice rather than the profile's. */
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
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', cursor: 'pointer',
        background: rowBackground(id, hover, false),
      }}
    >
      <span style={{
        font: `600 11px ${mono}`, letterSpacing: '0.05em', textTransform: 'uppercase',
        color: 'var(--proto-muted)', flex: 'none',
      }}>
        {row.label}
      </span>
      <span style={{
        marginLeft: 'auto', font: `500 11px ${mono}`, minWidth: 0,
        color: row.overridden ? 'var(--proto-accent)' : 'var(--proto-ink)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {row.value}
      </span>
      {row.overridden && (
        <span style={{ color: 'var(--proto-accent)', fontSize: 9, flex: 'none' }}>•</span>
      )}
      <span style={{ color: 'var(--proto-muted)', fontSize: 11, flex: 'none' }}>›</span>
    </button>
  );
}

function BackRow({ title, onBack, hover, setHover }: {
  title: string;
  onBack: () => void;
} & HoverProps): JSX.Element {
  return (
    <button
      type="button"
      className={MENU_FOCUS}
      onMouseEnter={() => setHover('back')}
      onMouseLeave={() => setHover(hover === 'back' ? null : hover)}
      onClick={(event) => { event.stopPropagation(); onBack(); }}
      data-selection-back="true"
      style={{
        ...MENU_BUTTON_STYLE,
        display: 'flex', alignItems: 'center', gap: 7, padding: '6px 8px', cursor: 'pointer',
        borderBottom: '1px solid var(--proto-line)',
        background: rowBackground('back', hover, false),
      }}
    >
      <span style={{ color: 'var(--proto-accent)', fontSize: 12, fontWeight: 700 }}>‹</span>
      <span style={{
        font: `600 11px ${mono}`, letterSpacing: '0.05em', textTransform: 'uppercase',
        color: 'var(--proto-muted)',
      }}>
        {title}
      </span>
    </button>
  );
}

export type SelectionPane = 'root' | 'model' | 'thinking' | 'mode';

export interface SelectionMenuProps {
  /** Already filtered to what this conversation can move to. */
  profiles: ProfileOption[];
  /** How many profiles were held back, and the backend they run on. */
  hiddenProfiles: number;
  hiddenProfileBackend: string | null;
  modelGroups: Array<{ group: string; backend: string; options: ModelOption[] }>;
  hiddenModelsCrossBackend: number;
  hiddenModelsBackend: string | null;
  hiddenModelsNoProfile: number;
  thinking: ThinkingOption[];
  /** The billing lanes of the endpoint the session currently leaves through. Empty = no choice. */
  modes: ModeOption[];
  /** The collapsed override rows of the root, in order. */
  rootRows: SelectionRootRow[];
  /** What the profile itself declares — shown on the "follow the profile" rows so the user can see
   *  what taking the override back would mean. */
  profileModel: string | null;
  profileThinking: string | null;
  profileMode: string | null;
  modelOverridden: boolean;
  thinkingOverridden: boolean;
  modeOverridden: boolean;
  /** True when any override is in force — the root then offers to hand them all back at once. */
  anyOverridden: boolean;
  /** False while PI is configured but has not reported its models yet. */
  modelsReady: boolean;
  pane: SelectionPane;
  setPane: (pane: SelectionPane) => void;
  onPickProfile: (name: string) => void;
  onPickModel: (option: ModelOption | null) => void;
  onPickThinking: (level: string | null) => void;
  onPickMode: (mode: string | null) => void;
  onClearAll: () => void;
  placement?: 'above' | 'below';
  align?: 'left' | 'right';
}

/** The one line that replaces a screenful of greyed-out rows. */
function crossBackendNote(template: string, count: number, backend: string | null): string | null {
  if (count === 0) return null;
  return template.replace('{n}', String(count)).replace('{backend}', backend ?? '');
}

function RootPane({ props, shared }: { props: SelectionMenuProps; shared: HoverProps }): JSX.Element {
  const L = useVocab();
  const note = crossBackendNote(L.wbHiddenProfiles, props.hiddenProfiles, props.hiddenProfileBackend);
  return (
    <>
      <SectionTitle text={L.wbProfile} />
      {props.profiles.map((option) => (
        <MenuRow
          key={`profile:${option.name}`}
          id={`profile:${option.name}`}
          label={option.name}
          sub={option.sub}
          active={option.active}
          onPick={() => props.onPickProfile(option.name)}
          {...shared}
        />
      ))}
      {note ? <Note text={note} /> : null}
      <Divider />
      {props.rootRows.map((row) => (
        <DrillRow key={row.key} row={row} onOpen={() => props.setPane(row.key)} {...shared} />
      ))}
      {props.anyOverridden && (
        <>
          <Divider />
          <MenuRow
            id="selection:clear"
            label={L.wbFollowAll}
            active={false}
            onPick={props.onClearAll}
            {...shared}
          />
        </>
      )}
    </>
  );
}

function ModelPane({ props, shared }: { props: SelectionMenuProps; shared: HoverProps }): JSX.Element {
  const L = useVocab();
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();
  const groups = props.modelGroups
    .map((group) => ({
      ...group,
      options: needle
        ? group.options.filter((option) => option.id.toLowerCase().includes(needle))
        : group.options,
    }))
    .filter((group) => group.options.length > 0);
  const total = props.modelGroups.reduce((sum, group) => sum + group.options.length, 0);
  const crossNote = crossBackendNote(
    L.wbHiddenModels, props.hiddenModelsCrossBackend, props.hiddenModelsBackend,
  );
  const noProfileNote = props.hiddenModelsNoProfile > 0
    ? L.wbHiddenNoProfile.replace('{n}', String(props.hiddenModelsNoProfile))
    : null;

  return (
    <>
      <BackRow title={L.wbModel} onBack={() => props.setPane('root')} {...shared} />
      {total > FILTER_THRESHOLD && (
        <div style={{ padding: '6px 8px 4px' }} onClick={(event) => event.stopPropagation()}>
          <input
            data-selection-filter="model"
            aria-label={L.wbFilterModels}
            className={MENU_FOCUS}
            autoFocus
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={L.wbFilterModels}
            style={{
              width: '100%', boxSizing: 'border-box', font: `400 11px ${mono}`,
              color: 'var(--proto-ink)', background: 'var(--material-inset-bg)',
              border: '1px solid var(--proto-line)', borderRadius: 'var(--r-control)', padding: '4px 7px',
            }}
          />
        </div>
      )}
      <MenuRow
        id="model:follow"
        label={L.wbFollowProfile}
        sub={props.profileModel}
        active={!props.modelOverridden}
        onPick={() => props.onPickModel(null)}
        {...shared}
      />
      {groups.map((group) => (
        <div key={`group:${group.group}`}>
          <div style={{
            font: `500 11px ${mono}`, color: 'var(--proto-muted)', padding: '4px 8px 2px',
          }}>
            {group.group}
          </div>
          {group.options.map((option) => (
            <MenuRow
              key={`model:${option.backend}:${option.provider ?? ''}:${option.id}`}
              id={`model:${option.backend}:${option.provider ?? ''}:${option.id}`}
              label={option.id}
              active={option.active}
              onPick={() => props.onPickModel(option)}
              {...shared}
            />
          ))}
        </div>
      ))}
      {!props.modelsReady && <Note text={L.wbModelsPending} />}
      {crossNote ? <Note text={crossNote} /> : null}
      {noProfileNote ? <Note text={noProfileNote} /> : null}
    </>
  );
}

function ThinkingPane({ props, shared }: { props: SelectionMenuProps; shared: HoverProps }): JSX.Element {
  const L = useVocab();
  return (
    <>
      <BackRow title={L.wbThinking} onBack={() => props.setPane('root')} {...shared} />
      <MenuRow
        id="thinking:follow"
        label={L.wbFollowProfile}
        sub={props.profileThinking}
        active={!props.thinkingOverridden}
        onPick={() => props.onPickThinking(null)}
        {...shared}
      />
      {props.thinking.map((option) => (
        <MenuRow
          key={`thinking:${option.level}`}
          id={`thinking:${option.level}`}
          label={option.level}
          active={option.active}
          onPick={() => props.onPickThinking(option.level)}
          {...shared}
        />
      ))}
    </>
  );
}

function ModePane({ props, shared }: { props: SelectionMenuProps; shared: HoverProps }): JSX.Element {
  const L = useVocab();
  return (
    <>
      <BackRow title={L.wbRoute} onBack={() => props.setPane('root')} {...shared} />
      <MenuRow
        id="mode:follow"
        label={L.wbFollowProfile}
        sub={props.profileMode}
        active={!props.modeOverridden}
        onPick={() => props.onPickMode(null)}
        {...shared}
      />
      {props.modes.map((option) => (
        <MenuRow
          key={`mode:${option.mode}`}
          id={`mode:${option.mode}`}
          label={option.mode}
          active={option.active}
          onPick={() => props.onPickMode(option.mode)}
          {...shared}
        />
      ))}
    </>
  );
}

export function SelectionMenu(props: SelectionMenuProps): JSX.Element {
  const [hover, setHover] = useState<string | null>(null);
  const shared = { hover, setHover };
  const { pane, placement, align } = props;

  return (
    <MenuCard kind="selection" level={pane} placement={placement} align={align}>
      {pane === 'root' && <RootPane props={props} shared={shared} />}
      {pane === 'model' && <ModelPane props={props} shared={shared} />}
      {pane === 'thinking' && <ThinkingPane props={props} shared={shared} />}
      {pane === 'mode' && <ModePane props={props} shared={shared} />}
    </MenuCard>
  );
}
