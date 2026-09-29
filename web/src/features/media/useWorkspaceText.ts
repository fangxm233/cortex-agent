import { useEffect, useState } from 'react';
import { fileDownloadUrl } from '@/lib/files';
import { authHeaders } from '@/lib/desktop-config';

// Fetch a workspace `path` as text (authenticated), refusing anything over `limit` bytes so a huge
// file is offered as a download instead of being pulled into the page. Shared by the text/Markdown
// body and the sandboxed view body; each keeps its own named ceiling.

type WorkspaceTextState = 'loading' | 'ok' | 'toolarge' | 'failed';

export function useWorkspaceText(path: string, limit: number): { text: string | null; state: WorkspaceTextState } {
  const [text, setText] = useState<string | null>(null);
  const [state, setState] = useState<WorkspaceTextState>('loading');

  useEffect(() => {
    let alive = true;
    setState('loading');
    setText(null);
    (async () => {
      const res = await fetch(fileDownloadUrl(path, 'inline'), { headers: authHeaders() });
      if (!res.ok) throw new Error(`download failed: ${res.status}`);
      const blob = await res.blob();
      if (blob.size > limit) {
        if (alive) setState('toolarge');
        return;
      }
      const t = await blob.text();
      if (alive) { setText(t); setState('ok'); }
    })().catch(() => { if (alive) setState('failed'); });
    return () => { alive = false; };
  }, [path, limit]);

  return { text, state };
}
