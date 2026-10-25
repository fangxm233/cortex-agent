import { createContext, useContext, useEffect, type RefObject } from 'react';
import type { MediaItem } from './preview-item';

// The media one message's markdown shows, gathered so the lightbox can step through them. Each inline
// image or video joins once it has loaded and leaves when it fails or unmounts; opening one hands the
// lightbox the whole set in reading order. One group per message (`ChatMediaProvider`).

export interface MediaGroup {
  /** Adds `item`, shown inside `host`; returns its removal. */
  join: (host: Element, item: MediaItem) => () => void;
  /** The joined items in document order. */
  items: () => MediaItem[];
}

/** `Node.DOCUMENT_POSITION_FOLLOWING`, named here so the module needs no DOM globals. */
const FOLLOWING = 4;

const documentOrder = (a: Element, b: Element): number => (a.compareDocumentPosition(b) & FOLLOWING ? -1 : 1);

export function createMediaGroup(): MediaGroup {
  const members = new Map<Element, MediaItem>();
  return {
    join(host, item) {
      members.set(host, item);
      return () => {
        if (members.get(host) === item) members.delete(host);
      };
    },
    items: () => [...members.keys()].sort(documentOrder).map((host) => members.get(host)!),
  };
}

const MediaGroupContext = createContext<MediaGroup | null>(null);

export const MediaGroupProvider = MediaGroupContext.Provider;

/** Keeps `item` (null while it is not viewable) in the enclosing message's group. */
export function useMediaGroupMember(host: RefObject<Element>, item: MediaItem | null): MediaGroup | null {
  const group = useContext(MediaGroupContext);
  useEffect(() => {
    const element = host.current;
    if (!group || !element || !item) return;
    return group.join(element, item);
  }, [group, host, item]);
  return group;
}
