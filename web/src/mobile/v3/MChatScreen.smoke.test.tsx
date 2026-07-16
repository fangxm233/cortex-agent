import { describe, it, expect } from 'vitest';
import { MChatScreen } from './MChatScreen';

// Import smoke — the container is data-wired (proven in the live harness like the sibling
// MSessionListScreen), so this only asserts the module + its import graph resolve and the export
// exists. The presentational contract is covered by MChatView.test.tsx / m-chat-vm.test.ts.
describe('MChatScreen', () => {
  it('exports a component', () => {
    expect(typeof MChatScreen).toBe('function');
  });
});
