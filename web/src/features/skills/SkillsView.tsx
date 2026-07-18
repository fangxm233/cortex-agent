import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import type { SkillGroup } from '@cortex-agent/ui-contract';

// SKILLS BROWSER (plan §12 A item 2 / 8a) — CENTER-pane view mounted in the workbench frame
// (LeftRail + RightPanel persist, like Overview and Memory). Renders real skills.list data
// grouped by plugin. Neutral placeholder when loading or when no skills are found.
// No fabricated data: every field rendered comes from a real skills.list response.

const MONO = "'IBM Plex Mono', monospace";

function SkillChip({ name }: { name: string }): JSX.Element {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        fontSize: 11,
        fontWeight: 500,
        color: 'var(--proto-accent)',
        background: 'var(--proto-accent-bg)',
        border: '1px solid var(--proto-accent-border)',
        borderRadius: 999,
        padding: '2px 10px',
        fontFamily: MONO,
        letterSpacing: 0.1,
      }}
    >
      /{name}
    </span>
  );
}

function GroupSection({ group }: { group: SkillGroup }): JSX.Element {
  const L = useVocab();
  const label = group.plugin ?? L.skUserSkills;
  return (
    <div style={{ marginBottom: 28 }}>
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          color: 'var(--proto-muted-2)',
          letterSpacing: 0.8,
          textTransform: 'uppercase',
          marginBottom: 10,
          fontFamily: MONO,
        }}
      >
        {label}
        <span
          style={{
            marginLeft: 8,
            fontSize: 10,
            fontWeight: 500,
            color: 'var(--proto-line)',
            letterSpacing: 0,
            textTransform: 'none',
          }}
        >
          {group.skills.length} {group.skills.length === 1 ? 'skill' : 'skills'}
        </span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
        {group.skills.map((name) => (
          <SkillChip key={name} name={name} />
        ))}
      </div>
    </div>
  );
}

export function SkillsView(): JSX.Element {
  const trpc = useTRPC();
  const L = useVocab();
  const { data, isLoading, isError } = useQuery(trpc.skills.list.queryOptions({}));

  const groups = data ?? [];
  const totalSkills = groups.reduce((n, g) => n + g.skills.length, 0);

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'var(--proto-rail)',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '20px 28px 16px',
          borderBottom: '1px solid var(--proto-line-2)',
          background: 'var(--proto-card)',
          flex: 'none',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--proto-ink)', letterSpacing: -0.3 }}>
          {L.skTitle}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--proto-muted-2)', marginTop: 3 }}>
          {isLoading
            ? L.skScanning
            : isError
              ? L.skLoadError
              : `${totalSkills} skill${totalSkills !== 1 ? 's' : ''} across ${groups.length} group${groups.length !== 1 ? 's' : ''}`}
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px' }}>
        {isLoading && (
          <div style={{ fontSize: 12, color: 'var(--proto-line)', fontFamily: MONO }}>{L.skLoadingBody}</div>
        )}
        {isError && (
          <div style={{ fontSize: 12, color: 'var(--proto-danger)', fontFamily: MONO }}>{L.skFailedBody}</div>
        )}
        {!isLoading && !isError && groups.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--proto-line)', fontFamily: MONO }}>{L.skEmpty}</div>
        )}
        {groups.map((g) => (
          <GroupSection key={g.plugin ?? '__user__'} group={g} />
        ))}
      </div>
    </div>
  );
}
