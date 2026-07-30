// input:  thread artifact view model and shared Markdown renderer
// output: inline artifact card with references and wrapped content
// pos:    Artifact column in the desktop thread detail modal
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { useVocab } from '@/i18n';
import { ChatMarkdown } from '@/features/workbench/ChatMarkdown';
import type { DetailArtifact } from './thread-detail-vm';

const DOC_ICON = (
  <svg width="11" height="13" viewBox="0 0 11 13" fill="none" stroke="var(--proto-muted-2)" strokeWidth="1.4">
    <path d="M1 1.5h6l3 3v7H1z" />
    <path d="M7 1.5v3h3" />
  </svg>
);

function RefRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <span style={{ flex: 'none' }}>{label}</span>
      <span style={{ marginLeft: 'auto', color: 'var(--proto-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {value}
      </span>
    </div>
  );
}

function ArtifactFileHeader({ artifact }: { artifact: DetailArtifact }) {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--proto-line-2)', flex: 'none' }}>
      {DOC_ICON}
      <span style={{ minWidth: 0, font: "600 11px 'IBM Plex Mono',monospace", color: 'var(--proto-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {artifact.path ?? '—'}
      </span>
      {artifact.live && <LivePill label={L.thLive} />}
      <span style={{ marginLeft: 'auto', font: "400 9.5px 'IBM Plex Mono',monospace", color: 'var(--proto-faint)', flex: 'none' }}>
        {artifact.updated}
      </span>
    </div>
  );
}

function LivePill({ label }: { label: string }) {
  return (
    <span style={{ fontSize: 9.5, fontWeight: 600, padding: '1.5px 7px', borderRadius: 999, background: 'var(--proto-accent-bg)', color: 'var(--proto-accent)', flex: 'none', whiteSpace: 'nowrap' }}>
      <span style={{ display: 'inline-block', width: 5, height: 5, borderRadius: '50%', background: 'var(--proto-accent)', marginRight: 4, animation: 'cxpulse 1.6s ease-in-out infinite' }} />
      {label}
    </span>
  );
}

function ArtifactReferences({ artifact }: { artifact: DetailArtifact }) {
  const L = useVocab();
  const refs = [
    artifact.workspacePath ? { label: L.thWorkspace, value: artifact.workspacePath } : null,
    artifact.taskId ? { label: L.thTask, value: artifact.taskId } : null,
    artifact.taskProject ? { label: L.thProject, value: artifact.taskProject } : null,
  ].filter((ref): ref is { label: string; value: string } => ref !== null);
  return (
    <>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.06em', color: 'var(--proto-faint)' }}>{L.thReferences}</div>
      {refs.length > 0 ? (
        <div style={{ font: "400 10px 'IBM Plex Mono',monospace", color: 'var(--proto-muted)', lineHeight: 1.9, marginTop: 3 }}>
          {refs.map((ref) => <RefRow key={ref.label} {...ref} />)}
        </div>
      ) : <div style={{ fontSize: 11.5, color: 'var(--proto-muted-2)', marginTop: 3 }}>—</div>}
    </>
  );
}

function ArtifactBody({ artifact }: { artifact: DetailArtifact }) {
  const L = useVocab();
  const filename = artifact.path?.split('/').pop() ?? L.thNoArtifact;
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '13px 16px' }}>
      <div style={{ fontSize: 14, fontWeight: 650, color: 'var(--proto-ink)', letterSpacing: '-.01em' }}>{filename}</div>
      <div style={{ font: "400 9.5px 'IBM Plex Mono',monospace", color: 'var(--proto-muted-2)', marginTop: 4 }}>
        {L.thOwner}: {artifact.taskId ?? '—'}
      </div>
      <div style={{ height: 1, background: 'var(--proto-line-2)', margin: '10px 0' }} />
      <ArtifactReferences artifact={artifact} />
      <div data-artifact-content="true" style={{ marginTop: 12, color: 'var(--proto-ink)', fontSize: 12.5, lineHeight: 1.6, overflowWrap: 'anywhere' }}>
        {artifact.content ? <ChatMarkdown text={artifact.content} /> : <span style={{ color: 'var(--proto-muted-2)' }}>—</span>}
      </div>
    </div>
  );
}

function WrittenByFooter({ artifact }: { artifact: DetailArtifact }) {
  const L = useVocab();
  if (artifact.writtenBy.length === 0) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none', borderTop: '1px solid var(--proto-line-2)', padding: '8px 14px', flexWrap: 'wrap' }}>
      <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.06em', color: 'var(--proto-faint)', marginRight: 2 }}>{L.thWrittenBy}</span>
      {artifact.writtenBy.map((writer, index) => <WriterChip key={index} writer={writer} />)}
    </div>
  );
}

function WriterChip({ writer }: { writer: DetailArtifact['writtenBy'][number] }) {
  return (
    <span style={{ font: `${writer.active ? 500 : 400} 9.5px 'IBM Plex Mono',monospace`, background: writer.active ? 'var(--proto-accent-bg)' : 'var(--proto-rail)', border: `1px solid ${writer.active ? 'var(--proto-accent-bg)' : 'var(--proto-line-2)'}`, color: writer.active ? 'var(--proto-accent)' : 'var(--proto-muted-2)', padding: '2px 7px', borderRadius: 5 }}>
      {writer.label}{writer.active && ' ●'}
    </span>
  );
}

export function ThreadArtifactPanel({ artifact }: { artifact: DetailArtifact }): JSX.Element {
  const L = useVocab();
  return (
    <div style={{ width: 440, flex: 'none', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', padding: '0 2px 8px' }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.07em', color: 'var(--proto-muted-3)' }}>{L.thArtifact}</span>
      </div>
      <div data-thread-artifact="true" style={{ flex: 1, minHeight: 0, background: 'var(--proto-card)', border: '1px solid var(--proto-line)', borderRadius: 10, boxShadow: '0 1px 2px rgba(16,24,40,.03)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <ArtifactFileHeader artifact={artifact} />
        <ArtifactBody artifact={artifact} />
        <WrittenByFooter artifact={artifact} />
      </div>
    </div>
  );
}
