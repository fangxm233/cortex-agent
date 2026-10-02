// Run from web/: pnpm exec vite --host 127.0.0.1 --port 5187 --strictPort
// Open /src/features/session/transcript/__fixtures__/background-subagent.html.
// Default mode is controlled RPC only, NOT production/server-to-UI end-to-end validation.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createTrpcClient, TRPCProvider, type RemoteConfig } from '@/lib/trpc';
import { LiveEventsProvider } from '@/features/live/LiveEventsProvider';
import { LangProvider } from '@/i18n';
import { BackgroundSubagentFixture, BackgroundSubagentHarness, BackgroundTranscript, childMessage } from './BackgroundSubagentHarness';
import '@/index.css';

const root = createRoot(document.getElementById('root')!);
let fixture = new BackgroundSubagentFixture();
let generation = 0;
let sequence = 2;

function laterOutput(notify = true): void {
  fixture.append(childMessage(sequence++, { type: 'tool', toolName: 'Grep', toolInput: `late-pattern-${sequence}` }), notify);
  fixture.append(childMessage(sequence++, { text: `Later child prose ${sequence}.` }), notify);
}

function debugResult(): void {
  fixture.detail.messages[0].debug = {
    toolInput: { path: 'early.ts' }, toolResult: { content: 'DEBUG result saved after tool completion', isError: false },
  };
  fixture.emit('session.debug.updated');
}

function Controls(): JSX.Element {
  return <nav style={{ display: 'flex', flexWrap: 'wrap', gap: 12, padding: 12 }}>
    <button onClick={() => fixture.emit('session.status', { running: false })}>Parent idle</button>
    <button onClick={() => laterOutput()}>Later tool + prose</button>
    <button onClick={() => fixture.append(childMessage(sequence++, { text: 'Final child prose.', subagentEnded: 'completed' }))}>Complete child</button>
    <button onClick={debugResult}>DEBUG result</button>
    <button onClick={() => { laterOutput(false); fixture.reconnect(); }}>Miss events + reconnect</button>
    <button onClick={refresh}>Remount with cache</button>
    <button onClick={() => fixture.holdNextDetail()}>Hold next detail fetch</button>
    <button onClick={() => fixture.releaseFirstDetail()}>Release old detail response</button>
    <button onClick={reset}>Reset fixture</button>
  </nav>;
}

function renderFixture(): void {
  root.render(<main style={{ maxWidth: 900, margin: '24px auto' }}>
    <h1>Controlled RPC fixture — not backend end-to-end</h1>
    <p>Expand the child first. Parent running is false; controls inject query data and live hints.</p>
    <BackgroundSubagentHarness key={generation} fixture={fixture}><Controls /></BackgroundSubagentHarness>
  </main>);
}

function refresh(): void { generation++; renderFixture(); }
function reset(): void {
  fixture.queryClient.clear();
  fixture = new BackgroundSubagentFixture();
  sequence = 2;
  refresh();
}

// Opt-in combined verification: start an ISOLATED backend HTTP/SSE fixture, then call
// backgroundSubagent.connect('synthetic-session-id', { serverUrl: 'http://127.0.0.1:PORT', token: 'fixture-token' }).
// This bypasses the fake link and uses the real HTTP queries + subscription, with no UI mocks.
// Do not point this at production. Passing no config uses Vite's existing /trpc proxy.
function connect(sessionId: string, config?: RemoteConfig): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = createTrpcClient(config);
  root.render(<main style={{ maxWidth: 900, margin: '24px auto' }}>
    <h1>External HTTP/SSE fixture — verify backend provenance separately</h1>
    <QueryClientProvider client={queryClient}><TRPCProvider trpcClient={client} queryClient={queryClient}>
      <LangProvider><LiveEventsProvider><BackgroundTranscript sessionId={sessionId} /></LiveEventsProvider></LangProvider>
    </TRPCProvider></QueryClientProvider>
  </main>);
}

const api = { get fixture() { return fixture; }, childMessage, laterOutput, debugResult, refresh, reset, connect };
declare global { interface Window { backgroundSubagent: typeof api } }
window.backgroundSubagent = api;
renderFixture();
