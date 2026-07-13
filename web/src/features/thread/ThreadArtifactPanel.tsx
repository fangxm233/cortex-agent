import { useVocab } from '@/i18n';
import type { DetailArtifact } from './thread-detail-vm';

// THREAD ARTIFACT column — 1:1 card chrome from prototype.dc.html L488–520. Header (doc icon · path ·
// live badge · updated · Open ↗) + a REFERENCES body + WRITTEN BY footer chips.
//
// GAP-artifact-body (flagged, Stage 6): the prototype's rich body (RESULT / METRICS / OPEN QUESTIONS)
// is rendered from the artifact FILE CONTENT, which needs the fs-read tRPC scope (plan §2.1). Until
// then the header refs + written-by are REAL (from threads.get); the body honestly shows the artifact
// references instead of fabricated metrics, and a muted note points at the Memory viewer (Stage 6).

const DOC_ICON = (
  <svg width="11" height="13" viewBox="0 0 11 13" fill="none" stroke="#8A93A2" strokeWidth="1.4">
    <path d="M1 1.5h6l3 3v7H1z" />
    <path d="M7 1.5v3h3" />
  </svg>
);

function RefRow({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <span style={{ flex: 'none' }}>{k}</span>
      <span
        style={{
          marginLeft: 'auto',
          color: '#191C22',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {v}
      </span>
    </div>
  );
}

export interface ThreadArtifactPanelProps {
  artifact: DetailArtifact;
  onOpen: () => void;
}

export function ThreadArtifactPanel({ artifact, onOpen }: ThreadArtifactPanelProps): JSX.Element {
  const L = useVocab();
  const refs: Array<{ k: string; v: string }> = [];
  if (artifact.workspacePath) refs.push({ k: L.thWorkspace, v: artifact.workspacePath });
  if (artifact.taskId) refs.push({ k: L.thTask, v: artifact.taskId });
  if (artifact.taskProject) refs.push({ k: L.thProject, v: artifact.taskProject });

  return (
    <div style={{ width: 440, flex: 'none', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', padding: '0 2px 8px' }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.07em', color: '#98A1B0' }}>
          {L.thArtifact}
        </span>
        <span style={{ marginLeft: 'auto', font: "400 9.5px 'IBM Plex Mono',monospace", color: '#B6BDC9' }}>
          {L.thArtifactHint}
        </span>
      </div>
      <div
        data-thread-artifact="true"
        style={{
          flex: 1,
          minHeight: 0,
          background: '#fff',
          border: '1px solid #E7E9EE',
          borderRadius: 10,
          boxShadow: '0 1px 2px rgba(16,24,40,.03)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* file header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 14px',
            borderBottom: '1px solid #EFF1F5',
            flex: 'none',
          }}
        >
          {DOC_ICON}
          <span
            style={{
              font: "600 11px 'IBM Plex Mono',monospace",
              color: '#191C22',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {artifact.path ?? '—'}
          </span>
          {artifact.live && (
            <span
              style={{
                fontSize: 9.5,
                fontWeight: 600,
                padding: '1.5px 7px',
                borderRadius: 999,
                background: '#EEF0FA',
                color: '#4655D4',
                flex: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              <span
                style={{
                  display: 'inline-block',
                  width: 5,
                  height: 5,
                  borderRadius: '50%',
                  background: '#4655D4',
                  marginRight: 4,
                  animation: 'cxpulse 1.6s ease-in-out infinite',
                }}
              />
              {L.thLive}
            </span>
          )}
          <span
            style={{
              marginLeft: 'auto',
              font: "400 9.5px 'IBM Plex Mono',monospace",
              color: '#B6BDC9',
              flex: 'none',
            }}
          >
            {artifact.updated}
          </span>
          <span
            onClick={onOpen}
            title="Opens in the Memory viewer — Stage 6"
            style={{ fontSize: 10.5, fontWeight: 600, color: '#4655D4', cursor: 'pointer', flex: 'none' }}
          >
            {L.open} ↗
          </span>
        </div>

        {/* body — real refs (content body is a Stage-6 fs-read gap) */}
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '13px 16px' }}>
          <div style={{ fontSize: 14, fontWeight: 650, color: '#191C22', letterSpacing: '-.01em' }}>
            {artifact.path ? artifact.path.split('/').pop() : L.thNoArtifact}
          </div>
          <div style={{ font: "400 9.5px 'IBM Plex Mono',monospace", color: '#8A93A2', marginTop: 4 }}>
            {L.thOwner}: {artifact.taskId ? artifact.taskId : '—'}
          </div>
          <div style={{ height: 1, background: '#EFF1F5', margin: '10px 0' }} />

          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.06em', color: '#B6BDC9' }}>
            {L.thReferences}
          </div>
          {refs.length > 0 ? (
            <div
              style={{
                font: "400 10px 'IBM Plex Mono',monospace",
                color: '#5B6472',
                lineHeight: 1.9,
                marginTop: 3,
              }}
            >
              {refs.map((r) => (
                <RefRow key={r.k} k={r.k} v={r.v} />
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 11.5, color: '#8A93A2', marginTop: 3 }}>—</div>
          )}

          {artifact.contentGap && (
            <div
              style={{
                marginTop: 12,
                padding: '9px 11px',
                background: '#F7F8FA',
                border: '1px solid #EFF1F5',
                borderRadius: 8,
                fontSize: 11,
                lineHeight: 1.6,
                color: '#8A93A2',
              }}
            >
              {L.thContentGap}
            </div>
          )}
        </div>

        {/* footer — written-by chips (from steps) */}
        {artifact.writtenBy.length > 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              flex: 'none',
              borderTop: '1px solid #EFF1F5',
              padding: '8px 14px',
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.06em', color: '#B6BDC9', marginRight: 2 }}>
              {L.thWrittenBy}
            </span>
            {artifact.writtenBy.map((w, i) => (
              <span
                key={i}
                style={{
                  font: (w.active ? 500 : 400) + " 9.5px 'IBM Plex Mono',monospace",
                  background: w.active ? '#EEF0FA' : '#FBFBFC',
                  border: '1px solid ' + (w.active ? '#E3E6F5' : '#EFF1F5'),
                  color: w.active ? '#4655D4' : '#8A93A2',
                  padding: '2px 7px',
                  borderRadius: 5,
                }}
              >
                {w.label}
                {w.active && ' ●'}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
