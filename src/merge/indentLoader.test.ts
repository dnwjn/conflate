import { expect, test } from 'vitest';
import { detectIndent } from './indentLoader';

test('detects 4-space indent as the most common step', () => {
    const text = [
        'function foo() {',
        '    let a = 1;',
        '    if (a) {',
        '        return a;',
        '    }',
        '}',
    ].join('\n');
    expect(detectIndent(text)).toEqual({ style: 'space', size: 4 });
});

test('detects 2-space indent as the most common step', () => {
    const text = ['a {', '  b;', '  c;', '}'].join('\n');
    expect(detectIndent(text)).toEqual({ style: 'space', size: 2 });
});

test('a tab anywhere in leading whitespace wins outright', () => {
    const text = ['a {', '  b;', '\tc;', '}'].join('\n');
    expect(detectIndent(text)).toEqual({ style: 'tab', size: 1 });
});

test('blank lines are ignored when measuring indent steps', () => {
    const text = ['a {', '    b;', '', '    c;', '}'].join('\n');
    expect(detectIndent(text)).toEqual({ style: 'space', size: 4 });
});

test('a flat file with no indentation yields no detection', () => {
    expect(detectIndent('a\nb\nc\n')).toBeNull();
});

test('an empty document yields no detection', () => {
    expect(detectIndent('')).toBeNull();
});
