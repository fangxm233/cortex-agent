import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import '@/design/content-surfaces.css';
import './memory-view.css';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useLang, useVocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { IconButton } from '@/design/IconButton';
import { deriveActiveProjectId } from '@/features/projects/current-project';
import { deriveMemoryTreeFacts } from './memory-tree';
import { activeOutlineId, deriveMemoryDoc } from './memory-doc';
import {
  buildTreeRows,
  hasRecentChange,
  relTimeAgo,
  formatLineDiff,
  groupBlame,
  DEFAULT_MEMORY_MODE,
  type LineDiffLabel,
  type MemoryMode,
} from './memory-vm';
import { MarkdownView } from './MarkdownView';
import { MemoryTree } from './MemoryTree';
import { MemoryDocHeader, ClockGlyph, LineDiffText } from './MemoryDocHeader';
import { MemoryOutline } from './MemoryOutline';
import { BlamePane } from './BlamePane';

// MEMORY VIEWER — a CENTER-pane view mounted in the workbench frame (LeftRail persists, like
// Overview): file column, a centred reading column, and an "On this page" outline when the pane is
// wide enough. Real fs-read data via the existing memory.tree / memory.file tRPC scopes. Read mode
// renders the document; Changes mode shows the REAL per-line git blame (memory.file.blame: short
// commit hash + parsed task ref) and the real working-copy +/− (git numstat). When blame or the
// line counts are unavailable (not a git repo / git unavailable / binary) the view says so — never
// fabricated; the task ref is null when the commit carries no task tag.

/** How far below the scroller's top edge a heading counts as the section being read. */
const OUTLINE_THRESHOLD_PX = 48;

function BackGlyph(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 3.5 5.5 8l4.5 4.5" />
    </svg>
  );
}

/** The header's Read | Changes switch: a recessed track holding the raised current option. */
function ModeSwitch({ mode, onChange }: { mode: MemoryMode; onChange: (mode: MemoryMode) => void }): JSX.Element {
  const L = useVocab();
  const options: { id: MemoryMode; label: string }[] = [
    { id: 'read', label: L.memModeRead },
    { id: 'changes', label: L.memModeChanges },
  ];
  return (
    <div
      role="group"
      aria-label={L.memModeLabel}
      style={{ display: 'inline-flex', gap: 2, padding: 2, borderRadius: 'var(--r-chip)', background: 'var(--proto-line-2)', flex: 'none' }}
    >
      {options.map((option) => {
        const on = option.id === mode;
        return (
          <button
            key={option.id}
            type="button"
            className="memory-seg-option"
            aria-pressed={on}
            onClick={() => onChange(option.id)}
            style={{
              height: 26,
              padding: '0 12px',
              border: 0,
              borderRadius: 6,
              fontSize: 12.5,
              fontWeight: on ? 550 : 400,
              color: on ? 'var(--proto-ink)' : 'var(--proto-muted-2)',
              background: on ? 'var(--material-control-bg)' : 'transparent',
              boxShadow: on ? 'var(--material-control-shadow)' : 'none',
              cursor: 'pointer',
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

const META: CSSProperties = { fontSize: 12.5, color: 'var(--proto-muted-3)', fontVariantNumeric: 'tabular-nums' };

/** Changes mode's head: when the file changed and by how much against HEAD, then what the line
 *  listing below shows — or that git could not say, in which case the document is shown instead. */
function ChangesSummary({ updated, lineDiff, hasBlame }: {
  updated: string;
  lineDiff: LineDiffLabel | null;
  hasBlame: boolean;
}): JSX.Element {
  const L = useVocab();
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ ...META, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <ClockGlyph />
        <span>{updated}</span>
        <span aria-hidden="true">·</span>
        {/* Line-level +/− is REAL (git numstat vs HEAD); null → honest placeholder, never fabricated. */}
        {lineDiff ? (
          <span style={{ display: 'inline-flex', gap: 6 }}>
            <LineDiffText diff={lineDiff} />
            {!lineDiff.clean && <span>{L.memLinesChanged}</span>}
          </span>
        ) : (
          <span>{L.memDiffUnavailable}</span>
        )}
      </div>
      <div
        style={{
          fontSize: 12.5,
          lineHeight: 1.5,
          color: 'var(--proto-amber-fg)',
          background: 'var(--proto-amber-bg)',
          border: '1px solid var(--proto-amber-border)',
          borderRadius: 'var(--r-control)',
          padding: '7px 12px',
        }}
      >
        {hasBlame ? L.memBlameNote : L.memBlameUnavailable}
      </div>
    </div>
  );
}

// No background of its own: the header and the file column read directly on the workspace pane's
// glass. Only the document pane below carries a fill.
const CENTER: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};

const STATE_NOTE: CSSProperties = { fontSize: 13, color: 'var(--proto-muted)' };

export function MemoryView(): JSX.Element {
  const navigate = useNavigate();
  const trpc = useTRPC();
  const L = useVocab();
  const lang = useLang();
  const now = Date.now();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [mode, setMode] = useState<MemoryMode>(DEFAULT_MEMORY_MODE);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);

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
  const treeFacts = useMemo(() => deriveMemoryTreeFacts(tree), [tree]);

  // Effective selection: explicit pick, else the first top-level or nested file once the tree resolves.
  const effectivePath = selectedPath ?? treeFacts.firstFile?.path ?? null;

  const fileQuery = useQuery({
    ...trpc.memory.file.queryOptions({ projectId: activeProjectId ?? '', path: effectivePath ?? '' }),
    enabled: !!activeProjectId && !!effectivePath,
  });
  const file = fileQuery.data;
  const content = file?.content;
  const doc = useMemo(() => (content == null ? null : deriveMemoryDoc(content)), [content]);

  const rows = buildTreeRows(treeFacts, effectivePath, { now, collapsed });
  const updated = relTimeAgo(file?.modifiedAt, now, lang, L);
  // Real per-file git line counts (memory.file.lineDiff); null → honest placeholder (never fabricated).
  const lineDiff = formatLineDiff(file?.lineDiff);
  // Real per-line git blame (memory.file.blame); null → honest placeholder (no per-line listing).
  const blameRows = groupBlame(file?.blame, content ?? '');
  // Changes lists the lines; without blame it falls back to the document under an honest note.
  const blamePane = mode === 'changes' ? blameRows : null;
  const outline = !blamePane && doc && doc.outline.length >= 2 ? doc.outline : null;

  const toggleDir = useCallback((name: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  // Each file opens at its top, so the outline below starts from its first section.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [effectivePath]);

  const updateActive = useCallback(() => {
    frameRef.current = null;
    const scroller = scrollRef.current;
    if (!scroller || !outline) return;
    const origin = scroller.getBoundingClientRect().top;
    const tops = outline.flatMap((entry) => {
      const el = document.getElementById(entry.id);
      return el ? [{ id: entry.id, top: el.getBoundingClientRect().top - origin }] : [];
    });
    const atEnd = scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    setActiveId(activeOutlineId(tops, OUTLINE_THRESHOLD_PX, atEnd));
  }, [outline]);

  useEffect(() => {
    updateActive();
  }, [updateActive]);

  useEffect(() => () => {
    if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
  }, []);

  const onScroll = (): void => {
    if (outline && frameRef.current == null) frameRef.current = requestAnimationFrame(updateActive);
  };

  const jumpTo = (id: string): void => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    setActiveId(id);
  };

  return (
    <div className="content-surface memory-view" data-pane="center" style={CENTER}>
      <div
        style={{
          minHeight: 52,
          flex: 'none',
          flexWrap: 'wrap',
          borderBottom: '1px solid var(--proto-line-2)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 14px 8px 12px',
          boxSizing: 'border-box',
        }}
      >
        <IconButton label={L.back} size={28} onClick={() => navigate('/overview')}>
          <BackGlyph />
        </IconButton>
        <div style={{ flex: '1 1 160px', minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 6, overflow: 'hidden', whiteSpace: 'nowrap' }}>
          <button type="button" className="content-text-action"
            onClick={() => navigate('/overview')}
            style={{ fontSize: 15, fontWeight: 600, color: 'var(--proto-ink)', cursor: 'pointer', flex: 'none' }}
          >
            {projName}
          </button>
          <span style={{ fontSize: 15, color: 'var(--proto-muted-3)', flex: 'none' }}>/ {L.memMemory}</span>
          {/* The open file as a breadcrumb: a path, but here it names a place, so it reads in the UI face. */}
          {effectivePath && (
            <span style={{ fontSize: 13, color: 'var(--proto-muted-3)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              / {effectivePath}
            </span>
          )}
        </div>
        <ModeSwitch mode={mode} onChange={setMode} />
      </div>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        <MemoryTree
          rows={rows}
          loading={treeQuery.isLoading}
          showLegend={hasRecentChange(treeFacts, now)}
          onPick={setSelectedPath}
          onToggle={toggleDir}
        />

        {/* The document pane is more opaque than the pane glass (a control-material fill): long
            prose over a fully translucent surface reads the mesh through every line, which is
            exactly what a reading pane must not do. It goes fully opaque with the glass level. */}
        <div
          ref={scrollRef}
          onScroll={onScroll}
          style={{ flex: 1, minWidth: 0, overflow: 'auto', scrollbarGutter: 'stable', background: 'var(--material-control-bg)' }}
        >
          <div className="memory-doc-row" style={{ display: 'flex', justifyContent: 'center', gap: 40, padding: '32px 32px 48px' }}>
            <article style={{ flex: `0 1 ${blamePane ? 880 : 680}px`, minWidth: 0 }}>
              {mode === 'changes' && file && (
                <ChangesSummary updated={updated} lineDiff={lineDiff} hasBlame={!!blameRows} />
              )}
              {fileQuery.isLoading && <div style={STATE_NOTE}>{L.memLoadingFile}</div>}
              {fileQuery.isError && <div style={{ ...STATE_NOTE, color: 'var(--proto-danger)' }}>{L.memReadError}</div>}
              {blamePane ? (
                <BlamePane rows={blamePane} />
              ) : (
                file && doc && (
                  <>
                    <MemoryDocHeader
                      doc={doc}
                      updated={updated}
                      lineDiff={lineDiff}
                      onShowChanges={mode === 'read' ? () => setMode('changes') : undefined}
                    />
                    <MarkdownView blocks={doc.blocks} />
                  </>
                )
              )}
              {!fileQuery.isLoading && !fileQuery.isError && !file && (
                <div style={STATE_NOTE}>{L.memSelectFile}</div>
              )}
            </article>
            {outline && <MemoryOutline entries={outline} activeId={activeId} onJump={jumpTo} />}
          </div>
        </div>
      </div>
    </div>
  );
}
