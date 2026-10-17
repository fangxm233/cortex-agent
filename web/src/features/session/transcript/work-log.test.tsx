import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import type { WaitpointInfo } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';
import { MChatStream } from '@/mobile/screens/MChatView';
import { ChatRows } from './MessageStream';
import { SessionStateLine, TranscriptStatusProvider } from './WorkLog';
import { setWorkLogMode } from './work-log-pref';
import { buildTranscriptRows } from './transcript-rows';
import type { ChatRow } from './chat-row';

vi.mock('@/lib/trpc', () => ({ useTRPCClient: () => ({}) }));

let mounted: ReactTestRenderer;
afterEach(() => {
  act(() => mounted?.unmount());
  setWorkLogMode('fold');
});

const turn: ChatRow[] = [
  { kind: 'user', text: 'why is thinking missing?', ts: '2026-10-17T16:26:00Z', turnIndex: 0 },
  { kind: 'tools', count: 7, calls: Array.from({ length: 7 }, () => ({ kind: 'Bash', input: 'rg thinking' })) },
  { kind: 'assistant', text: 'Checking the parser next.', streaming: false, ts: '2026-10-17T16:27:00Z' },
  { kind: 'tools', count: 2, calls: [{ kind: 'Read', input: '/repo/pi/event-parser.ts' }, { kind: 'Bash', input: 'ls' }] },
  { kind: 'assistant', text: 'The parser drops thinking_delta.', streaming: false, ts: '2026-10-17T16:34:05Z' },
];

function mount(node: JSX.Element): void {
  act(() => { mounted = create(<LangProvider>{node}</LangProvider>); });
}

const byAttr = (attr: string): ReactTestInstance[] =>
  mounted.root.findAll((n) => typeof n.type === 'string' && n.props[attr] !== undefined);
function text(node: ReactTestInstance): string {
  return node.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');
}

describe.each([['desktop', false], ['mobile', true]])('turn layout in the %s stream', (_name, mobile) => {
  const rows = (r: ChatRow[], live = false): JSX.Element => (mobile
    ? <MChatStream rows={r} group live={live} />
    : <ChatRows rows={r} group live={live} />);

  it('folds a finished turn into one work line above the answer', () => {
    mount(rows(turn));
    const summary = byAttr('data-work-summary')[0];
    expect(text(summary)).toContain('Worked for 8m 5s');
    expect(text(summary)).toContain('9 tool calls');
    expect(summary.props['aria-expanded']).toBe(false);
    expect(byAttr('data-work-log-body')).toHaveLength(0);
    // The answer stays out at full weight; the working note is folded away.
    const rendered = JSON.stringify(mounted.toJSON());
    expect(rendered).toContain('The parser drops thinking_delta.');
    expect(rendered).not.toContain('Checking the parser next.');
    expect(byAttr('data-assistant-turn-copy')).toHaveLength(1);
  });

  it('opens the work on demand, with working notes a step quieter', () => {
    mount(rows(turn));
    act(() => byAttr('data-work-summary')[0].props.onClick());
    expect(byAttr('data-work-log-body')).toHaveLength(1);
    const notes = byAttr('data-narration');
    expect(notes).toHaveLength(1);
    expect(text(notes[0])).toContain('Checking');
  });

  it('keeps the running turn open, with its trailing text as the answer so far', () => {
    const running: ChatRow[] = [...turn.slice(0, 4), { kind: 'assistant', text: 'Writing it up', streaming: true }];
    mount(rows(running, true));
    const summary = byAttr('data-work-summary')[0];
    expect(text(summary)).toContain('Working');
    expect(summary.props['aria-expanded']).toBe(true);
    expect(byAttr('data-work-live')).toHaveLength(1);
    expect(byAttr('data-narration')).toHaveLength(1);
    // The text being written stays outside the log, where it will remain once the turn ends.
    expect(byAttr('data-work-log-body')[0].findAll((n) => n.children.includes('Writing it up'))).toHaveLength(0);
    expect(JSON.stringify(mounted.toJSON())).toContain('Writing it up');
  });

  it('keeps every log open when the reader asked for that', () => {
    setWorkLogMode('expanded');
    mount(rows(turn));
    expect(byAttr('data-work-summary')[0].props['aria-expanded']).toBe(true);
  });
});

describe('waitpoints and background work', () => {
  const armed = { id: 'wp_1', label: 'train-run', state: 'armed' } as WaitpointInfo;
  const waitTurn: ChatRow[] = [
    { kind: 'user', text: 'train it', ts: '2026-10-17T16:00:00Z' },
    { kind: 'tools', count: 2, calls: [{ kind: 'Bash', input: 'sbatch train.sh' }, { kind: 'Bash', input: 'squeue' }] },
    { kind: 'waitpoint', wait: { label: 'train-run', intent: 'Wake me when training ends', ts: '2026-10-17T16:01:00Z' } },
    { kind: 'assistant', text: 'Started; I will report back when it finishes.', streaming: false, ts: '2026-10-17T16:01:10Z' },
  ];

  it('pins the armed waitpoint as the turn\'s outcome and says the session is waiting', () => {
    mount(
      <TranscriptStatusProvider backgroundRunning={false} waitpoints={[armed]}>
        <ChatRows rows={waitTurn} group />
        <SessionStateLine running={false} />
      </TranscriptStatusProvider>,
    );
    expect(byAttr('data-waitpoint').map((n) => n.props['data-waitpoint'])).toEqual(['armed']);
    const state = byAttr('data-session-state')[0];
    expect(state.props['data-session-state']).toBe('waiting');
    expect(text(state)).toContain('train-run');
  });

  it('reads a waitpoint that is no longer armed as settled, and says nothing at the tail', () => {
    mount(
      <TranscriptStatusProvider backgroundRunning={false} waitpoints={[]}>
        <ChatRows rows={waitTurn} group />
        <SessionStateLine running={false} />
      </TranscriptStatusProvider>,
    );
    expect(byAttr('data-waitpoint').map((n) => n.props['data-waitpoint'])).toEqual(['settled']);
    expect(byAttr('data-session-state')).toHaveLength(0);
  });

  it('says background work is still running after the turn answered', () => {
    mount(
      <TranscriptStatusProvider backgroundRunning waitpoints={[]}>
        <SessionStateLine running={false} />
      </TranscriptStatusProvider>,
    );
    expect(byAttr('data-session-state')[0].props['data-session-state']).toBe('background');
  });

  it('lifts a wait_create call out of the tool run when building rows', () => {
    const built = buildTranscriptRows({ sessionId: 's1', turns: [{ turnIndex: 0, messages: [
      { type: 'user', text: 'go', toolName: null, toolInput: null, ts: '2026-10-17T16:00:00Z', elapsedMs: null },
      { type: 'tool', text: null, toolName: 'Bash', toolInput: 'sbatch train.sh', ts: '2026-10-17T16:00:10Z', elapsedMs: 0 },
      { type: 'tool', text: null, toolName: 'mcp__cortex-core__wait_create', toolInput: '{"label":"train-run","intent":"Wake me when training ends"}', ts: '2026-10-17T16:00:20Z', elapsedMs: 0 },
    ] }] }, []);
    expect(built.map((r) => r.kind)).toEqual(['divider', 'user', 'tools', 'waitpoint']);
    expect(built[3]).toMatchObject({ wait: { label: 'train-run', intent: 'Wake me when training ends' } });
  });
});

describe('settled interactions', () => {
  it('folds an approved plan into one line', () => {
    const plan: ChatRow = {
      kind: 'interaction', subtype: 'plan', text: 'plan', ts: '2026-10-17T16:34:00Z',
      detail: {
        id: 'p1', kind: 'plan', status: 'approved',
        payload: { planContent: '# Thinking display\n\nsteps', filePath: '/repo/plan/thinking-display.md' },
      } as never,
    };
    mount(<ChatRows rows={[plan]} group />);
    const line = byAttr('data-interaction-sealed')[0];
    expect(line.props['data-interaction-sealed']).toBe('plan-approved');
    expect(text(line)).toContain('Plan approved');
    expect(text(line)).toContain('Thinking display');
  });
});

describe('editing a message in a laid-out stream', () => {
  it('keeps the turns before it laid out and dims the work after it', () => {
    const rows: ChatRow[] = [...turn, { kind: 'user', text: 'and the mobile app?', turnIndex: 1, ts: '2026-10-17T16:40:00Z' }, ...turn.slice(1)];
    mount(<ChatRows rows={rows} group edit={{ running: false, busy: false, onSubmit: vi.fn().mockResolvedValue({}) }} />);
    const editButtons = mounted.root.findAllByProps({ 'aria-label': 'Edit message' });
    expect(editButtons).toHaveLength(2);
    act(() => editButtons[1].props.onClick());
    expect(mounted.root.findAllByType('textarea')).toHaveLength(1);
    // One work line before the edited message, one in the tail that would be rewound.
    expect(byAttr('data-work-summary')).toHaveLength(2);
    expect(JSON.stringify(mounted.toJSON())).toContain('will rewind');
  });
});
