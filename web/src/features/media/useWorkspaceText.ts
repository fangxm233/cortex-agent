import { useEffect, useState } from 'react';
import { fetchWorkspaceBytes } from './workspace-bytes';

// Fetch a workspace `path` as text (authenticated), refusing anything over `limit` bytes so a huge
// file is offered as a download instead of being pulled into the page. Shared by the text/Markdown
// body and the sandboxed view body; each keeps its own named ceiling.

type WorkspaceTextState = 'loading' | 'ok' | 'toolarge' | 'failed';

export function useWorkspaceText(path: string, limit: number): { text: string | null; state: WorkspaceTextState } {
  const [text, setText] = useState<string | null>(null);
  const [state, setState] = useState<WorkspaceTextState>('loading');

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    setText(null);
    fetchWorkspaceBytes(path, limit, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.kind === 'toolarge') {
          setState('toolarge');
          return;
        }
        setText(new TextDecoder().decode(result.bytes));
        setState('ok');
      })
      .catch(() => { if (!controller.signal.aborted) setState('failed'); });
    return () => controller.abort();
  }, [path, limit]);

  return { text, state };
}
