// input:  (none)
// output: buildResumeReminder()
// pos:    Continuation prompt for provider-interrupted work
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

/** The continuation prompt injected into a resumed session/thread after a provider interruption
 *  (rate limit or outage). Self-contained — the prior turn's content is already in the resumed
 *  session/thread history. Shared by the direct-session resume (resume-dispatcher) and the
 *  interrupted-thread-step rerun (prompt-builder). */
export function buildResumeReminder(): string {
  return [
    '<system-reminder>',
    'The previous turn was interrupted by an API error. The provider has recovered; you may continue.',
    'Resume from where you left off: review the recent conversation context above, work out what is still unfinished, and finish it.',
    'Do not restart the task from scratch, and do not re-ask for information the user already provided. If the previous turn was in fact already complete, briefly confirm and stop.',
    'This message is only a resume signal; it should not change your original task.',
    '</system-reminder>',
  ].join('\n');
}
