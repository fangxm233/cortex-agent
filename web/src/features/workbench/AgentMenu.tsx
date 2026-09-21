import { useState } from 'react';
import { useVocab } from '@/i18n';
import { agentRowSub, type AgentOption } from './selection-menu';
import { MenuCard, MenuRow, SectionTitle } from './MenuChrome';

// The conversation's ENVIRONMENT picker: which agent template runs it — system prompt, tools,
// skills, rules.
//
// One flat level, because an agent is a whole answer with nothing to refine underneath it. That is
// also why it is not a row of the engine menu: a profile owns the model and may be overridden model
// by model, an agent owns what the session is *for*, and the server keeps the two apart
// (domain/agents/agent-switch.ts). They meet only at the backend, which is the one rule they share.
//
// This is the one list that DRAWS what it cannot offer. A live conversation may not change backend,
// so an agent pinning the other backend's profile is greyed with the backend named, rather than
// hidden behind a count the way seventeen unusable models are: there are a handful of environments,
// and "exists, but needs a new conversation" is the answer a user can act on.

export interface AgentMenuProps {
  /** Every environment this host declares, including the ones this conversation cannot take. */
  agents: AgentOption[];
  /** True when the session named an agent of its own rather than following the host default. */
  overridden: boolean;
  /** `null` hands the conversation back to the host's default agent. */
  onPick: (name: string | null) => void;
  placement?: 'above' | 'below';
  align?: 'left' | 'right';
}

export function AgentMenu({ agents, overridden, onPick, placement, align }: AgentMenuProps): JSX.Element {
  const L = useVocab();
  const [hover, setHover] = useState<string | null>(null);
  const shared = { hover, setHover };

  return (
    <MenuCard kind="agent" minWidth={236} placement={placement} align={align}>
      <SectionTitle text={L.wbAgent} />
      <MenuRow
        id="agent:default"
        label={L.wbAgentDefault}
        sub={L.wbAgentFollowDefault}
        active={!overridden}
        onPick={() => onPick(null)}
        {...shared}
      />
      {agents.map((option) => (
        <MenuRow
          key={`agent:${option.name}`}
          id={`agent:${option.name}`}
          label={option.name}
          sub={agentRowSub(option, L.wbAgentCrossBackend)}
          active={option.active}
          disabled={option.disabled}
          onPick={() => onPick(option.name)}
          {...shared}
        />
      ))}
    </MenuCard>
  );
}
