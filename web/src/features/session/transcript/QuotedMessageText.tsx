import { quotePreview, splitQuote } from './message-quote';

/** A message's text with the quote it opens with (see message-quote) drawn as a muted, clamped
 *  block above the reply. Sits inside a `pre-wrap` bubble. */
export function QuotedMessageText({ text }: { text: string }): JSX.Element {
  const { quote, body } = splitQuote(text);
  if (!quote) return <>{text}</>;
  return (
    <>
      <span
        data-message-quote=""
        style={{
          display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          borderLeft: '2px solid var(--proto-line-3)', paddingLeft: 8, marginBottom: body ? 6 : 0,
          fontSize: '0.92em', color: 'var(--proto-muted)', whiteSpace: 'normal',
        }}
      >
        {quotePreview(quote)}
      </span>
      {body}
    </>
  );
}
