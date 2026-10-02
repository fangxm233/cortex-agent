import type { SessionInfo } from '@cortex-agent/ui-contract';

/** Partition before commission/schedule grouping so a star has exactly one list placement.
 * Callers scope to a project first. Neither source order nor session metadata is changed. */
export function partitionStarredSessions(direct: SessionInfo[], scheduled: SessionInfo[]) {
  return {
    starred: [...direct, ...scheduled].filter((session) => session.starred === true),
    direct: direct.filter((session) => session.starred !== true),
    scheduled: scheduled.filter((session) => session.starred !== true),
  };
}
