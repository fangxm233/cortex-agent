/** The continuation prompt injected into a resumed session/thread after a provider interruption
 *  (rate limit or outage). Self-contained — the prior turn's content is already in the resumed
 *  session/thread history. Shared by the direct-session resume (resume-dispatcher) and the
 *  interrupted-thread-step rerun (prompt-builder). */
export function buildResumeReminder(): string {
  return [
    '<system-reminder>',
    'The previous turn was interrupted by an API error. The provider has recovered; you may continue.',
    'This message is only a resume signal; it should not change your original task.',
    '</system-reminder>',
  ].join('\n');
}
