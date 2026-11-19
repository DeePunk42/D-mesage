import { expect, test } from 'bun:test';
import { promptSections, promptTokens } from '../ui/prompt-syntax.js';

test('prompt syntax distinguishes structural markers from ordinary prose', () => {
  const text = [
    '## Instructions',
    '> - [x] Check [guide](https://example.test/a_(b))',
    '<context name="a > b">[任务说明] [[source]]</context>',
    '**Read `a*b` and [IMPORTANT]**',
    '[reference][id] <ns:part/>',
    String.raw`if 42 then return "plain" with foo_bar or \[escaped]`,
  ].join('\r\n');
  const tokens = [...promptTokens(text)];
  expect(tokens.map(([value]) => value).join('')).toBe(text);
  const marked = tokens.filter(([, type]) => type);
  expect(marked).toContainEqual(['## Instructions', 'syntaxMarkdown']);
  expect(marked).toContainEqual(['> - [x]', 'syntaxMarkdown']);
  expect(marked).toContainEqual(['[guide](https://example.test/a_(b))', 'syntaxMarkdown']);
  expect(marked).toContainEqual(['[reference][id]', 'syntaxMarkdown']);
  expect(marked).toContainEqual([' name="a > b"', 'syntaxAttribute']);
  expect(marked).toContainEqual(['</context', 'syntaxTag']);
  expect(marked).toContainEqual(['[任务说明]', 'syntaxBracket']);
  expect(marked).toContainEqual(['[[source]]', 'syntaxBracket']);
  expect(marked).toContainEqual(['[IMPORTANT]', 'syntaxBracket']);
  expect(marked).toContainEqual(['`a*b`', 'syntaxCode']);
  expect(marked.map(([value]) => value).join('')).not.toMatch(
    /if 42|return|"plain"|foo_bar|escaped/,
  );
});

test('foldable fences isolate code from prompt syntax, including unfinished fences', () => {
  const code = '[CODE]\r\n```\r\n<context/>\r\n';
  const text = ' ````xml\r\n' + code + '````\r\n[OUTSIDE]\n~~~\n[STILL CODE]';
  const sections = [...promptSections(text)];
  expect(sections.filter(({ marker }) => marker)).toHaveLength(2);
  expect(sections[0].label).toBe('xml');
  expect(text.slice(sections[0].codeStart, sections[0].codeEnd)).toBe(code);
  const tokens = [...promptTokens(text)];
  expect(tokens.map(([value]) => value).join('')).toBe(text);
  expect(tokens.filter(([, type]) => type === 'syntaxBracket')).toEqual([
    ['[OUTSIDE]', 'syntaxBracket'],
  ]);
});
