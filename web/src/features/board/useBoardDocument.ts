import { useEffect, useMemo, useState } from 'react';
import { authHeaders } from '@/lib/desktop-config';
import { boardAssetUrl } from '@/lib/files';
import { readCappedBody } from '@/features/media/workspace-bytes';
import { inlineBoardAssets, type FetchedAsset } from './board-assets';
import { assembleBoardDocument, readThemeVars, referencedVars } from './board-document';

const THEME_SETTLE_MS = 120;

async function fetchBoardAsset(projectId: string, path: string, limit: number): Promise<FetchedAsset | null> {
  // `no-cache`: an agent may overwrite an asset in place, and the route sends a max-age.
  const res = await fetch(boardAssetUrl(projectId, path, 'inline'), { headers: authHeaders(), cache: 'no-cache' });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const capped = await readCappedBody(res, limit);
  return capped.kind === 'ok' ? { mime: res.headers.get('content-type') ?? '', bytes: capped.bytes } : null;
}

function effectiveTheme(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/** Bumps whenever the app's appearance may have changed: theme, palette, accent and glass all land
 *  as attributes or inline style on the root element. Settled briefly so a slider drag does not
 *  reload the frame on every step. */
function useAppearanceTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setTick((t) => t + 1), THEME_SETTLE_MS);
    };
    const observer = new MutationObserver(bump);
    observer.observe(document.documentElement, { attributes: true });
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    media?.addEventListener?.('change', bump);
    return () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
      media?.removeEventListener?.('change', bump);
    };
  }, []);
  return tick;
}

export interface BoardDocumentInput {
  projectId: string;
  slug: string;
  body: string | null;
  style: { defaultCss: string; userCss: string | null } | null;
  /** Changes when the board directory changed, so assets are re-read even if the body text did not. */
  refresh: number;
}

/** The frame's `srcdoc`, or null until the body, the stylesheets and the body's assets are ready.
 *  While a newer body is being prepared the previous document stays up. */
export function useBoardDocument({ projectId, slug, body, style, refresh }: BoardDocumentInput): string | null {
  const [inlined, setInlined] = useState<string | null>(null);
  useEffect(() => {
    if (body === null || !projectId || !slug) return;
    let cancelled = false;
    void inlineBoardAssets(body, slug, (path, limit) => fetchBoardAsset(projectId, path, limit))
      .catch(() => body)
      .then((html) => { if (!cancelled) setInlined(html); });
    return () => { cancelled = true; };
  }, [body, projectId, slug, refresh]);

  const tick = useAppearanceTick();
  const names = useMemo(
    () => referencedVars(style?.defaultCss, style?.userCss, body),
    [style?.defaultCss, style?.userCss, body],
  );
  const theme = useMemo(
    () => ({ css: readThemeVars(names, document.documentElement), mode: effectiveTheme() }),
    // `tick` is the appearance signal; the read itself is off the live root.
    [names, tick],
  );

  return useMemo(() => {
    if (inlined === null || style === null) return null;
    return assembleBoardDocument({
      themeCss: theme.css,
      defaultCss: style.defaultCss,
      userCss: style.userCss,
      body: inlined,
      theme: theme.mode,
    });
  }, [inlined, style, theme]);
}
