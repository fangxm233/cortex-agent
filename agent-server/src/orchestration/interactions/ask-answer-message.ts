/**
 * The user message a non-blocking ask's answer becomes (`cortex_ask_user blocking:false`): the
 * tool call already returned, so the answer reaches the session as a genuine user turn instead
 * of a tool_result. Null ⇒ nothing to say.
 */
export function askAnswerMessageText(answers: Record<string, unknown>): string | null {
  const parts = Object.entries(answers ?? {})
    .map(([question, value]) => {
      const answer = Array.isArray(value) ? value.join(', ') : String(value ?? '');
      return `Q: ${question}\nA: ${answer.trim() ? answer : '(no answer)'}`;
    });
  if (parts.length === 0) return null;
  return `[Answer to the question you asked earlier via cortex_ask_user]\n\n${parts.join('\n\n')}`;
}
