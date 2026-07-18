import { useMemo, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useVocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { deriveActiveProjectId } from '@/features/overview/overview-vm';
import {
  buildTreeRows,
  pickDefaultPath,
  relTimeAgo,
  diffToggle,
  formatLineDiff,
  groupBlame,
  type TreeRow,
  type BlameRow,
} from './memory-vm';
import { MarkdownView } from './MarkdownView';

// MEMORY VIEWER 7b — 1:1 from prototype.dc.html L658–719. CENTER-pane view mounted in the
// workbench frame (LeftRail + RightPanel persist, like Overview). Exact inline styles / px / hex /
// font / weight / EN copy reproduced; real fs-read data substituted via the existing memory.tree /
// memory.file tRPC scopes. Aggregate +/− is real (git numstat). With diff ON, a per-line blame pane
// shows the REAL commit hash + parsed task ref per line (memory.file.blame, git blame). When blame is
// unavailable (not a git repo / git unavailable / binary) it falls back to an HONEST placeholder
// (never fabricated); the task ref is null when the commit carries no task tag.

const MONO = "'IBM Plex Mono',monospace";

// Per-line blame pane (逐行高亮): real short commit hash + task-ref chip in the gutter (shown once per
// commit run), a subtle background band alternating per commit group, monospace line text.
export function BlamePane({ rows }: { rows: BlameRow[] }): JSX.Element {
  let groupIdx = -1;
  return (
    <div style={{ font: `400 11px ${MONO}`, lineHeight: 1.55 }}>
      {rows.map((r) => {
        if (r.groupStart) groupIdx += 1;
        const band = groupIdx % 2 === 0 ? 'var(--proto-rail)' : 'var(--proto-accent-bg)';
        return (
          <div
            key={r.lineNo}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 10,
              background: band,
              borderLeft: r.groupStart ? '2px solid var(--proto-accent)' : '2px solid transparent',
              padding: '0 8px',
            }}
          >
            <span style={{ width: 34, flex: 'none', textAlign: 'right', color: 'var(--proto-line)', fontSize: 9.5 }}>
              {r.lineNo}
            </span>
            <span style={{ width: 66, flex: 'none', color: 'var(--proto-muted-2)', fontSize: 9.5 }}>
              {r.groupStart && r.commit ? r.commit : ''}
            </span>
            <span style={{ width: 52, flex: 'none' }}>
              {r.groupStart && r.taskRef && (
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 600,
                    color: 'var(--proto-accent)',
                    background: 'var(--proto-accent-bg)',
                    border: '1px solid var(--proto-accent-border)',
                    borderRadius: 999,
                    padding: '1px 6px',
                  }}
                >
                  {r.taskRef}
                </span>
              )}
            </span>
            <span style={{ flex: 1, minWidth: 0, color: 'var(--proto-ink-2)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {r.text || ' '}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function TreeRowView({ row, onPick }: { row: TreeRow; onPick: (path: string) => void }) {
  const [hover, setHover] = useState(false);
  const bg = row.selected ? 'var(--proto-accent-bg)' : hover && row.selectable ? 'var(--proto-gray)' : 'transparent';
  const weight = row.selected ? 600 : row.kind === 'dir' ? 600 : 500;
  const color = row.selected ? 'var(--proto-accent)' : 'var(--proto-ink-2)';
  return (
    <div
      onClick={row.selectable && row.path ? () => onPick(row.path!) : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '5px 8px',
        background: bg,
        borderRadius: 7,
        cursor: row.selectable ? 'pointer' : 'default',
      }}
    >
      <span
        style={{
          font: `${weight} 10.5px ${MONO}`,
          color,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {row.name}
      </span>
      {row.right != null && (
        <span style={{ marginLeft: 'auto', font: `400 8.5px ${MONO}`, color: 'var(--proto-faint)', flex: 'none' }}>
          {row.right}
        </span>
      )}
    </div>
  );
}

const CENTER: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  background: 'var(--proto-card)',
};

export function MemoryView(): JSX.Element {
  const navigate = useNavigate();
  const trpc = useTRPC();
  const L = useVocab();
  const now = Date.now();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diffOn, setDiffOn] = useState(true);

  const projectsQuery = useQuery(trpc.projects.list.queryOptions({}));
  const sessionsQuery = useQuery(trpc.sessions.list.queryOptions({}));
  const projects = projectsQuery.data ?? [];
  const sessions = sessionsQuery.data ?? [];
  const activeProjectId = useMemo(() => deriveActiveProjectId(sessions, projects), [sessions, projects]);
  const projName = activeProjectId ?? '—';

  const treeQuery = useQuery({
    ...trpc.memory.tree.queryOptions({ projectId: activeProjectId ?? '' }),
    enabled: !!activeProjectId,
  });
  const tree = treeQuery.data;

  // Effective selection: explicit pick, else the first file once the tree resolves.
  const effectivePath = selectedPath ?? (tree ? pickDefaultPath(tree) : null);

  const fileQuery = useQuery({
    ...trpc.memory.file.queryOptions({ projectId: activeProjectId ?? '', path: effectivePath ?? '' }),
    enabled: !!activeProjectId && !!effectivePath,
  });
  const file = fileQuery.data;

  const rows = tree ? buildTreeRows(tree, effectivePath) : [];
  const dt = diffToggle(diffOn);
  // Real per-file git line counts (memory.file.lineDiff); null → honest placeholder (never fabricated).
  const lineDiff = formatLineDiff(file?.lineDiff);
  // Real per-line git blame (memory.file.blame); null → honest placeholder (no per-line highlight).
  const blameRows = groupBlame(file?.blame, file?.content ?? '');

  return (
    <div data-pane="center" style={CENTER}>
      {/* header (prototype L660–666) */}
      <div
        style={{
          height: 50,
          flex: 'none',
          borderBottom: '1px solid var(--proto-line)',
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '0 20px',
          background: 'var(--proto-card)',
        }}
      >
        <span
          onClick={() => navigate('/overview')}
          style={{ fontSize: 14, color: 'var(--proto-muted)', cursor: 'pointer', padding: '4px 8px 4px 0' }}
        >
          ‹
        </span>
        <span
          onClick={() => navigate('/overview')}
          style={{ font: `500 12px ${MONO}`, color: 'var(--proto-muted-2)', cursor: 'pointer' }}
        >
          {projName}
        </span>
        <span style={{ color: 'var(--proto-line-3)' }}>/</span>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--proto-ink)' }}>{L.memMemory}</span>
        <span style={{ color: 'var(--proto-line-3)' }}>/</span>
        <span style={{ font: `500 12px ${MONO}`, color: 'var(--proto-muted)' }}>{effectivePath ?? '—'}</span>
        <span style={{ marginLeft: 'auto', font: `400 10px ${MONO}`, color: 'var(--proto-muted-3)' }}>{L.ovGitBacked}</span>
      </div>

      {/* body: 200px tree + fluid rendered pane (prototype L667) */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        <div
          style={{
            width: 200,
            flex: 'none',
            borderRight: '1px solid var(--proto-line)',
            background: 'var(--proto-rail)',
            padding: '8px 6px',
            overflow: 'auto',
          }}
        >
          {treeQuery.isLoading && (
            <div style={{ fontSize: 10.5, color: 'var(--proto-faint)', padding: '6px 8px' }}>{L.memLoading}</div>
          )}
          {!treeQuery.isLoading && rows.length === 0 && (
            <div style={{ fontSize: 10.5, color: 'var(--proto-faint)', padding: '6px 8px' }}>{L.memNoFiles}</div>
          )}
          {rows.map((r) => (
            <TreeRowView key={r.name} row={r} onPick={setSelectedPath} />
          ))}
        </div>

        <div style={{ flex: 1, minWidth: 0, background: 'var(--proto-card)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* diff bar (prototype L678–684) */}
          <div
            style={{
              flex: 'none',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 20px',
              background: 'var(--proto-accent-bg)',
              borderBottom: '1px solid var(--proto-accent-bg)',
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--proto-accent)', flex: 'none' }} />
            <span style={{ fontSize: 11, color: 'var(--proto-accent-strong)' }}>{relTimeAgo(file?.modifiedAt, now)}</span>
            {/* Line-level +/− is REAL (git numstat vs HEAD). When the backend can't resolve it
                (no git / not a repo / binary) lineDiff is null → honest placeholder, never fabricated.
                Task ref + commit hash still have no backend scope → not shown (not fabricated). */}
            {lineDiff ? (
              <>
                <span style={{ font: `600 10px ${MONO}`, color: 'var(--proto-success)' }}>{lineDiff.added}</span>
                <span style={{ font: `600 10px ${MONO}`, color: 'var(--proto-danger)' }}>{lineDiff.removed}</span>
              </>
            ) : (
              <span style={{ font: `400 9.5px ${MONO}`, color: 'var(--proto-muted-3)' }}>{L.memDiffUnavailable}</span>
            )}
            <span
              onClick={() => setDiffOn((v) => !v)}
              style={{
                marginLeft: 'auto',
                fontSize: 10,
                fontWeight: 600,
                color: dt.color,
                background: dt.bg,
                border: `1px solid ${dt.border}`,
                borderRadius: 999,
                padding: '2px 10px',
                cursor: 'pointer',
              }}
            >
              {dt.label}
            </span>
          </div>

          {/* rendered markdown / per-line blame (prototype L685–716) */}
          <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '18px 24px 24px' }}>
            {diffOn && (
              <div
                style={{
                  fontSize: 10.5,
                  color: 'var(--proto-amber-fg)',
                  background: 'var(--proto-amber-bg)',
                  border: '1px solid var(--proto-amber-border)',
                  borderRadius: 7,
                  padding: '6px 11px',
                  marginBottom: 12,
                  lineHeight: 1.5,
                }}
              >
                {blameRows ? (
                  <>
                    {lineDiff ? `${lineDiff.added} / ${lineDiff.removed} ${L.memLinesChanged} ` : ''}
                    {L.memBlameNote}
                  </>
                ) : (
                  <>{L.memBlameUnavailable}</>
                )}
              </div>
            )}
            {fileQuery.isLoading && <div style={{ fontSize: 11.5, color: 'var(--proto-faint)' }}>{L.memLoadingFile}</div>}
            {fileQuery.isError && (
              <div style={{ fontSize: 11.5, color: 'var(--proto-danger)' }}>{L.memReadError}</div>
            )}
            {file && diffOn && blameRows ? (
              <BlamePane rows={blameRows} />
            ) : (
              file && <MarkdownView content={file.content} />
            )}
            {!fileQuery.isLoading && !fileQuery.isError && !file && (
              <div style={{ fontSize: 11.5, color: 'var(--proto-faint)' }}>{L.memSelectFile}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
