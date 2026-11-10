import { expect, test } from 'vitest';
import { renderMarkdown } from './markdown';

test('renders headers, bullets, bold, and links as HTML', () => {
    const html = renderMarkdown(
        '## Changes\n\n* **Fixed** a bug\n* Added [a link](https://example.com)',
    );
    expect(html).toContain('<h2>Changes</h2>');
    expect(html).toContain('<strong>Fixed</strong>');
    expect(html).toContain('<a href="https://example.com">a link</a>');
    expect(html).toContain('<ul>');
});

test('strips disallowed/unsafe tags', () => {
    const html = renderMarkdown('Hello <script>alert(1)</script> world');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('alert(1)');
});
