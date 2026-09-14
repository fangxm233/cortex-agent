import { useState } from 'react';
import { useVocab } from '@/i18n';
import type { ModeOption, ModelOption, ProfileOption, ThinkingOption } from './selection-menu';

// The composer's engine picker, anchored above or below its position:relative chip.
//
// Sections in the order the product reads: PROFILE first (it is the base — it decides the backend,
// the route and the fallback chain), then MODEL, THINKING and ROUTE as overrides on top of it.
// Each override section carries a "follow the profile" row so a choice can be taken back, which is
// the only way to tell "I picked opus" from "the profile happens to say opus".
//
// ROUTE is the endpoint's billing lane (anthropic `plan` vs `api`). An endpoint that declares only
// one lane offers no choice, so `buildModeOptions` returns nothing and the section disappears.

const mono = "'IBM Plex Mono',monospace";

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

function Row({
  id, label, sub, active, disabled, title, onPick, hover, setHover,
}: {
  id: string;
  label: string;
  sub?: string | null;
  active: boolean;
  disabled?: boolean;
  title?: string;
  onPick: () => void;
  hover: string | null;
  setHover: (value: string | null) => void;
}): JSX.Element {
  return (
    <div
      onMouseEnter={() => setHover(id)}
      onMouseLeave={() => setHover(hover === id ? null : hover)}
      onClick={(event) => { event.stopPropagation(); if (!disabled) onPick(); }}
      data-selection-row={id}
      data-disabled={disabled ? 'true' : undefined}
      title={title}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.42 : 1,
        background: disabled
          ? 'transparent'
          : hover === id ? 'var(--proto-gray)' : active ? 'var(--proto-accent-bg)' : 'transparent',
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

export interface SelectionMenuProps {
  profiles: ProfileOption[];
  modelGroups: Array<{ group: string; backend: string; options: ModelOption[] }>;
  thinking: ThinkingOption[];
  /** The billing lanes of the endpoint the session currently leaves through. Empty = no choice. */
  modes: ModeOption[];
  /** What the profile itself declares — shown on the "follow the profile" rows so the user can see
   *  what taking the override back would mean. */
  profileModel: string | null;
  profileThinking: string | null;
  profileMode: string | null;
  modelOverridden: boolean;
  thinkingOverridden: boolean;
  modeOverridden: boolean;
  /** False while PI is configured but has not reported its models yet. */
  modelsReady: boolean;
  onPickProfile: (name: string) => void;
  onPickModel: (option: ModelOption | null) => void;
  onPickThinking: (level: string | null) => void;
  onPickMode: (mode: string | null) => void;
  placement?: 'above' | 'below';
  align?: 'left' | 'right';
}

export function SelectionMenu({
  profiles, modelGroups, thinking, modes, profileModel, profileThinking, profileMode,
  modelOverridden, thinkingOverridden, modeOverridden, modelsReady,
  onPickProfile, onPickModel, onPickThinking, onPickMode,
  placement = 'above', align = 'right',
}: SelectionMenuProps): JSX.Element {
  const L = useVocab();
  const [hover, setHover] = useState<string | null>(null);
  const shared = { hover, setHover };

  return (
    <div
      data-menu="selection"
      style={{
        position: 'absolute',
        ...(align === 'right' ? { right: 0 } : { left: 0 }),
        ...(placement === 'above' ? { bottom: 36 } : { top: 36 }),
        background: 'var(--proto-card)',
        border: '1px solid var(--proto-line)',
        borderRadius: 8,
        boxShadow: 'var(--shadow-menu)',
        zIndex: 59,
        minWidth: 232,
        maxHeight: 420,
        overflowY: 'auto',
      }}
    >
      <SectionTitle text={L.wbProfile} />
      {profiles.map((option) => (
        <Row
          key={`profile:${option.name}`}
          id={`profile:${option.name}`}
          label={option.name}
          sub={option.sub}
          active={option.active}
          disabled={option.disabled}
          title={option.disabled ? `${L.wbSwitchTo} ${option.backend} ${L.wbNeedsNewSession}` : undefined}
          onPick={() => onPickProfile(option.name)}
          {...shared}
        />
      ))}

      <SectionTitle text={L.wbModel} />
      <Row
        id="model:follow"
        label={L.wbFollowProfile}
        sub={profileModel}
        active={!modelOverridden}
        onPick={() => onPickModel(null)}
        {...shared}
      />
      {modelGroups.map((group) => (
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
              disabled={option.disabled}
              title={option.disabledReason === 'cross-backend'
                ? `${L.wbSwitchTo} ${option.backend} ${L.wbNeedsNewSession}`
                : option.disabledReason === 'no-profile' ? L.wbNoProfileForBackend : undefined}
              onPick={() => onPickModel(option)}
              {...shared}
            />
          ))}
        </div>
      ))}
      {!modelsReady && (
        <div style={{ font: `400 9px ${mono}`, color: 'var(--proto-muted-3)', padding: '4px 8px 6px' }}>
          {L.wbModelsPending}
        </div>
      )}

      {thinking.length > 0 && (
        <>
          <SectionTitle text={L.wbThinking} />
          <Row
            id="thinking:follow"
            label={L.wbFollowProfile}
            sub={profileThinking}
            active={!thinkingOverridden}
            onPick={() => onPickThinking(null)}
            {...shared}
          />
          {thinking.map((option) => (
            <Row
              key={`thinking:${option.level}`}
              id={`thinking:${option.level}`}
              label={option.level}
              active={option.active}
              onPick={() => onPickThinking(option.level)}
              {...shared}
            />
          ))}
        </>
      )}

      {modes.length > 0 && (
        <>
          <SectionTitle text={L.wbRoute} />
          <Row
            id="mode:follow"
            label={L.wbFollowProfile}
            sub={profileMode}
            active={!modeOverridden}
            onPick={() => onPickMode(null)}
            {...shared}
          />
          {modes.map((option) => (
            <Row
              key={`mode:${option.mode}`}
              id={`mode:${option.mode}`}
              label={option.mode}
              active={option.active}
              onPick={() => onPickMode(option.mode)}
              {...shared}
            />
          ))}
        </>
      )}
    </div>
  );
}
