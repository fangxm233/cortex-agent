/**
 * Display form of a model id, shared by every chip that has to name a model in little space —
 * the subagent block and the composer's engine chip.
 *
 * Only two shapes are stripped, both unambiguous: a leading `claude-` vendor prefix and a trailing
 * `-YYYYMMDD` release date. Anything else is shown verbatim — an id we do not recognise is reported
 * as it was reported to us rather than guessed at, since the whole point of a chip is to say which
 * model is actually running.
 *
 * The prefix carries no information a chip can use: every id under it reads `opus-5` / `sonnet-4-6`
 * on its own, and the vendor is already stated by the profile behind the chip.
 */
export function modelLabel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}
