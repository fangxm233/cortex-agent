// input:  a view iframe ref and a height ceiling
// output: the content height the frame reported, clamped
// pos:    parent half of the view frame's postMessage protocol
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useEffect, useState, type RefObject } from 'react';
import { parseViewMessage, VIEW_HEIGHT_DEFAULT } from './html-sandbox';

/**
 * Size a sandboxed view frame to its content. The frame reports its own height (see the bootstrap
 * in `html-sandbox.ts`); this hook is the parent half of that protocol.
 *
 * Messages are authenticated by `event.source === frame.contentWindow` and NOT by `event.origin`.
 * A frame sandboxed without `allow-same-origin` has an opaque origin and reports `origin === "null"`,
 * so an origin allow-list would silently discard every message and every view would stay stuck at
 * its initial height. Identity of the window object is the check that actually holds here: no other
 * page can forge it, and messages from any other frame fall through untouched.
 */
export function useViewHeight(
  ref: RefObject<HTMLIFrameElement | null>,
  opts: { initial?: number; max: number; enabled?: boolean } ,
): number {
  const { initial = VIEW_HEIGHT_DEFAULT, max, enabled = true } = opts;
  const [height, setHeight] = useState(initial);

  useEffect(() => { setHeight(initial); }, [initial]);

  useEffect(() => {
    if (!enabled) return;
    const onMessage = (e: MessageEvent): void => {
      const frame = ref.current;
      if (!frame || e.source !== frame.contentWindow) return;
      const msg = parseViewMessage(e.data, max);
      // `submit` is parsed and deliberately dropped — the protocol is reserved, the behaviour is not
      // implemented. Ignoring it here keeps a future view from silently doing nothing surprising.
      if (msg?.type === 'height') setHeight(msg.value);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [ref, max, enabled]);

  return height;
}
