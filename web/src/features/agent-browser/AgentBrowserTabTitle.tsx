import type { CSSProperties } from 'react';
import { useVocab } from '@/i18n';
import { pageHost } from './stream-model';
import { useAgentBrowsers } from './useAgentBrowsers';

const WHERE: CSSProperties = { marginLeft: 6, color: 'var(--proto-faint)', fontWeight: 400 };

/** A dock tab's label: what it is, then the host the agent's page is on — read off the shared list,
 *  which the open view keeps fresh. */
export function AgentBrowserTabTitle({ sessionId }: { sessionId: string }): JSX.Element {
  const L = useVocab();
  const { data } = useAgentBrowsers();
  const host = pageHost(data?.find((s) => s.sessionId === sessionId)?.url);
  return (
    <>
      {L.abTitle}
      {host && <span data-agent-browser-host="" style={WHERE}>{host}</span>}
    </>
  );
}
