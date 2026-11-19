import { expect, test } from 'bun:test';
import { searchHits, searchQuery, searchConditions, splitConditions } from '../ui/search.js';
import { requestPatch } from '../request-diff.js';

test('filter chips preserve scopes, quoted phrases, unfinished input and literal paths', () => {
  const input = 'request:"blue sky" response:ok tool:weather ';
  expect(splitConditions(input).complete).toEqual([
    'request:"blue sky"',
    'response:ok',
    'tool:weather',
  ]);
  expect(searchConditions(input).map(({ scope, term }) => [scope, term])).toEqual([
    ['request', 'blue sky'],
    ['response', 'ok'],
    ['tool', 'weather'],
  ]);
  expect(splitConditions('tool:"open file').quoted).toBe(true);
  expect(searchConditions('okay response:').map((query) => query.term)).toEqual(['okay']);
  expect(searchConditions('request:C:\\temp')[0].term).toBe('C:\\temp');
});

test('tool search finds native calls and results without matching plain messages or tool definitions', () => {
  const data = [
    [
      {
        tools: [{ name: 'needle' }],
        messages: [
          { role: 'user', content: 'needle' },
          { role: 'assistant', tool_calls: [{ function: { name: 'needle' } }] },
        ],
      },
      ['messages', 1, 'tool_calls', 0, 'function', 'name'],
    ],
    [{ input: [{ type: 'function_call_output', output: 'needle' }] }, ['input', 0, 'output']],
    [
      { role: 'assistant', content: [{ type: 'tool_use', input: { city: 'needle' } }] },
      ['content', 0, 'input', 'city'],
    ],
    [
      { output: [{ type: 'function_call', arguments: '{"name":"needle"}' }] },
      ['output', 0, 'arguments'],
    ],
    [
      { choices: [{ message: { function_call: { name: 'needle' } } }] },
      ['choices', 0, 'message', 'function_call', 'name'],
    ],
  ];
  for (const [body, path] of data) {
    const hits = [...searchHits(body, 'response', searchQuery('TOOL: Needle'))];
    expect(hits.map((hit) => hit.path)).toEqual([path]);
    expect([...searchHits(body, 'response', searchQuery('request:needle'))]).toHaveLength(0);
  }
});

test('unified request diff preserves surrounding lines and omits identical requests', () => {
  const base = {
    messages: [
      { role: 'system', content: 'first' },
      { role: 'user', content: 'last' },
    ],
  };
  const next = {
    messages: [base.messages[0], { role: 'user', content: 'extra' }, base.messages[1]],
  };
  const [hunk] = requestPatch(JSON.stringify(base), JSON.stringify(next));
  expect(hunk.lines.some((line) => line.startsWith('+') && line.includes('extra'))).toBe(true);
  expect(hunk.lines.some((line) => line.startsWith(' ') && line.includes('last'))).toBe(true);
  expect(requestPatch(JSON.stringify(base), JSON.stringify(base, null, 2))).toEqual([]);
});
