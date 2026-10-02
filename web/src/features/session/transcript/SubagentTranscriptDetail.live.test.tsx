import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackgroundSubagentFixture, BackgroundSubagentHarness, childMessage, DETAIL_INPUT, SESSION_ID } from './__fixtures__/BackgroundSubagentHarness';
import { SubagentBlock } from './SubagentBlock';
import { SubagentTranscriptDetail, activeSubagentTranscriptIds } from './SubagentTranscriptDetail';
import { ToolCallsRow } from './ToolCallsRow';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let fixture: BackgroundSubagentFixture;
let renderer: ReactTestRenderer;

function text(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : text(child)).join('');
}
function card() { return renderer.root.findByType(SubagentBlock); }
function header() { return card().findAllByType('button').find((button) => button.props['aria-expanded'] !== undefined)!; }
function detail() { return renderer.root.findByType(SubagentTranscriptDetail); }
function cachedDetail() {
  return fixture.queryClient.getQueryData(fixture.trpc.sessions.subagentTranscript.queryKey(DETAIL_INPUT));
}
function cachedSummary() {
  return fixture.queryClient.getQueryData(fixture.trpc.sessions.transcript.queryKey({ sessionId: SESSION_ID, compactSubagents: true }))?.subagentSummaries?.[0];
}
async function eventually(assertion: () => void) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    try { assertion(); return; } catch (error) { if (attempt === 99) throw error; }
  }
}
async function mount(count = 1) {
  await act(async () => { renderer = create(<BackgroundSubagentHarness fixture={fixture} />); });
  await eventually(() => expect(card().props.toolCount).toBe(count));
}
async function toggle() { await act(async () => { header().props.onClick(); }); }
async function open() {
  await toggle();
  await eventually(() => expect(detail().findAllByType(ToolCallsRow)).toHaveLength(1));
  act(() => { detail().findByType(ToolCallsRow).findAllByType('button')[0].props.onClick(); });
  expect(text(detail())).toContain('early.ts');
}
function expectIdle() { expect(text(renderer.root.findByProps({ 'data-testid': 'parent-running' }))).toBe('false'); }
function expectCount(count: number) {
  expect(cachedSummary()?.toolCount).toBe(count);
  expect(card().props.toolCount).toBe(count);
  expect(text(header())).toContain(`${count} tool call`);
}

async function completeChild() {
  act(() => {
    fixture.append(childMessage(4, { text: 'Final child prose.' }));
    fixture.append(childMessage(5, { text: '', subagentEnded: 'completed' }));
  });
  await eventually(() => { expect(card().props.status).toBe('done'); expect(text(detail())).toContain('Final child prose.'); });
}

beforeEach(() => { fixture = new BackgroundSubagentFixture(); });
afterEach(async () => {
  await act(async () => { renderer.unmount(); });
  expect(activeSubagentTranscriptIds(SESSION_ID)).toEqual([]);
  fixture.queryClient.clear();
});

describe('background child query/render convergence (controlled RPC, real shared UI)', () => {
  beforeEach(async () => { await mount(); });
  it('refreshes runtime-only summary status on session.status, never deriving it from parent running', async () => {
    expectIdle();
    act(() => fixture.emit('session.status', { running: false }));
    await eventually(() => expect(card().props.status).toBe('running'));
    act(() => { fixture.setStatus('completed'); fixture.emit('session.status', { running: false }); });
    await eventually(() => {
      expect(cachedSummary()?.status).toBe('completed');
      expect(card().props.status).toBe('done');
      expect(header().findAllByProps({ 'aria-label': 'running' })).toHaveLength(0);
    });
    expectIdle();
    expect(fixture.detailReads()).toBe(0);
  });

  it('refreshes an already-open cached detail and header for tool/prose/end after parent idle', async () => {
    await open();
    const tool = childMessage(2, { type: 'tool', toolName: 'Grep', toolInput: 'late-pattern' });
    const prose = childMessage(3, { text: 'Later child prose.' });
    act(() => { fixture.emit('session.status', { running: false }); fixture.append(tool); fixture.append(prose); });
    await eventually(() => {
      expectCount(2);
      expect(text(detail())).toContain('late-pattern');
      expect(text(detail())).toContain('Later child prose.');
      expect(cachedDetail()?.messages).toHaveLength(3);
    });
    expectIdle();
    expect(header().props['aria-expanded']).toBe(true);
    await completeChild();
    // Replayed SSE and the fetched snapshot coexist. Neither rows nor tool count may double.
    act(() => { fixture.messageEvent(tool); fixture.messageEvent(prose); });
    await eventually(() => {
      expectCount(2);
      expect(text(detail()).split('Later child prose.')).toHaveLength(2);
      expect(cachedDetail()?.messages).toHaveLength(5);
      expect(card().props.status).toBe('done');
    });
    expectIdle();
  });

  it.each(['completed', 'failed', 'killed'] as const)('does not reopen a %s child with a late live tool', async (status) => {
    await open();
    act(() => { fixture.append(childMessage(2, { text: '', subagentEnded: status })); });
    await eventually(() => expect(cachedSummary()?.status).toBe(status));
    act(() => fixture.messageEvent(childMessage(3, { type: 'tool', toolName: 'Read', toolInput: 'stale-tail.ts' })));
    await eventually(() => {
      expect(card().props.status).toBe('done');
      expect(text(detail())).not.toContain('stale-tail.ts');
      expectCount(1);
    });
  });

  it('keeps closed detail lazy and catches missed updates when reopening a cached detail', async () => {
    expect(fixture.detailReads()).toBe(0);
    await open();
    await toggle();
    const reads = fixture.detailReads();
    act(() => fixture.append(childMessage(2, { text: 'Written while closed.' })));
    await eventually(() => expect(cachedSummary()?.status).toBe('running'));
    expect(fixture.detailReads()).toBe(reads);
    expect(cachedDetail()?.messages).toHaveLength(1);
    await toggle();
    await eventually(() => expect(text(detail())).toContain('Written while closed.'));
    expect(cachedDetail()?.messages).toHaveLength(2);
  });

  it('recovers dropped events on reconnect and on refresh with a warm query cache', async () => {
    await open();
    fixture.append(childMessage(2, { type: 'tool', toolName: 'Grep', toolInput: 'missed-pattern' }), false);
    expect(text(detail())).not.toContain('missed-pattern');
    act(() => fixture.reconnect());
    await eventually(() => { expectCount(2); expect(text(detail())).toContain('missed-pattern'); });
    await act(async () => { renderer.unmount(); });
    fixture.append(childMessage(3, { text: 'Written while view unmounted.' }), false);
    await mount(2);
    await open();
    await eventually(() => expect(text(detail())).toContain('Written while view unmounted.'));
    expectCount(2);
    expectIdle();
  });

  it('does not lose events arriving during the first detail fetch when its old response completes last', async () => {
    fixture.holdNextDetail();
    await toggle();
    await eventually(() => expect(fixture.detailReads()).toBe(1));
    act(() => fixture.append(childMessage(2, { text: 'Arrived during first fetch.' })));
    await eventually(() => expect(text(detail())).toContain('Arrived during first fetch.'));
    // First response was captured BEFORE this event; no more events will rescue the cache.
    await act(async () => { fixture.releaseFirstDetail(); });
    await eventually(() => {
      expect(cachedDetail()?.messages.map((message) => message.text)).toContain('Arrived during first fetch.');
      expect(text(detail())).toContain('Arrived during first fetch.');
      expect(text(detail()).split('Arrived during first fetch.')).toHaveLength(2);
    });
  });

  it('coalesces hints during the first fetch into one follow-up read', async () => {
    fixture.holdNextDetail();
    await toggle();
    act(() => {
      fixture.append(childMessage(2, { type: 'tool', toolName: 'Grep', toolInput: 'pending-pattern' }));
      fixture.append(childMessage(3, { text: 'Burst during first fetch.' }));
      fixture.append(childMessage(4, { text: '', subagentEnded: 'completed' }));
      fixture.emit('session.debug.updated');
    });
    await act(async () => { fixture.releaseFirstDetail(); });
    await eventually(() => {
      expect(cachedDetail()?.messages).toHaveLength(4);
      expectCount(2);
      expect(card().props.status).toBe('done');
      expect(text(detail())).toContain('Burst during first fetch.');
    });
    expect(fixture.detailReads()).toBe(2);
  });

  it('does not refetch a detail closed before its pending fetch finishes', async () => {
    fixture.holdNextDetail();
    await toggle();
    act(() => fixture.append(childMessage(2, { text: 'Close during first fetch.' })));
    await toggle();
    await act(async () => { fixture.releaseFirstDetail(); });
    await eventually(() => expect(cachedDetail()?.messages).toHaveLength(1));
    expect(fixture.detailReads()).toBe(1);
    await toggle();
    await eventually(() => expect(text(detail())).toContain('Close during first fetch.'));
    expect(fixture.detailReads()).toBe(2);
  });

  it('refreshes DEBUG result data in the open detail on the content-free notification', async () => {
    await open();
    const toolResult = { content: 'DEBUG result saved after tool completion', isError: false };
    fixture.detail.messages[0].debug = { toolInput: { path: 'early.ts' }, toolResult };
    act(() => fixture.emit('session.debug.updated'));
    await eventually(() => {
      expect(cachedDetail()?.messages[0].debug?.toolResult).toEqual(toolResult);
      const toolRows = detail().findAllByType(ToolCallsRow);
      expect(toolRows[0].props.calls[0].debug.toolResult).toEqual(toolResult);
      expect(text(detail())).toContain('{ }');
    });
    expectIdle();
  });
});

const initialTranscriptHints = {
  status: () => fixture.emit('session.status', { running: false }),
  message: () => fixture.messageEvent(fixture.detail.messages[1]),
  end: () => fixture.messageEvent(fixture.detail.messages[2]),
  reconnect: () => fixture.reconnect(),
};
function updateHeldTranscript() {
  fixture.append(childMessage(2, { type: 'tool', toolName: 'Grep', toolInput: 'first-transcript-race' }), false);
  fixture.append(childMessage(3, { text: '', subagentEnded: 'completed' }), false);
}
function expectTranscriptRecovered(delta: boolean) {
  expectCount(2);
  expect(cachedSummary()?.status).toBe('completed');
  expect(card().props.status).toBe('done');
  expectIdle();
  expect(fixture.transcriptReads()).toBe(2);
  expect(fixture.transcriptInputs[1]).toEqual({
    sessionId: SESSION_ID, compactSubagents: true, ...(delta ? { since: 'fixture:1' } : {}),
  });
}

describe.each([false, true])('first compact transcript response race (delta=%s)', (delta) => {
  beforeEach(async () => {
    fixture.deltaResponses = delta;
    fixture.holdNextTranscript();
    await act(async () => { renderer = create(<BackgroundSubagentHarness fixture={fixture} />); });
    expect(fixture.transcriptReads()).toBe(1);
    expect(cachedSummary()).toBeUndefined();
  });

  it.each(Object.keys(initialTranscriptHints) as (keyof typeof initialTranscriptHints)[])(
    'recovers a %s hint before the first response, with no later events', async (hint) => {
      act(() => { updateHeldTranscript(); initialTranscriptHints[hint](); });
      expect(fixture.transcriptReads()).toBe(1);
      await act(async () => { fixture.releaseFirstTranscript(); });
      await eventually(() => expectTranscriptRecovered(delta));
    },
  );

  it('coalesces a first-fetch burst into exactly one follow-up read', async () => {
    act(() => {
      updateHeldTranscript();
      for (let index = 0; index < 10; index++) {
        initialTranscriptHints.status();
        initialTranscriptHints.message();
        initialTranscriptHints.end();
        fixture.emit('session.debug.updated');
      }
      initialTranscriptHints.reconnect();
    });
    expect(fixture.transcriptReads()).toBe(1);
    await act(async () => { fixture.releaseFirstTranscript(); });
    await eventually(() => expectTranscriptRecovered(delta));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(fixture.transcriptReads()).toBe(2);
  });

  it('does not refetch after unmount, then converges when mounted again', async () => {
    act(() => { updateHeldTranscript(); initialTranscriptHints.status(); });
    await act(async () => { renderer.unmount(); });
    await act(async () => { fixture.releaseFirstTranscript(); });
    await eventually(() => expect(cachedSummary()?.toolCount).toBe(1));
    expect(fixture.transcriptReads()).toBe(1);
    expect(fixture.queryClient.isFetching()).toBe(0);
    await mount(2);
    await eventually(() => expectTranscriptRecovered(delta));
  });
});
