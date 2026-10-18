import type { BlameRow } from './memory-vm';

// Changes mode: the file line by line with its real `git blame` attribution (memory.file.blame).
// The line text is file content and stays in the code face; the gutter — line number, short commit,
// parsed task ref — is metadata, set in the UI face with tabular figures. The commit and task ref are
// shown once per commit run; each run starts on a hairline and alternate runs carry a faint band.

const GUTTER = { flex: 'none', fontSize: 11.5, color: 'var(--proto-muted-3)', fontVariantNumeric: 'tabular-nums' } as const;

export function BlamePane({ rows }: { rows: BlameRow[] }): JSX.Element {
  let groupIdx = -1;
  return (
    <div>
      {rows.map((r, i) => {
        if (r.groupStart) groupIdx += 1;
        return (
          <div
            key={r.lineNo}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 10,
              padding: '1px 10px',
              background: groupIdx % 2 === 1 ? 'var(--proto-rail)' : 'transparent',
              borderTop: r.groupStart && i > 0 ? '1px solid var(--proto-line-2)' : '1px solid transparent',
            }}
          >
            <span style={{ ...GUTTER, width: 32, textAlign: 'right' }}>{r.lineNo}</span>
            <span style={{ ...GUTTER, width: 64, fontFamily: 'var(--font-code)', fontSize: 11 }}>{r.groupStart && r.commit ? r.commit : ''}</span>
            <span style={{ ...GUTTER, width: 52 }}>
              {r.groupStart && r.taskRef && (
                <span
                  style={{
                    display: 'inline-block',
                    lineHeight: '18px',
                    padding: '0 6px',
                    borderRadius: 'var(--r-pill)',
                    background: 'var(--proto-line-2)',
                    color: 'var(--proto-muted-2)',
                    fontWeight: 500,
                  }}
                >
                  {r.taskRef}
                </span>
              )}
            </span>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                font: '400 12px/1.65 var(--font-code)',
                color: 'var(--proto-ink-2)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {r.text || ' '}
            </span>
          </div>
        );
      })}
    </div>
  );
}
