import { useState } from 'react';
import { useVocab } from '@/i18n';
import { agentRowSub, type AgentOption } from '@/features/session/list/selection-menu';
import { MenuCard, MenuRow, SectionTitle } from '@/design/MenuChrome';

export interface AgentMenuProps {
  /** Every environment this host declares, including the ones this conversation cannot take. */
  agents: AgentOption[];
  /** True when the session named an agent of its own rather than following the host default. */
  overridden: boolean;
  /** `null` hands the conversation back to the host's default agent. */
  onPick: (name: string | null) => void;
}

export function AgentMenu({ agents, overridden, onPick }: AgentMenuProps): JSX.Element {
  const L = useVocab();
  const [hover, setHover] = useState<string | null>(null);
  const shared = { hover, setHover };

  return (
    <MenuCard kind="agent" minWidth={236} align="left">
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
