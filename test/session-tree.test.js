import { expect, test } from 'bun:test';
import { buildShape, requestChain } from '../session-chain.js';

const msg = (role, text) => ({ type: 'message', role, content: [{ type: 'input_text', text }] });
const chainOf = (input, extra = {}) => requestChain('responses', { input, ...extra });
const same = (a, b) => expect([...a]).toEqual([...b]);

test('Codex volatile fields and Claude Code cache markers do not split a conversation', () => {
  same(
    chainOf([msg('user', 'hi'), { type: 'reasoning', content: null, summary: [], id: 'rs_1' }]),
    chainOf([
      { ...msg('user', 'hi'), id: 'msg_2', status: 'completed' },
      { type: 'reasoning', content: [], metadata: { turn_id: 't' } },
    ]),
  );
  const claude = (messages, system) => requestChain('anthropic', { system, messages });
  same(
    claude([{ role: 'user', content: 'hi' }], 'You are helpful'),
    claude(
      [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }],
      [{ type: 'text', text: 'You are helpful' }],
    ),
  );
  expect(chainOf([msg('user', 'hi')])[1]).not.toBe(chainOf([msg('user', 'bye')])[1]);
  expect(requestChain('unknown', { messages: [] })).toBeNull();
});

test('tree shape separates turns, side requests, retries, compaction and branches', () => {
  const base = [msg('developer', 'context'), msg('user', 'task')];
  const one = [...base, msg('assistant', 'step 1')];
  const two = [...one, msg('user', 'more')];
  const chains = [
    chainOf(base),
    chainOf(one),
    chainOf([...one, msg('user', 'app-generated title request')]),
    chainOf(two),
    chainOf(two),
    chainOf([...two, msg('assistant', 'done')], { tools: [{ type: 'function', name: 'x' }] }),
    chainOf([msg('developer', 'context'), msg('user', 'summary of earlier work')]),
    chainOf([...base, msg('assistant', 'other answer'), msg('user', 'again')]),
  ];
  const nodes = buildShape(chains);
  expect(nodes.map((n) => [n.kind, n.parent, n.kept])).toEqual([
    ['root', null, 0],
    ['turn', 0, 2],
    ['turn', 1, 3],
    ['turn', 1, 3],
    ['retry', 3, 4],
    ['turn', 4, 4],
    ['compacted', 5, 1],
    ['turn', 0, 2],
  ]);
  expect(nodes[5].headChanged).toBe(true);
  expect(nodes[2].side).toBe(true);
  expect(nodes.filter((n) => n.main).map((n) => nodes.indexOf(n))).toEqual([0, 1, 3, 4, 5, 6]);
});

test('an unrelated request in the same session starts a new root', () => {
  const chains = [chainOf([msg('user', 'main task')]), chainOf([msg('user', 'subagent task')])];
  expect(buildShape(chains).map((n) => [n.kind, n.parent])).toEqual([
    ['root', null],
    ['root', null],
  ]);
  const chat = (messages) => requestChain('chat', { messages });
  const first = chat([{ role: 'user', content: 'hi' }]);
  expect([...chat([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }])].slice(0, 2)).toEqual([...first]);
});

test('lane layout keeps the main path in lane 0 and joins branches at their parent', async () => {
  const { laneLayout } = await import('../ui/session-graph.js');
  const nodes = [
    { id: 'm3', parent: 'm2', main: true },
    { id: 's', parent: 'm1', main: false },
    { id: 'm2', parent: 'm1', main: true },
    { id: 'm1', parent: null, main: true },
  ];
  expect(laneLayout(nodes)).toEqual({
    width: 2,
    rows: [
      { lane: 0, through: [], merges: [], up: false, down: true },
      { lane: 1, through: [0], merges: [], up: false, down: true },
      { lane: 0, through: [1], merges: [], up: true, down: true },
      { lane: 0, through: [], merges: [1], up: true, down: false },
    ],
  });
});
