// input:  Modal, project creation hook, vocabulary
// output: NewProjectModal
// pos:    Compact project creation dialog
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import { useRef, useState } from 'react';
import { Modal } from '@/design/Modal';
import { useVocab } from '@/i18n';
import { canCreateProject, NP_BREADCRUMB, NP_PLACEHOLDER } from '@/features/projects/new-project';
import { useCreateProject } from '@/features/projects/useCreateProject';

// NEW PROJECT MODAL — 1:1 from prototype.dc.html L1407-1429 (+ backdrop L1291), task c551. Raw inline
// styles / px / hex / font / weight / EN copy reproduced verbatim per §8.3; submits through the REAL
// `projects.create` tRPC mutation (ui-contract AppRouter) — on success invalidates `projects.list` so
// the new project appears in the switcher. Rendered from LeftRail local state (mirrors ProjectMenu),
// no global provider needed.
//
// HONEST ADDITION (flagged): the prototype has NO error UI (its mock create always succeeds), but the
// real backend can reject (already-exists / invalid-name). On error the hint row shows the backend's
// own message in the danger color (var(--proto-danger)); it reverts to the normal hint on the next keystroke. No
// fabricated toasts/states.

const mono = "'IBM Plex Mono',monospace";

export function NewProjectModal({ onClose }: { onClose: () => void }): JSX.Element {
  const L = useVocab();
  const [name, setName] = useState('');
  const [cancelHover, setCancelHover] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { createProject, clearError, error, isPending } = useCreateProject({ onCreated: onClose });

  const submit = () => {
    void createProject(name);
  };

  const creatable = canCreateProject(name);

  return (
    <Modal
      chrome="bare"
      size="custom"
      open={true}
      showClose={false}
      title={L.newProject}
      description={L.npHint}
      onOpenChange={(open) => { if (!open) onClose(); }}
      contentDataAttributes={{ 'data-modal': 'newproj' }}
      bodyStyle={{ display: 'contents' }}
      contentStyle={{
        position: 'fixed',
        left: '50%',
        top: '50%',
        transform: 'translate(-50%,-50%)',
        animation: 'cxmodal .26s cubic-bezier(.22,1,.36,1)',
        width: 540,
        maxWidth: 'calc(100vw - 40px)',
        maxHeight: 'calc(100dvh - 40px)',
        background: 'var(--glass-2)',
        backdropFilter: 'var(--glass-filter)',
        WebkitBackdropFilter: 'var(--glass-filter)',
        borderRadius: 'var(--r-float)',
        boxShadow: 'var(--shadow-float)',
        zIndex: 61,
        overflow: 'auto',
      }}
    >
        {/* header (L1410-1414) */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '14px 20px', borderBottom: '1px solid var(--proto-line-2)'  }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--proto-ink)' }}>{L.newProject}</span>
          <span style={{ font: `400 11px ${mono}`, color: 'var(--proto-muted)' , marginLeft: 10 }}>
            {NP_BREADCRUMB}
          </span>
          <button
            type="button"
            aria-label="Close"
            className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-proto-accent"
            onClick={onClose}
            style={{
              marginLeft: 'auto',
              font: `500 11px ${mono}`,
              color: 'var(--proto-muted)',
              border: '1px solid var(--proto-line)',
              borderRadius: 'var(--r-chip)',
              padding: '5px 8px',
              cursor: 'pointer',
            }}
          >
            esc
          </button>
        </div>

        {/* name field (L1415-1422) */}
        <div style={{ padding: '16px 20px', background: 'var(--proto-card)' }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '.02em',
              color: 'var(--proto-muted)',
              marginBottom: 6,
            }}
          >
            {L.npProjectName}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              border: `1px solid ${error ? 'var(--proto-danger)' : 'var(--proto-line-3)'}`,
              borderRadius: 'var(--r-control)',
              padding: '9px 12px',
            }}
          >
            <input
              ref={inputRef}
              aria-label={L.npProjectName}
              aria-invalid={Boolean(error)}
              className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-proto-accent"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (error) clearError();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
              autoFocus
              placeholder={NP_PLACEHOLDER}
              style={{ flex: 1, minWidth: 0, font: `500 13px ${mono}`, color: 'var(--proto-ink)' }}
            />
          </div>
          <div
            style={{
              fontSize: 11,
              color: error ? 'var(--proto-danger)' : 'var(--proto-muted)',
              marginTop: 8,
              lineHeight: 1.6,
            }}
          >
            {error ?? L.npHint}
          </div>
        </div>

        {/* footer (L1423-1426) */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '16px 20px 16px',
            justifyContent: 'flex-end',
            borderTop: '1px solid var(--proto-line-2)',
            background: 'var(--proto-card)',
          }}
        >
          <button
            type="button"
            className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-proto-accent"
            onClick={onClose}
            onMouseEnter={() => setCancelHover(true)}
            onMouseLeave={() => setCancelHover(false)}
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              border: '1px solid var(--proto-line-3)',
              borderRadius: 'var(--r-control)',
              padding: '6px 13px',
              color: 'var(--proto-ink)',
              cursor: 'pointer',
              background: cancelHover ? 'var(--proto-alt)' : 'transparent',
            }}
          >
            {L.cancel}
          </button>
          <button
            type="button"
            disabled={!creatable || isPending}
            className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-proto-accent"
            onClick={submit}
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              borderRadius: 'var(--r-control)',
              padding: '7px 15px',
              color: creatable && !isPending ? 'var(--ink-solid-fg)' : 'var(--proto-muted)',
              background: creatable && !isPending ? 'var(--proto-accent)' : 'var(--proto-gray)',
              cursor: creatable && !isPending ? 'pointer' : 'default',
            }}
          >
            {L.npCreate}
          </button>
        </div>
    </Modal>
  );
}
