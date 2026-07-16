import { describe, it, expect } from 'vitest';
import { MThreadsScreen } from './MThreadsScreen';

// Structural smoke: the container module resolves all its imports (tRPC / router / query / kit / vm /
// view) and keeps the stable export name the route mounts. A full render needs the tRPC + router
// providers (covered by the live CDP pass); the presentational surface is proven by MThreadsView.test.
describe('MThreadsScreen', () => {
  it('exports the screen component under its stable name', () => {
    expect(typeof MThreadsScreen).toBe('function');
    expect(MThreadsScreen.name).toBe('MThreadsScreen');
  });
});
