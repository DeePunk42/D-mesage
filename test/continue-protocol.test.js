import { expect, test } from 'bun:test';
import {
  branchInput,
  continuationPlan,
  forTarget,
  savedAnswer,
  targetReason,
} from '../continue-protocol.js';
import { nativeStream } from '../native-reply.js';
const source = {
  model: 'model',
  input: [{ role: 'user', content: 'first' }],
  max_output_tokens: 123,
};
const b = {
  id: 'resp_a',
  model: 'model',
  status: 'completed',
  object: 'response',
  output: [
    {
      type: 'message',
      id: 'msg_a',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'answer' }],
    },
  ],
};

test('Responses handoff keeps the selected answer and edits across turns', async () => {
  const q = { ...source, input: 'edited' };
  const plan = continuationPlan('responses', q, b, source);
  expect(targetReason('codex', plan)).toBe('');
  expect(targetReason('claude', plan)).toBe('');
  const portable = forTarget('claude', plan);
  expect(portable.body.messages).toEqual([{ role: 'user', content: 'edited' }]);
  expect(portable.body.max_tokens).toBe(123);
  expect(portable.reply.content).toEqual([{ type: 'text', text: 'answer' }]);
  expect(await nativeStream('responses', savedAnswer(plan, true).body)).toEqual(b);
  const system = { type: 'message', role: 'developer', content: 'native setup' },
    next = { role: 'user', content: 'follow up' };
  const result = branchInput(
    plan,
    { input: [system, { role: 'user', content: 'marker' }, ...b.output, next], model: 'native' },
    'marker',
  );
  expect(result.continued).toBe(true);
  expect(result.next.input).toEqual([
    system,
    { role: 'user', content: 'edited' },
    ...b.output,
    next,
  ]);
  expect(result.next.max_output_tokens).toBe(123);
  expect(() => branchInput(plan, { input: [next] }, 'marker')).toThrow('does not belong');
});
test('continuation reports incompatible edits, references and pending actions', () => {
  expect(() =>
    continuationPlan('responses', { ...source, instructions: 'changed' }, b, source),
  ).toThrow('instructions');
  expect(() =>
    continuationPlan('responses', { ...source, previous_response_id: 'resp_a' }, b, source),
  ).toThrow('history');
  expect(() => continuationPlan('responses', source, { ...b, output: [] }, source)).toThrow(
    'no answer',
  );
  const q = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
  const reply = {
    choices: [
      {
        message: {
          role: 'assistant',
          tool_calls: [
            { type: 'function', id: 'c1', function: { name: 'other', arguments: '{}' } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  };
  expect(() => continuationPlan('chat', q, reply, q)).toThrow('other');
  expect(() => continuationPlan('chat', { ...q, other: 2 }, reply, q)).toThrow(
    'edited request field',
  );
});

test('DSH tool calls preserve the original command in both native protocols', async () => {
  const { checkPendingTool } = await import('../continue-protocol.js');
  for (const protocol of ['anthropic', 'chat']) {
    const args = {
      command: "printf 'DSH_ARBITRARY_OK\\n'; git status --short",
      description: 'Inspect the chat workspace',
    };
    const schema = {
      type: 'object',
      properties: { command: { type: 'string' }, description: { type: 'string' } },
      required: ['description', 'command'],
    };
    const tool = { name: 'bash', input_schema: schema };
    const base = {
      model: 'fixture',
      messages: [{ role: 'user', content: 'List files' }],
      tools:
        protocol === 'chat'
          ? [{ type: 'function', function: { name: 'bash', parameters: schema } }]
          : [tool],
    };
    const block = { type: 'tool_use', id: 'one', name: 'bash', input: args };
    const chatCall = {
      id: 'one',
      type: 'function',
      function: { name: 'bash', arguments: JSON.stringify(args) },
    };
    const reply =
      protocol === 'chat'
        ? {
            choices: [
              {
                message: { role: 'assistant', content: null, tool_calls: [chatCall] },
                finish_reason: 'tool_calls',
              },
            ],
          }
        : { type: 'message', role: 'assistant', content: [block], stop_reason: 'tool_use' };
    const plan = continuationPlan(protocol, base, reply, base);
    expect(targetReason('dsh', plan)).toBe('');
    expect(targetReason('claude', plan)).not.toBe('');
    expect(plan.call.command).toBe(args.command);
    expect(() => checkPendingTool(base, plan.call)).not.toThrow();
    expect(() => checkPendingTool({ tools: [] }, plan.call)).toThrow('unavailable');
    expect(await savedAnswer(plan, false).json()).toEqual(reply);
    const result = (id) =>
      protocol === 'chat'
        ? { role: 'tool', tool_call_id: id, content: 'file list' }
        : {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: id, content: 'file list' }],
          };
    const follow = (r) =>
      branchInput(plan, { messages: [{ role: 'user', content: 'marker' }, r] }, 'marker');
    expect(follow(result('other')).receipt).toBeNull();
    expect(follow(result('one')).receipt).toBe('returned');
    if (protocol === 'anthropic') {
      const denied = result('one');
      denied.content[0].is_error = true;
      expect(follow(denied).receipt).toBe('error');
    }
  }
});

test('DSH bash forwards arbitrary commands and arguments unchanged', () => {
  const body = { model: 'fixture', messages: [{ role: 'user', content: 'test' }] };
  function plan(args) {
    return continuationPlan(
      'anthropic',
      body,
      {
        type: 'message',
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'one', name: 'bash', input: args }],
      },
      body,
    );
  }
  const commands = [
    'pwd',
    'git status --short',
    "printf 'fixture\\n'",
    "sh -c 'printf \"first\\nsecond\\n\"'",
    'pwd\nls -la',
    'find . -type f | sort',
  ];
  for (const command of commands) expect(plan({ command }).call.command).toBe(command);
  const args = { command: "printf '100%%\\n'", description: 'Keep every byte', timeout: 30000 };
  expect(plan(args).call.args).toEqual(args);
  expect(() => plan({ command: 'pwd', workdir: '/' })).not.toThrow();
  expect(() => plan({ command: 'pwd', run_in_background: true })).not.toThrow();
});
