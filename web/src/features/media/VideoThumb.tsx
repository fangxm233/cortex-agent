import type { CSSProperties } from 'react';
import { useVideoPoster } from './video-poster';

// Shared video thumbnail (web AND mobile). Renders a captured first-frame poster as an `<img>` so the
// preview shows a real still on the **Android System WebView** (which does not paint a `<video>`'s first
// frame — see `video-poster.ts`). Until the poster is ready (or if capture fails) it falls back to the
// raw `<video preload="metadata">`, which works on desktop and covers any codec the canvas can't decode.
// The play badge / filename overlay stay owned by each call site (they position over this element).
export function VideoThumb({ src, style }: { src: string; style?: CSSProperties }): JSX.Element {
  const poster = useVideoPoster(src);
  if (poster) {
    return <img src={poster} alt="" style={style} />;
  }
  return <video src={src} muted playsInline preload="metadata" style={style} />;
}
