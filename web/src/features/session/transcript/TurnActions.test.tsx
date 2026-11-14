import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
import { TurnActions, TurnQuoteContext } from './TurnActions';

class FakeElement {
  constructor(private inChat: boolean) {}
  closest(): object | null { return this.inChat ? {} : null; }
}

function stubSelection(text: string, inChat: boolean): void {
  vi.stubGlobal('Element', FakeElement);
  vi.stubGlobal('window', {
    getSelection: () => (text ? { isCollapsed: false, anchorNode: new FakeElement(inChat), toString: () => text } : null),
  });
}

function mountQuote(onQuote: (text: string) => void): ReturnType<typeof create> {
  let tree!: ReturnType<typeof create>;
  act(() => { tree = create(
    <LangProvider>
      <TurnQuoteContext.Provider value={onQuote}>
        <TurnActions turn={{ text: 'the answer' }} />
      </TurnQuoteContext.Provider>
    </LangProvider>,
  ); });
  return tree;
}

const quoteButtons = (tree: ReturnType<typeof create>) =>
  tree.root.findAll((node) => node.type === 'button' && node.props['aria-label'] === 'Quote');

describe('TurnActions', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('quotes the part of the transcript the reader selected, else the whole reply', () => {
    const onQuote = vi.fn();
    const tree = mountQuote(onQuote);
    stubSelection('  a selected part ', true);
    act(() => quoteButtons(tree)[0].props.onClick());
    stubSelection('text outside the chat', false);
    act(() => quoteButtons(tree)[0].props.onClick());
    expect(onQuote.mock.calls).toEqual([['a selected part'], ['the answer']]);
  });

  it('shows when the reply landed and quotes the whole reply', () => {
    stubSelection('', false);
    const onQuote = vi.fn();
    const ts = new Date().toISOString();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(
      <LangProvider>
        <TurnQuoteContext.Provider value={onQuote}>
          <TurnActions turn={{ text: 'the answer', ts }} />
        </TurnQuoteContext.Provider>
      </LangProvider>,
    ); });
    const d = new Date(ts);
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    expect(tree.root.findAll((node) => node.type === 'span' && node.children.includes(hhmm))).toHaveLength(1);
    const quote = tree.root.findAll((node) => node.type === 'button' && node.props['aria-label'] === 'Quote');
    expect(quote).toHaveLength(1);
    act(() => quote[0].props.onClick());
    expect(onQuote).toHaveBeenCalledWith('the answer');
  });

  it('offers no quote button outside a chat with a composer', () => {
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<LangProvider><TurnActions turn={{ text: 'x' }} /></LangProvider>); });
    expect(tree.root.findAll((node) => node.type === 'button' && node.props['aria-label'] === 'Quote')).toHaveLength(0);
  });
});
