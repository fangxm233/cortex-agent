import { useState } from 'react';
import { useVocab } from '@/i18n';
import type {
  AgentOption, ModeOption, ModelOption, ProfileOption, SelectionRootRow, ThinkingOption,
} from './selection-menu';

// The composer's engine picker, anchored above or below its position:relative chip.
//
// Two levels, because the flat list had grown to ~46 rows on a host with three gateway endpoints.
// The ROOT is the profile list — a profile is the whole engine (backend, route, fallback chain) and
// switching one is the common move, so it stays one click away — plus one collapsed row per
// override, each showing the value that is EFFECTIVE right now rather than "follow profile". Those
// rows drill into a pane of their own: model, thinking level, and the endpoint's billing route where
// it offers more than one (`buildModeOptions` returns nothing when it does not, and the row goes).
//
// Nothing unpickable is drawn, with one deliberate exception. A live conversation cannot change
// backend, so the other backend's models are not offered at all — one footer line reports how many
// were held back and why, which is the whole of what the greyed-out rows used to say. The agent
// pane keeps its greyed rows: there are a handful of environments, and naming the one that needs a
// fresh conversation is worth more than counting it.

const mono = "'IBM Plex Mono',monospace";

/** Above this many rows, a pane earns a filter box — a claude endpoint alone lists 17 ids. */
const FILTER_THRESHOLD = 10;

function SectionTitle({ text }: { text: string }): JSX.Element {
  return (
    <div style={{
      font: `600 8.5px ${mono}`, letterSpacing: '0.08em', textTransform: 'uppercase',
      color: 'var(--proto-muted-3)', padding: '6px 8px 3px',
    }}>
      {text}
    </div>
  );
}

function Note({ text }: { text: string }): JSX.Element {
  return (
    <div style={{
      font: `400 9px ${mono}`, color: 'var(--proto-muted-3)', padding: '5px 8px 6px', lineHeight: 1.5,
    }}>
      {text}
    </div>
  );
}

function Divider(): JSX.Element {
  return <div style={{ height: 1, background: 'var(--proto-line)', margin: '5px 0' }} />;
}

interface HoverProps {
  hover: string | null;
  setHover: (value: string | null) => void;
}

function rowBackground(id: string, hover: string | null, active: boolean): string {
  if (hover === id) return 'var(--proto-gray)';
  return active ? 'var(--proto-accent-bg)' : 'transparent';
}

function Row({
  id, label, sub, active, disabled = false, onPick, hover, setHover,
}: {
  id: string;
  label: string;
  sub?: string | null;
  active: boolean;
  /** Drawn but not clickable — see the agent pane, the one list short enough to say why. */
  disabled?: boolean;
  onPick: () => void;
} & HoverProps): JSX.Element {
  return (
    <div
      onMouseEnter={() => setHover(disabled ? null : id)}
      onMouseLeave={() => setHover(hover === id ? null : hover)}
      onClick={(event) => { event.stopPropagation(); if (!disabled) onPick(); }}
      data-selection-row={id}
      data-disabled={disabled ? 'true' : undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px',
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1,
        background: rowBackground(id, hover, active),
      }}
    >
      <span style={{ font: `600 10px ${mono}`, color: 'var(--proto-ink)' }}>{label}</span>
      {sub ? <span style={{ font: `400 9px ${mono}`, color: 'var(--proto-muted-3)' }}>{sub}</span> : null}
      {active && (
        <span style={{ marginLeft: 'auto', color: 'var(--proto-accent)', fontSize: 9, fontWeight: 700 }}>✓</span>
      )}
    </div>
  );
}

/** A collapsed override on the root: label, the value in force, and a dot when that value is the
 *  session's own choice rather than the profile's. */
function DrillRow({ row, onOpen, hover, setHover }: {
  row: SelectionRootRow;
  onOpen: () => void;
} & HoverProps): JSX.Element {
  const id = `pane:${row.key}`;
  return (
    <div
      onMouseEnter={() => setHover(id)}
      onMouseLeave={() => setHover(hover === id ? null : hover)}
      onClick={(event) => { event.stopPropagation(); onOpen(); }}
      data-selection-pane={row.key}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', cursor: 'pointer',
        background: rowBackground(id, hover, false),
      }}
    >
      <span style={{
        font: `600 8.5px ${mono}`, letterSpacing: '0.08em', textTransform: 'uppercase',
        color: 'var(--proto-muted-3)', flex: 'none',
      }}>
        {row.label}
      </span>
      <span style={{
        marginLeft: 'auto', font: `500 10px ${mono}`, minWidth: 0,
        color: row.overridden ? 'var(--proto-accent)' : 'var(--proto-ink)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {row.value}
      </span>
      {row.overridden && (
        <span style={{ color: 'var(--proto-accent)', fontSize: 9, flex: 'none' }}>•</span>
      )}
      <span style={{ color: 'var(--proto-muted-3)', fontSize: 11, flex: 'none' }}>›</span>
    </div>
  );
}

function BackRow({ title, onBack, hover, setHover }: {
  title: string;
  onBack: () => void;
} & HoverProps): JSX.Element {
  return (
    <div
      onMouseEnter={() => setHover('back')}
      onMouseLeave={() => setHover(hover === 'back' ? null : hover)}
      onClick={(event) => { event.stopPropagation(); onBack(); }}
      data-selection-back="true"
      style={{
        display: 'flex', alignItems: 'center', gap: 7, padding: '6px 8px', cursor: 'pointer',
        borderBottom: '1px solid var(--proto-line)',
        background: rowBackground('back', hover, false),
      }}
    >
      <span style={{ color: 'var(--proto-accent)', fontSize: 12, fontWeight: 700 }}>‹</span>
      <span style={{
        font: `600 8.5px ${mono}`, letterSpacing: '0.08em', textTransform: 'uppercase',
        color: 'var(--proto-muted-3)',
      }}>
        {title}
      </span>
    </div>
  );
}

export type SelectionPane = 'root' | 'agent' | 'model' | 'thinking' | 'mode';

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
  /** The environments this host declares. Empty = the agent row is not drawn at all. */
  agents: AgentOption[];
  /** True when the session named an agent of its own rather than following the host default. */
  agentOverridden: boolean;
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
  /** `null` hands the conversation back to the host's default agent. */
  onPickAgent: (name: string | null) => void;
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
        <Row
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
          <Row
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
            autoFocus
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={L.wbFilterModels}
            style={{
              width: '100%', boxSizing: 'border-box', font: `400 10px ${mono}`,
              color: 'var(--proto-ink)', background: 'var(--proto-bg)',
              border: '1px solid var(--proto-line)', borderRadius: 6, padding: '4px 7px', outline: 'none',
            }}
          />
        </div>
      )}
      <Row
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
            font: `500 8.5px ${mono}`, color: 'var(--proto-muted-3)', padding: '4px 8px 2px',
          }}>
            {group.group}
          </div>
          {group.options.map((option) => (
            <Row
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

/** The environments. The one pane that DRAWS what it cannot offer: a handful of agents is not a
 *  screenful of models, and "creative exists, but you need a new conversation for it" is worth more
 *  than a footer counting rows the user never saw. */
function AgentPane({ props, shared }: { props: SelectionMenuProps; shared: HoverProps }): JSX.Element {
  const L = useVocab();
  return (
    <>
      <BackRow title={L.wbAgent} onBack={() => props.setPane('root')} {...shared} />
      <Row
        id="agent:default"
        label={L.wbAgentDefault}
        sub={L.wbAgentFollowDefault}
        active={!props.agentOverridden}
        onPick={() => props.onPickAgent(null)}
        {...shared}
      />
      {props.agents.map((option) => (
        <Row
          key={`agent:${option.name}`}
          id={`agent:${option.name}`}
          label={option.name}
          sub={option.disabled
            ? L.wbAgentCrossBackend.replace('{backend}', option.backend)
            : [option.profile, option.description].filter(Boolean).join(' · ') || null}
          active={option.active}
          disabled={option.disabled}
          onPick={() => props.onPickAgent(option.name)}
          {...shared}
        />
      ))}
    </>
  );
}

function ThinkingPane({ props, shared }: { props: SelectionMenuProps; shared: HoverProps }): JSX.Element {
  const L = useVocab();
  return (
    <>
      <BackRow title={L.wbThinking} onBack={() => props.setPane('root')} {...shared} />
      <Row
        id="thinking:follow"
        label={L.wbFollowProfile}
        sub={props.profileThinking}
        active={!props.thinkingOverridden}
        onPick={() => props.onPickThinking(null)}
        {...shared}
      />
      {props.thinking.map((option) => (
        <Row
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
      <Row
        id="mode:follow"
        label={L.wbFollowProfile}
        sub={props.profileMode}
        active={!props.modeOverridden}
        onPick={() => props.onPickMode(null)}
        {...shared}
      />
      {props.modes.map((option) => (
        <Row
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
  const { pane, placement = 'above', align = 'right' } = props;

  return (
    <div
      data-menu="selection"
      data-selection-level={pane}
      style={{
        position: 'absolute',
        ...(align === 'right' ? { right: 0 } : { left: 0 }),
        ...(placement === 'above' ? { bottom: 36 } : { top: 36 }),
        background: 'var(--proto-card)',
        border: '1px solid var(--proto-line)',
        borderRadius: 8,
        boxShadow: 'var(--shadow-menu)',
        zIndex: 59,
        minWidth: 244,
        maxHeight: 420,
        overflowY: 'auto',
      }}
    >
      {pane === 'root' && <RootPane props={props} shared={shared} />}
      {pane === 'agent' && <AgentPane props={props} shared={shared} />}
      {pane === 'model' && <ModelPane props={props} shared={shared} />}
      {pane === 'thinking' && <ThinkingPane props={props} shared={shared} />}
      {pane === 'mode' && <ModePane props={props} shared={shared} />}
    </div>
  );
}
