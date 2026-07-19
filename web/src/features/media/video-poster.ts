import { useEffect, useState } from 'react';

// First-frame video poster (shared, web AND mobile). PROBLEM: every video thumbnail surface renders a
// live `<video preload="metadata">` and relies on the WebView to paint the first frame as a still.
// Desktop WebKitGTK / Chrome does; the **Android System WebView** (Tauri Android app) does NOT — it
// shows a generic built-in video placeholder ("模板的视频图片") until the clip is played. Same class of
// Android System WebView gap the DocViewer works around for PDFs. FIX: decode one frame off-screen and
// draw it to a canvas → a data URL used as an `<img>` poster (see `VideoThumb`).

/** Downscaled canvas size for a poster: preserves aspect, never upscales, caps the longest edge. */
export function posterCanvasSize(w: number, h: number, max = 360): { w: number; h: number } {
  if (w <= 0 || h <= 0) return { w: 0, h: 0 };
  const scale = Math.min(1, max / Math.max(w, h));
  return { w: Math.round(w * scale), h: Math.round(h * scale) };
}

/** Seek target for the captured frame: a small fixed offset (0 sometimes yields a blank buffer on
 *  Android), clamped to the midpoint of very short clips; unknown/NaN/Infinity duration → the offset. */
export function posterSeekTime(duration: number, offset = 0.1): number {
  if (!Number.isFinite(duration) || duration <= 0) return offset;
  return Math.min(offset, duration / 2);
}

/**
 * Capture the first frame of a video (an object URL — local `URL.createObjectURL(file)` or an
 * auth-fetched blob) into a poster data URL. Returns `null` until captured (or if capture fails, so
 * the caller can fall back to a raw `<video>` element). Same-origin blob URLs never taint the canvas.
 */
export function useVideoPoster(src: string | null | undefined): string | null {
  const [poster, setPoster] = useState<string | null>(null);
  useEffect(() => {
    setPoster(null);
    if (!src) return;
    if (typeof document === 'undefined') return;

    let alive = true;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = src;

    const release = (): void => {
      video.removeAttribute('src');
      try {
        video.load();
      } catch {
        /* ignore */
      }
    };

    const capture = (): void => {
      try {
        const { w, h } = posterCanvasSize(video.videoWidth, video.videoHeight);
        if (!w || !h) return;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, w, h);
        const data = canvas.toDataURL('image/jpeg', 0.72);
        if (alive && data.startsWith('data:image/jpeg')) setPoster(data);
      } catch {
        /* tainted canvas / decode failure → caller falls back to <video> */
      } finally {
        release();
      }
    };

    const onLoaded = (): void => {
      try {
        video.currentTime = posterSeekTime(video.duration);
      } catch {
        capture();
      }
    };
    const onSeeked = (): void => capture();
    const onError = (): void => release();

    video.addEventListener('loadeddata', onLoaded);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);

    return () => {
      alive = false;
      video.removeEventListener('loadeddata', onLoaded);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      release();
    };
  }, [src]);
  return poster;
}
