import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StarredSessionGroup } from './StarredSessionGroup';
import { useStarredGroups } from './useStarredGroups';

let lang: 'en' | 'zh' = 'en';
vi.mock('@/i18n', () => ({ useLangOptional: () => lang }));
afterEach(() => { vi.unstubAllGlobals(); lang = 'en'; });

function Groups() {
  const groups = useStarredGroups();
  return <>
    {['alpha', 'beta'].map(projectId => <StarredSessionGroup key={projectId} projectId={projectId}
      count={1} expanded={!groups.collapsed.has(projectId)} onToggle={() => groups.toggle(projectId)}>
      <span data-session={projectId}>{projectId}</span>
    </StarredSessionGroup>)}
    <button aria-label="Reveal selection" onClick={() => groups.reveal('alpha')} />
  </>;
}

const header = (tree: ReactTestRenderer, projectId: string) => tree.root
  .findByProps({ 'data-starred-project': projectId }).findByType('button');

describe('StarredSessionGroup', () => {
  it.each([['en', 'Stars'], ['zh', '星标']] as const)('labels the disclosure in %s', (language, title) => {
    lang = language;
    const tree = create(<Groups />);
    expect(header(tree, 'alpha').props['aria-label']).toBe(title);
    act(() => tree.unmount());
  });

  it('persists project-specific collapse and can reveal a selected session', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    } });
    let tree = create(<Groups />);
    act(() => header(tree, 'alpha').props.onClick());
    expect(header(tree, 'alpha').props['aria-expanded']).toBe(false);
    expect(header(tree, 'beta').props['aria-expanded']).toBe(true);
    act(() => tree.unmount());
    act(() => { tree = create(<Groups />); });
    expect(header(tree, 'alpha').props['aria-expanded']).toBe(false);
    act(() => tree.root.findByProps({ 'aria-label': 'Reveal selection' }).props.onClick());
    expect(header(tree, 'alpha').props['aria-expanded']).toBe(true);
    expect(header(tree, 'beta').props['aria-expanded']).toBe(true);
    act(() => tree.unmount());
  });

  it('starts expanded if stored state is malformed', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => 'not json' } });
    const tree = create(<Groups />);
    expect(header(tree, 'alpha').props['aria-expanded']).toBe(true);
    act(() => tree.unmount());
  });
});
