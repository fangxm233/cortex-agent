import type { ReactNode } from 'react';

export interface MarkdownSegment {
  type: 'text' | 'bold' | 'italic' | 'code' | 'link';
  text: string;
  url?: string;
}

/**
 * Parse inline markdown into typed segments.
 * Supports: **bold**, *italic*, `code`, [text](url)
 */
export function parseMarkdown(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  let remaining = text;

  const regex = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`(.+?)`)|(\[(.+?)\]\((.+?)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(remaining)) !== null) {
    // Text before this match
    if (match.index > lastIndex) {
      segments.push({ type: 'text', text: remaining.slice(lastIndex, match.index) });
    }

    if (match[2] !== undefined) {
      segments.push({ type: 'bold', text: match[2] });
    } else if (match[4] !== undefined) {
      segments.push({ type: 'italic', text: match[4] });
    } else if (match[6] !== undefined) {
      segments.push({ type: 'code', text: match[6] });
    } else if (match[8] !== undefined) {
      segments.push({ type: 'link', text: match[8], url: match[9] });
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text
  if (lastIndex < remaining.length) {
    segments.push({ type: 'text', text: remaining.slice(lastIndex) });
  }

  return segments;
}
