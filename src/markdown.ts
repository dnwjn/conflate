import DOMPurify from 'dompurify';
import { marked } from 'marked';

/** Parses markdown (e.g. a GitHub release body) to sanitized HTML. */
export function renderMarkdown(text: string): string {
    const html = marked.parse(text, { async: false, gfm: true, breaks: true });
    return DOMPurify.sanitize(html);
}
