// input:  Modal layer class helpers
// output: nested dialog stacking regression
// pos:    Verifies nested modals clear high-level app overlays
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { expect, it } from 'vitest';
import { modalContentClass, modalOverlayClass } from './Modal';

function zIndex(className: string): number {
  const match = className.match(/\bz-(?:\[(\d+)\]|(\d+))(?:\s|$)/);
  if (!match) throw new Error(`Missing z-index class: ${className}`);
  return Number(match[1] ?? match[2]);
}

it('stacks a nested modal above the thread-detail overlay', () => {
  const overlay = zIndex(modalOverlayClass('nested'));
  const content = zIndex(modalContentClass('default', 'nested'));

  expect(overlay).toBeGreaterThan(71);
  expect(content).toBeGreaterThan(overlay);
});
