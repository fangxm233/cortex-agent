import { useEffect, useRef, useState } from 'react';
import { VIEW_SANDBOX } from '@/features/media/html-sandbox';
import { parseBoardMessage } from './board-document';

// The board body. Sandboxed to `allow-scripts` only (media/html-sandbox.ts is the rulebook) and
// sized to its content: the PARENT scrolls, so a re-render after an edit swaps the document under
// a scroll position that does not move. The last reported height is held until the new document
// reports its own, so the reload never collapses the page under the reader.

const INITIAL_HEIGHT = 240;

export function BoardFrame({ srcDoc, title, onOpen, onLink }: {
  srcDoc: string;
  title: string;
  onOpen: (ref: string) => void;
  onLink: (href: string) => void;
}): JSX.Element {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(INITIAL_HEIGHT);
  const handlers = useRef({ onOpen, onLink });
  handlers.current = { onOpen, onLink };

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const msg = parseBoardMessage(event.data);
      if (!msg) return;
      if (msg.type === 'height') setHeight(Math.max(msg.value, 1));
      else if (msg.type === 'open') handlers.current.onOpen(msg.path);
      else handlers.current.onLink(msg.href);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <iframe
      ref={frameRef}
      title={title}
      // The whole isolation boundary. Read media/html-sandbox.ts before touching this attribute.
      sandbox={VIEW_SANDBOX}
      srcDoc={srcDoc}
      referrerPolicy="no-referrer"
      data-board-frame=""
      style={{ display: 'block', width: '100%', height, border: 0, background: 'transparent' }}
    />
  );
}
