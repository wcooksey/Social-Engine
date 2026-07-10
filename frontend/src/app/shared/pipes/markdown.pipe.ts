import { Pipe, PipeTransform } from '@angular/core';

/**
 * Minimal, dependency-free markdown -> HTML for chat messages: bold, italics,
 * inline code, code blocks, headings, links, bullet/numbered lists, and
 * paragraphs. Input is HTML-escaped BEFORE any transform, so model output can
 * never inject markup; the produced HTML uses a fixed set of safe tags that
 * Angular's [innerHTML] sanitizer also allows.
 */
@Pipe({ name: 'markdown', standalone: true })
export class MarkdownPipe implements PipeTransform {
  transform(value: string | null | undefined): string {
    if (!value) return '';
    let text = escapeHtml(value);

    // Protect finished segments from later transforms using NUL-delimited
    // placeholders - a control character escaped user text cannot contain.
    const protectedSegments: string[] = [];
    const protect = (html: string): string => {
      protectedSegments.push(html);
      return '\u0000' + (protectedSegments.length - 1) + '\u0000';
    };

    text = text.replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_m, code: string) =>
      protect('<pre><code>' + code.replace(/\n$/, '') + '</code></pre>')
    );
    text = text.replace(/`([^`\n]+)`/g, (_m, code: string) => protect('<code>' + code + '</code>'));

    // Headings -> bold lines (chat bubbles don't need h1 scale).
    text = text.replace(/^#{1,6}\s+(.+)$/gm, '<strong>$1</strong>');

    // Bold, then italic.
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');

    // Links - safe protocols only.
    text = text.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );

    // Bullet lists.
    text = text.replace(/(^|\n)((?:[-*]\s+.+(?:\n|$))+)/g, (_m, lead: string, block: string) => {
      const items = block
        .trimEnd()
        .split('\n')
        .map((line) => '<li>' + line.replace(/^[-*]\s+/, '') + '</li>')
        .join('');
      return lead + protect('<ul>' + items + '</ul>');
    });
    // Numbered lists.
    text = text.replace(/(^|\n)((?:\d+[.)]\s+.+(?:\n|$))+)/g, (_m, lead: string, block: string) => {
      const items = block
        .trimEnd()
        .split('\n')
        .map((line) => '<li>' + line.replace(/^\d+[.)]\s+/, '') + '</li>')
        .join('');
      return lead + protect('<ol>' + items + '</ol>');
    });

    // Paragraphs; single newlines inside a paragraph become <br>.
    text = text
      .split(/\n{2,}/)
      .map((chunk) => {
        const trimmed = chunk.trim();
        if (!trimmed) return '';
        // A chunk that is only protected block placeholders needs no wrapper.
        if (/^(\u0000\d+\u0000\s*)+$/.test(trimmed)) return trimmed;
        return '<p>' + trimmed.replace(/\n/g, '<br>') + '</p>';
      })
      .join('');

    // Restore protected segments.
    text = text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => protectedSegments[parseInt(i, 10)] ?? '');

    return text;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\u0000/g, '');
}
