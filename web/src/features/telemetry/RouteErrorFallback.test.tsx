import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { telemetryQueue } from './report-queue';
import { RouteErrorFallback } from './RouteErrorFallback';

function Boom(): JSX.Element { throw new TypeError('route render failure'); }

function render(path: string): ReactTestRenderer {
  const router = createMemoryRouter([
    { path: '/', element: <div />, errorElement: <RouteErrorFallback /> },
    { path: '/workbench', element: <Boom />, errorElement: <RouteErrorFallback /> },
  ], { initialEntries: [path] });
  let tree!: ReactTestRenderer;
  act(() => { tree = create(<RouterProvider router={router} />); });
  return tree;
}

afterEach(() => vi.restoreAllMocks());

describe('RouteErrorFallback', () => {
  it('reports a route render error and shows the crash fallback', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const enqueue = vi.spyOn(telemetryQueue, 'enqueue').mockImplementation(() => undefined);
    const tree = render('/workbench');
    expect(tree.root.findAll((n) => n.props['data-crash-fallback'] !== undefined).length).toBeGreaterThan(0);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]![0]).toMatchObject({ kind: 'crash', crashKind: 'renderError', errorName: 'TypeError' });
  });

  it('does not report an unmatched URL', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const enqueue = vi.spyOn(telemetryQueue, 'enqueue').mockImplementation(() => undefined);
    render('/no/such/page');
    expect(enqueue).not.toHaveBeenCalled();
  });
});
