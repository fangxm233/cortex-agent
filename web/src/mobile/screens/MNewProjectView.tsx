import { MBottomSheet, MC } from '@/mobile/ui/kit';
import { canCreateProject } from '@/features/projects/new-project';
import { useVocabOptional } from '@/i18n';

export function MNewProjectView({
  name,
  onNameChange,
  onCreate,
  onClose,
  error,
  pending,
}: {
  name: string;
  onNameChange: (v: string) => void;
  onCreate: () => void;
  onClose: () => void;
  error: string | null;
  pending: boolean;
}) {
  const copy = useVocabOptional();
  const creatable = canCreateProject(name);
  const submittable = creatable && !pending;
  return (
    <MBottomSheet onClose={onClose}>
      {/* title row (L511) */}
      <div style={{ display: 'flex', alignItems: 'baseline', padding: '0 2px 12px' }}>
        <span style={{ fontSize: 17, fontWeight: 650, color: MC.ink }}>
          {copy.newProject}
        </span>
      </div>

      {/* name input (L512-515) — controlled, replaces the scheme's static placeholder + cursor */}
      <input
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && submittable) onCreate();
        }}
        placeholder={copy.npNamePlaceholder}
        autoFocus
        style={{
          width: '100%',
          height: 48,
          border: '1px solid var(--proto-line-3)',
          borderRadius: 'var(--r-control)',
          background: 'var(--material-inset-bg)',
          padding: '0 14px',
          fontSize: 16,
          fontFamily: 'inherit',
          color: MC.ink,
          boxSizing: 'border-box',
        }}
      />

      {error && (
        <div
          data-project-create-error={true}
          style={{ marginTop: 8, fontSize: 12.5, lineHeight: 1.5, color: 'var(--proto-danger)' }}
        >
          {error}
        </div>
      )}

      {/* create-and-chat button (L517) */}
      <button
        type="button"
        onClick={onCreate}
        disabled={!submittable}
        aria-busy={pending}
        style={{
          width: '100%',
          height: 48,
          border: 'none',
          borderRadius: 'var(--r-control)',
          background: MC.inkSolid,
          color: 'var(--ink-solid-fg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'var(--font-ui)',
          fontSize: 15,
          fontWeight: 600,
          marginTop: 12,
          opacity: submittable ? 1 : 0.45,
          cursor: submittable ? 'pointer' : 'default',
        }}
      >
        {copy.npCreateAndChat}
      </button>
    </MBottomSheet>
  );
}
