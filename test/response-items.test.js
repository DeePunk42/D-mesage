import { expect, test } from 'bun:test';
import { requestPreview } from '../ui/messages.js';
import { finalPreview, itemLabel, resultParts, phaseLabel } from '../ui/response-items.js';
import { rankedHits, searchHits, searchQuery } from '../ui/search.js';

const result = (output, call_id = 'two') => ({ type: 'function_call_output', call_id, output });
const call = (name, args, call_id = 'two') => ({
  type: 'function_call',
  name,
  arguments: JSON.stringify(args),
  call_id,
});
const summary = (...input) => requestPreview('responses', { input }).text;

test('Responses pairs ids, extracts executor outcomes, leaves unknown output literal', () => {
  const output =
    'Chunk ID: aaa\nWall time: 1 seconds\nProcess exited with code 2\nOutput:\n  Missing file';
  const command = call('exec_command', { cmd: 'cat file' });
  expect(summary(command, call('other', {}, 'one'), result(output))).toBe(
    'exec_command · cat file · exit 2 · Missing file',
  );
  expect(resultParts(result(output), command)[0].text).toBe('  Missing file');
  expect(summary(result(output))).toStartWith('Tool result · Chunk ID: aaa');
  expect(
    summary(
      call('write_stdin', { session_id: 7 }),
      result('Chunk ID: a\nProcess running with session ID 7\nOutput:\n'),
    ),
  ).toContain('running · 7');
  expect(
    summary(
      call('apply_patch', {}),
      result('Exit code: 0\nOutput:\nSuccess. Updated the following files:\nM one.js\nD two.js'),
    ),
  ).toContain('M one.js, D two.js');
  expect(
    summary(
      call('view_image', {}),
      result([{ type: 'input_image', image_url: 'data:image/png;base64,private' }]),
    ),
  ).toBe('view_image · 1 image');
  expect(summary({ ...command, namespace: 'mcp__one' }, result('done'))).toStartWith(
    'mcp__one.exec_command',
  );
});

test('script results prioritize failed children and retain the whole ordered result', () => {
  const script = {
    type: 'custom_tool_call',
    call_id: 'two',
    name: 'exec',
    input: 'await tools.one(); if (x) await tools.two();',
  };
  const output = [
    { type: 'input_text', text: 'Script completed\nWall time 1 second\nOutput:\n' },
    {
      type: 'input_text',
      text: JSON.stringify([
        { status: 'fulfilled', value: { exit_code: 0, output: 'first' } },
        { status: 'fulfilled', value: { exit_code: 3, output: 'failed child' } },
      ]),
    },
  ];
  const item = { ...result(output), type: 'custom_tool_call_output' };
  const before = JSON.stringify(item);
  expect(summary(script, item)).toBe('exec · references one, two · exit 3, exit 0 · failed child');
  expect(
    resultParts(item, script)
      .filter((p) => p.text)
      .map((p) => p.text),
  ).toEqual(['first', 'failed child']);
  expect(JSON.stringify(item)).toBe(before);
});

test('Responses presents opaque items, readable summaries, tool discovery and explicit phases', () => {
  const r = { type: 'reasoning', summary: [], encrypted_content: 'secret' };
  expect(itemLabel(r)).toBe('Encrypted reasoning');
  expect(itemLabel({ ...r, summary: [{ text: 'one' }, { text: 'two' }] })).toBe('one two');
  expect(
    summary({
      type: 'additional_tools',
      role: 'developer',
      tools: [{ type: 'namespace', name: 'web', tools: [{ name: 'find' }] }],
    }),
  ).toBe('Tools added · 1 tool · web.find');
  expect(itemLabel({ type: 'tool_search_output', tools: [] })).toBe(
    'Tool search results · 0 tools',
  );
  expect(
    itemLabel({
      type: 'web_search_call',
      action: { type: 'find_in_page', pattern: 'term', url: 'page' },
    }),
  ).toContain('find_in_page · term · page');
  expect(itemLabel({ type: 'compaction_trigger' })).toBe('Compaction requested');
  expect(itemLabel({ type: 'compaction', encrypted_content: 'secret' })).toBe('Compaction item');
  const m = {
    role: 'assistant',
    phase: 'final_answer',
    content: [{ type: 'output_text', text: 'Answer' }],
  };
  expect(phaseLabel({ ...m, phase: 'commentary' })).toBe('Progress');
  expect(finalPreview({ output: [r, m] })).toBe('Answer');
  expect(finalPreview({ output: [], usage: { output_tokens: 27 } })).toBeNull();
});

test('ranked search keeps all native pointers and prioritizes new actions and their paired calls', () => {
  const req = {
    tools: [{ name: 'needle' }],
    input: [
      { role: 'developer', content: 'needle' },
      call('needle', {}, 'old'),
      call('needle', {}),
      result('needle'),
    ],
  };
  const res = { output: [call('needle', {}, 'next')], tools: [{ name: 'needle' }] };
  for (const term of [
    'needle',
    'request:needle',
    'response:needle',
    'tool:needle',
    'input',
    'output',
  ]) {
    const q = searchQuery(term);
    const paths = (hits) => [...hits].map((h) => h.side + '/' + h.path.join('/'));
    const all = [...paths(searchHits(req, 'request', q)), ...paths(searchHits(res, 'response', q))];
    const ranked = paths(rankedHits(req, res, q, 3));
    expect(ranked.toSorted()).toEqual(all.toSorted());
    if (term === 'needle')
      expect(ranked.slice(0, 4)).toEqual([
        'request/input/3/output',
        'request/input/2/name',
        'response/output/0/name',
        'request/input/1/name',
      ]);
  }
});
