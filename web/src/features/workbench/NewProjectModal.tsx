import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import {
  canCreate,
  createBg,
  createErrorMessage,
  NP_BREADCRUMB,
  NP_PLACEHOLDER,
} from './new-project';

// NEW PROJECT MODAL — 1:1 from prototype.dc.html L1407-1429 (+ backdrop L1291), task c551. Raw inline
// styles / px / hex / font / weight / EN copy reproduced verbatim per §8.3; submits through the REAL
// `projects.create` tRPC mutation (ui-contract AppRouter) — on success invalidates `projects.list` so
// the new project appears in the switcher. Rendered from LeftRail local state (mirrors ProjectMenu),
// no global provider needed.
//
// HONEST ADDITION (flagged): the prototype has NO error UI (its mock create always succeeds), but the
// real backend can reject (already-exists / invalid-name). On error the hint row shows the backend's
// own message in the danger color (#C03D33); it reverts to the normal hint on the next keystroke. No
// fabricated toasts/states.

const mono = "'IBM Plex Mono',monospace";

export function NewProjectModal({ onClose }: { onClose: () => void }): JSX.Element {
  const trpc = useTRPC();
  const L = useVocab();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [cancelHover, setCancelHover] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const create = useMutation(
    trpc.projects.create.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(trpc.projects.list.queryFilter());
        onClose();
      },
      onError: (err) => setError(createErrorMessage(err)),
    }),
  );

  const submit = () => {
    if (!canCreate(name) || create.isPending) return;
    setError(null);
    create.mutate({ name: name.trim() });
  };

  // Esc closes the modal (matches the esc chip / prototype closeModal).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const creatable = canCreate(name);

  return (
    <>
      {/* backdrop (prototype L1291-1293) */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(25,28,34,.34)',
          zIndex: 60,
          animation: 'cxfade .18s ease',
        }}
      />
      {/* card (prototype L1409) */}
      <div
        data-modal="newproj"
        style={{
          position: 'fixed',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%,-50%)',
          animation: 'cxmodal .26s cubic-bezier(.22,1,.36,1)',
          width: 540,
          background: '#fff',
          borderRadius: 14,
          boxShadow: '0 24px 64px rgba(16,24,40,.3)',
          zIndex: 61,
          overflow: 'hidden',
        }}
      >
        {/* header (L1410-1414) */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '14px 20px 0' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#191C22' }}>{L.newProject}</span>
          <span style={{ font: `400 10px ${mono}`, color: '#98A1B0', marginLeft: 10 }}>
            {NP_BREADCRUMB}
          </span>
          <span
            onClick={onClose}
            style={{
              marginLeft: 'auto',
              font: `500 9.5px ${mono}`,
              color: '#98A1B0',
              border: '1px solid #E7E9EE',
              borderRadius: 5,
              padding: '2px 6px',
              cursor: 'pointer',
            }}
          >
            esc
          </span>
        </div>

        {/* name field (L1415-1422) */}
        <div style={{ padding: '16px 20px 0' }}>
          <div
            style={{
              fontSize: 9.5,
              fontWeight: 700,
              letterSpacing: '.05em',
              color: '#98A1B0',
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
              border: '1.5px solid #C9CFF2',
              borderRadius: 9,
              padding: '9px 12px',
            }}
          >
            <input
              ref={inputRef}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
              autoFocus
              placeholder={NP_PLACEHOLDER}
              style={{ flex: 1, font: `500 13px ${mono}`, color: '#191C22' }}
            />
          </div>
          <div
            style={{
              fontSize: 10.5,
              color: error ? '#C03D33' : '#98A1B0',
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
          }}
        >
          <span
            onClick={onClose}
            onMouseEnter={() => setCancelHover(true)}
            onMouseLeave={() => setCancelHover(false)}
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              border: '1px solid #D9DCE3',
              borderRadius: 8,
              padding: '6px 13px',
              color: '#191C22',
              cursor: 'pointer',
              background: cancelHover ? '#F7F8FA' : 'transparent',
            }}
          >
            {L.cancel}
          </span>
          <span
            onClick={submit}
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              borderRadius: 8,
              padding: '7px 15px',
              color: '#fff',
              background: createBg(name),
              cursor: creatable && !create.isPending ? 'pointer' : 'default',
            }}
          >
            {L.npCreate}
          </span>
        </div>
      </div>
    </>
  );
}
