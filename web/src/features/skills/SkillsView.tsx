import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { fmt, useVocab, type Vocab } from '@/i18n';
import type { SkillGroup } from '@cortex-agent/ui-contract';

// SKILLS BROWSER (plan §12 A item 2 / 8a) — CENTER-pane view mounted in the workbench frame
// (LeftRail persists, like Overview and Memory). Renders real skills.list data
// grouped by plugin. Neutral placeholder when loading or when no skills are found.
// No fabricated data: every field rendered comes from a real skills.list response.

// A two-column directory: the plugin and its count on the left, its skills as a wrapped run of
// slash names on the right. Groups are set apart by hairlines; only the skill names are code.
const SKILL_NAME: React.CSSProperties = {
  font: '400 12px/1.6 var(--font-code)',
  color: 'var(--proto-accent)',
  overflowWrap: 'anywhere',
};

const STATUS_LINE: React.CSSProperties = { fontSize: 12, color: 'var(--proto-muted)', padding: '10px 0' };

// Skill / group counters — English pluralizes, Chinese does not.
function skillCount(L: Vocab, n: number): string {
  return fmt(n === 1 ? L.skillCountOne : L.skillCountMany, { n });
}

function skillSummary(L: Vocab, skills: number, groups: number): string {
  const groupCount = fmt(groups === 1 ? L.skillGroupCountOne : L.skillGroupCountMany, { n: groups });
  return fmt(L.skillSummary, { skills: skillCount(L, skills), groups: groupCount });
}

function GroupSection({ group, last }: { group: SkillGroup; last: boolean }): JSX.Element {
  const L = useVocab();
  return (
    <div
      data-skill-group={group.plugin}
      style={{
        display: 'grid',
        gridTemplateColumns: '180px minmax(0, 1fr)',
        columnGap: 16,
        padding: '10px 0',
        borderBottom: last ? 'none' : '1px solid var(--proto-line-2)',
      }}
    >
      <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)', lineHeight: 1.45 }}>{group.plugin}</div>
        <div style={{ fontSize: 12, color: 'var(--proto-muted-3)', fontVariantNumeric: 'tabular-nums' }}>
          {skillCount(L, group.skills.length)}
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 14px', alignContent: 'flex-start', minWidth: 0 }}>
        {group.skills.map((name) => (
          <span key={name} style={SKILL_NAME}>/{name}</span>
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
        background: 'transparent',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '20px 28px 16px',
          borderBottom: '1px solid var(--proto-line-2)',
          flex: 'none',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--proto-ink)', letterSpacing: -0.3 }}>
          {L.skTitle}
        </div>
        <div style={{ fontSize: 12, color: 'var(--proto-muted)', marginTop: 4 }}>
          {isLoading
            ? L.skScanning
            : isError
              ? L.skLoadError
              : skillSummary(L, totalSkills, groups.length)}
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', scrollbarGutter: 'stable', padding: '8px 28px 24px' }}>
        {isLoading && <div style={STATUS_LINE}>{L.skLoadingBody}</div>}
        {isError && <div style={{ ...STATUS_LINE, color: 'var(--proto-danger)' }}>{L.skFailedBody}</div>}
        {!isLoading && !isError && groups.length === 0 && <div style={STATUS_LINE}>{L.skEmpty}</div>}
        {groups.map((g, i) => (
          <GroupSection key={g.plugin} group={g} last={i === groups.length - 1} />
        ))}
      </div>
    </div>
  );
}
