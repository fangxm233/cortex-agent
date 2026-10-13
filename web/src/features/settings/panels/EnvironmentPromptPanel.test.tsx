import { useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import type { EnvironmentSystemPrompt, MutateArgs } from '@cortex-agent/ui-contract';
import { en } from '@/i18n/vocab';
import { EnvironmentPromptPanel } from './EnvironmentPromptPanel';

const adapter = vi.hoisted(() => ({
  savePrompt: vi.fn<(args: MutateArgs<'environments.savePrompt'>) => Promise<unknown>>(),
  toast: vi.fn(),
}));

vi.mock('@/i18n', async importOriginal => ({ ...await importOriginal<typeof import('@/i18n')>(), useVocab: () => en }));
vi.mock('@/design', async importOriginal => ({
  ...await importOriginal<typeof import('@/design')>(),
  useToast: () => ({ toast: adapter.toast }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    environments: {
      get: { queryFilter: (params: unknown) => ({ queryKey: ['environments.get', params] }) },
      savePrompt: { mutationOptions: (opts: object) => ({ ...opts, mutationFn: adapter.savePrompt }) },
    },
  }),
}));

const PROMPT: EnvironmentSystemPrompt = {
  kind: 'file', file: 'direct.md', text: 'loaded', sharedWith: ['other'], defaultText: 'shipped',
};

function Harness({ bodyDirty = false }: { bodyDirty?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  return <EnvironmentPromptPanel name="main" prompt={PROMPT} draft={draft} bodyDirty={bodyDirty} onDraft={setDraft} />;
}

function mount(bodyDirty = false) {
  let view!: ReactTestRenderer;
  act(() => {
    view = create(
      <QueryClientProvider client={new QueryClient()}>
        <Harness bodyDirty={bodyDirty} />
      </QueryClientProvider>,
    );
  });
  return view;
}

const editor = (view: ReactTestRenderer) => view.root.findByProps({ 'data-environment-prompt-text': '' });
const button = (view: ReactTestRenderer, action: string) =>
  view.root.find((node) => node.type === 'button' && node.props['data-action'] === action);
const typeText = (view: ReactTestRenderer, value: string) =>
  act(() => editor(view).props.onChange({ target: { value } }));

it('shows the source file and warns that other environments share it', () => {
  const view = mount();
  expect(view.root.findByProps({ 'data-prompt-source': '' }).children.join('')).toBe('prompts/systemPrompts/direct.md');
  expect(view.root.findAllByProps({ 'data-prompt-shared': '' }).length).toBeGreaterThan(0);
  expect(editor(view).props.value).toBe('loaded');
  expect(button(view, 'prompt-save').props.disabled).toBe(true);
});

it('saves the edited text for this environment', async () => {
  adapter.savePrompt.mockResolvedValueOnce({ changed: true, file: 'direct.md' });
  const view = mount();
  typeText(view, 'new prompt');
  expect(button(view, 'prompt-save').props.disabled).toBe(false);

  await act(async () => button(view, 'prompt-save').props.onClick());

  expect(adapter.savePrompt.mock.calls[0][0]).toEqual({ name: 'main', text: 'new prompt' });
  expect(adapter.toast).toHaveBeenCalledWith({ title: en.ttToastSaved, tone: 'done' });
});

it('restore fills in the shipped text and revert brings back the loaded one', () => {
  const view = mount();
  act(() => button(view, 'prompt-restore').props.onClick());
  expect(editor(view).props.value).toBe('shipped');
  act(() => button(view, 'prompt-revert').props.onClick());
  expect(editor(view).props.value).toBe('loaded');
});
