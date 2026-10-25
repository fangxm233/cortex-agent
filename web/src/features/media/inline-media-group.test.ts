import { describe, expect, it } from 'vitest';
import { createMediaGroup } from './inline-media-group';
import type { MediaItem } from './preview-item';

/** Stand-ins for host elements whose document position is their `order`. */
function hosts(count: number): Element[] {
  const made = Array.from({ length: count }, (_, order) => ({ order }));
  for (const host of made) {
    Object.assign(host, {
      compareDocumentPosition: (other: { order: number }) => (other.order > host.order ? 4 : 2),
    });
  }
  return made as unknown as Element[];
}

const item = (name: string): MediaItem => ({ kind: 'image', name, path: `workspace/${name}` });

describe('createMediaGroup', () => {
  it('lists members in document order, whatever order they joined in', () => {
    const [first, second, third] = hosts(3);
    const group = createMediaGroup();
    const a = item('a.png');
    const b = item('b.png');
    const c = item('c.png');

    group.join(third, c);
    group.join(first, a);
    group.join(second, b);

    expect(group.items()).toEqual([a, b, c]);
  });

  it('drops a member that leaves, but not a newer item shown in the same host', () => {
    const [host, other] = hosts(2);
    const group = createMediaGroup();
    const old = item('old.png');
    const next = item('next.png');
    const kept = item('kept.png');
    group.join(other, kept);

    const leaveOld = group.join(host, old);
    group.join(host, next);
    leaveOld();
    expect(group.items()).toEqual([next, kept]);

    group.join(host, next)();
    expect(group.items()).toEqual([kept]);
  });
});
