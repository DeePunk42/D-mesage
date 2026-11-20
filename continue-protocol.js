// Translate only the transport framing. Tool calls in old input remain history.
import { isDeepStrictEqual } from 'node:util';
import { isAbsolute } from 'node:path';

const controls = new Set(['system', 'developer', 'instructions']);
const isControl = (item) =>
  controls.has(item?.role) || ['additional_tools', 'configuration_update'].includes(item?.type);
const parameters = new Set(
  (
    'model max_tokens max_completion_tokens max_output_tokens temperature top_p top_k seed stop stop_sequences ' +
    'presence_penalty frequency_penalty reasoning reasoning_effort thinking text response_format output_config store parallel_tool_calls'
  ).split(' '),
);
const historyKey = (protocol) => (protocol === 'responses' ? 'input' : 'messages');
const items = (body, key) =>
  typeof body[key] === 'string' ? [{ role: 'user', content: body[key] }] : body[key];
function authority(body, key) {
  return [
    body.system,
    body.instructions,
    body.tools,
    body.tool_choice,
    body.functions,
    body.function_call,
    (items(body, key) || []).filter(isControl),
  ];
}

function inspectPendingCall(call) {
  const a = call.args;
  if (typeof call.id !== 'string' || !call.id || !a || typeof a !== 'object' || Array.isArray(a))
    throw Error('The saved tool call has no valid ID or arguments.');
  const keys = Object.keys(a);
  if (call.name === 'bash') {
    call.command = a.command;
    return;
  }
  if (!['Read', 'read'].includes(call.name))
    throw Error('Pending tool is unavailable for continuation: ' + (call.name || 'unknown'));
  if (
    keys.length !== 1 ||
    !['path', 'file_path', 'filePath'].includes(keys[0]) ||
    typeof a[keys[0]] !== 'string' ||
    !isAbsolute(a[keys[0]]) ||
    /[\x00-\x1f\x7f]/.test(a[keys[0]])
  )
    throw Error('File continuation requires one absolute file path.');
  call.path = a[keys[0]];
}

export function continuationPlan(protocol, body, reply, original) {
  const key = historyKey(protocol);
  if (
    !Array.isArray(items(body, key)) ||
    !items(body, key).length ||
    items(body, key).some((item) => item?.type === 'item_reference') ||
    body.previous_response_id ||
    body.conversation
  )
    throw Error('This run needs history from its original provider session.');
  if (!isDeepStrictEqual(authority(body, key), authority(original, key)))
    throw Error(
      'This run changes agent-managed instructions or tools. The destination cannot restore those edits.',
    );
  for (const k of new Set([...Object.keys(original), ...Object.keys(body)])) {
    if (k !== key && !parameters.has(k) && !isDeepStrictEqual(body[k], original[k]))
      throw Error('The destination cannot carry the edited request field: ' + k);
  }
  let calls = [],
    text = false;
  if (protocol === 'anthropic') {
    if (
      reply?.type !== 'message' ||
      reply.role !== 'assistant' ||
      !Array.isArray(reply.content) ||
      !['end_turn', 'stop_sequence', 'tool_use'].includes(reply.stop_reason)
    )
      throw Error('A complete Messages answer is required.');
    for (const b of reply.content) {
      if (b.type === 'text') text ||= !!b.text;
      else if (b.type === 'tool_use') calls.push({ name: b.name, args: b.input, id: b.id });
      else if (!['thinking', 'redacted_thinking'].includes(b.type))
        throw Error('Unsupported answer block: ' + b.type);
    }
  } else if (protocol === 'chat') {
    const choice = reply?.choices?.[0],
      m = choice?.message;
    if (
      reply?.choices?.length !== 1 ||
      !m ||
      m.role !== 'assistant' ||
      !['stop', 'tool_calls'].includes(choice.finish_reason) ||
      m.function_call ||
      (m.content != null && typeof m.content !== 'string')
    )
      throw Error('A single complete Chat Completions answer is required.');
    text = !!(m.content || m.refusal);
    calls = (m.tool_calls || []).map((t) => ({
      name: t.function?.name,
      args: JSON.parse(t.function?.arguments || 'null'),
      id: t.id,
    }));
  } else if (protocol === 'responses') {
    if (reply?.status !== 'completed' || !Array.isArray(reply.output))
      throw Error('A complete Responses answer is required.');
    for (const item of reply.output) {
      if (item.type === 'reasoning') continue;
      if (item.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content))
        throw Error('The selected Responses item cannot be continued: ' + item.type);
      for (const b of item.content) {
        if (!['output_text', 'refusal'].includes(b.type))
          throw Error('Unsupported answer block: ' + b.type);
        text ||= !!(b.text || b.refusal);
      }
    }
  } else throw Error('Unsupported run protocol.');
  if (!calls.length && !text) throw Error('The selected run has no answer to continue.');
  if (calls.length > 1) throw Error('This run contains several pending tool calls.');
  const call = calls[0];
  if (call) inspectPendingCall(call);
  const removed = [...parameters].filter(
    (k) => Object.hasOwn(original, k) && !Object.hasOwn(body, k),
  );
  return { protocol, body, reply, call, removed };
}

export function targetProtocol(agent, protocol) {
  if (agent === 'codex') return 'responses';
  if (agent === 'claude') return 'anthropic';
  if (agent === 'dsh') return protocol === 'responses' ? 'chat' : protocol;
  throw Error('No continuation adapter installed.');
}

function textOf(m) {
  if (
    !['user', 'assistant'].includes(m?.role) ||
    (m.type && m.type !== 'message') ||
    Object.keys(m).some((k) => !['type', 'id', 'status', 'role', 'content', 'phase'].includes(k)) ||
    (m.phase && m.phase !== 'final_answer')
  )
    throw Error('Only plain conversation messages can change protocols.');
  if (typeof m.content === 'string') return m.content;
  if (
    !Array.isArray(m.content) ||
    m.content.some(
      (b) =>
        !['text', 'input_text', 'output_text'].includes(b?.type) ||
        typeof b.text !== 'string' ||
        Object.keys(b).some((k) => !['type', 'text', 'annotations'].includes(k)) ||
        b.annotations?.length,
    )
  )
    throw Error('Only plain text blocks can change protocols.');
  return m.content.map((b) => b.text).join('');
}

// Cross-protocol conversion is deliberately lossless at the conversation level.
// Rich tool, reasoning and provider-specific state needs its native protocol.
export function forTarget(agent, plan) {
  const to = targetProtocol(agent, plan.protocol);
  if (to === plan.protocol) {
    if (
      plan.call &&
      !{ claude: ['Read'], dsh: ['read', 'bash'], codex: [] }[agent].includes(plan.call.name)
    )
      throw Error('The destination does not provide ' + plan.call.name + '.');
    return plan;
  }
  if (plan.call) throw Error('A pending tool call needs the original model protocol.');
  const input = historyKey(plan.protocol);
  const limits = ['max_tokens', 'max_completion_tokens', 'max_output_tokens'];
  const common = ['model', 'stream', 'temperature', 'top_p', input, ...limits];
  for (const k of Object.keys(plan.body)) {
    if (!common.includes(k)) throw Error('The target protocol cannot carry /' + k + '.');
  }
  const caps = limits.filter((k) => Object.hasOwn(plan.body, k));
  if (caps.length > 1) throw Error('Ambiguous output limits in the source request.');
  const messages = items(plan.body, input).map((m) => ({ role: m.role, content: textOf(m) }));
  const r = plan.reply;
  let assistant;
  if (plan.protocol === 'chat') assistant = r.choices[0].message;
  else if (plan.protocol === 'anthropic') assistant = { role: 'assistant', content: r.content };
  else {
    if (r.output.length !== 1)
      throw Error('The selected response has protocol-specific output items.');
    assistant = r.output[0];
  }
  const text = textOf(assistant),
    model = plan.body.model,
    id = r.id || 'dmessage-answer';
  const body = { model, [historyKey(to)]: messages };
  for (const k of ['stream', 'temperature', 'top_p'])
    if (Object.hasOwn(plan.body, k)) body[k] = plan.body[k];
  const capKey = {
    chat: 'max_completion_tokens',
    responses: 'max_output_tokens',
    anthropic: 'max_tokens',
  }[to];
  if (caps.length) body[capKey] = plan.body[caps[0]];
  const inputTokens = r.usage?.input_tokens ?? r.usage?.prompt_tokens ?? 0;
  const outputTokens = r.usage?.output_tokens ?? r.usage?.completion_tokens ?? 0;
  const usage = { input_tokens: inputTokens, output_tokens: outputTokens };
  let reply;
  if (to === 'responses')
    reply = {
      id,
      model,
      object: 'response',
      status: 'completed',
      usage: { ...usage, total_tokens: inputTokens + outputTokens },
      output: [
        {
          id: 'msg_' + id,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          phase: 'final_answer',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
      ],
    };
  else if (to === 'anthropic')
    reply = {
      id,
      model,
      type: 'message',
      role: 'assistant',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage,
      content: [{ type: 'text', text }],
    };
  else
    reply = {
      id,
      model,
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    };
  return {
    protocol: to,
    body,
    reply,
    call: null,
    removed: plan.removed.map((k) => (limits.includes(k) ? capKey : k)),
  };
}

export function targetReason(agent, plan) {
  try {
    forTarget(agent, plan);
    return '';
  } catch (error) {
    return error.message;
  }
}

export function branchInput(plan, incoming, marker) {
  const key = historyKey(plan.protocol),
    input = items(incoming, key);
  if (!Array.isArray(input)) throw Error('The agent did not send its conversation.');
  function markerItem(i) {
    if (i?.role !== 'user') return false;
    const c = i.content;
    return typeof c === 'string'
      ? c === marker
      : Array.isArray(c) && c.some((b) => b?.text === marker);
  }
  const pos = input.findIndex(markerItem);
  if (pos < 0)
    throw Error(
      'This request does not belong to the selected run, or the agent compacted its start.',
    );
  const tail = input.slice(pos + 1);
  // Some clients send environment messages adjacent to a user prompt. Only a real
  // assistant answer or tool result establishes that this is the subsequent round.
  const continued = tail.some(
    (i) =>
      i?.role === 'assistant' ||
      i?.role === 'tool' ||
      i?.type?.endsWith('_output') ||
      (Array.isArray(i?.content) && i.content.some((b) => b?.type === 'tool_result')) ||
      ['reasoning', 'function_call', 'custom_tool_call'].includes(i?.type),
  );
  const next = { ...incoming };
  for (const k of parameters) if (Object.hasOwn(plan.body, k)) next[k] = plan.body[k];
  for (const k of plan.removed) delete next[k];
  if (plan.protocol === 'chat') {
    if (
      Object.hasOwn(plan.body, 'max_completion_tokens') &&
      !Object.hasOwn(plan.body, 'max_tokens')
    )
      delete next.max_tokens;
    if (
      Object.hasOwn(plan.body, 'max_tokens') &&
      !Object.hasOwn(plan.body, 'max_completion_tokens')
    )
      delete next.max_completion_tokens;
  }
  // A full reconstructed transcript must not also resolve a provider-owned delta.
  if (plan.protocol === 'responses') {
    delete next.previous_response_id;
    delete next.conversation;
  }
  const history = items(plan.body, key).filter((i) => !isControl(i));
  next[key] = [...input.slice(0, pos).filter(isControl), ...history, ...tail];
  let receipt = null;
  if (plan.call) {
    for (const item of tail) {
      if (plan.protocol === 'chat' && item?.role === 'tool' && item.tool_call_id === plan.call.id)
        receipt = 'returned';
      if (plan.protocol === 'anthropic' && item?.role === 'user' && Array.isArray(item.content)) {
        const result = item.content.find(
          (b) => b?.type === 'tool_result' && b.tool_use_id === plan.call.id,
        );
        if (result) receipt = result.is_error === true ? 'error' : 'returned';
      }
      if (receipt) break;
    }
  }
  return { continued, next, receipt };
}

export function checkPendingTool(incoming, call) {
  if (!call) return;
  const entry = incoming.tools?.find((t) => (t.name || t.function?.name) === call.name);
  const schema = entry?.input_schema || entry?.function?.parameters;
  if (
    !schema ||
    !Object.keys(call.args).every((key) => Object.hasOwn(schema.properties || {}, key)) ||
    !(schema.required || []).every((key) => Object.hasOwn(call.args, key))
  )
    throw Error('The selected tool and its arguments are unavailable in this session.');
}

// Recreate protocol events only for supported reply shapes. The native terminal
// response is preserved and the selected run is never sent to the model again.
export function savedAnswer(plan, stream) {
  const r = plan.reply;
  if (!stream) return Response.json(r);
  const lines = [];
  const event = (type, fields) =>
    lines.push('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n');
  if (plan.protocol === 'anthropic') {
    event('message_start', {
      message: { ...r, content: [], stop_reason: null, stop_sequence: null },
    });
    for (const [index, b] of r.content.entries()) {
      let start = b,
        deltas = [];
      if (b.type === 'text') {
        start = { ...b, text: '' };
        deltas = [{ type: 'text_delta', text: b.text }];
      }
      if (b.type === 'tool_use') {
        start = { ...b, input: {} };
        deltas = [{ type: 'input_json_delta', partial_json: JSON.stringify(b.input) }];
      }
      if (b.type === 'thinking') {
        start = { ...b, thinking: '', signature: '' };
        deltas = [
          { type: 'thinking_delta', thinking: b.thinking },
          { type: 'signature_delta', signature: b.signature },
        ];
      }
      event('content_block_start', { index, content_block: start });
      for (const delta of deltas) event('content_block_delta', { index, delta });
      event('content_block_stop', { index });
    }
    event('message_delta', {
      delta: { stop_reason: r.stop_reason, stop_sequence: r.stop_sequence },
      usage: r.usage,
    });
    event('message_stop', {});
  } else if (plan.protocol === 'chat') {
    const c = r.choices[0],
      m = c.message,
      delta = { ...m };
    if (m.tool_calls) delta.tool_calls = m.tool_calls.map((t, index) => ({ ...t, index }));
    for (const [d, reason] of [
      [delta, null],
      [{}, c.finish_reason],
    ])
      lines.push(
        'data: ' +
          JSON.stringify({
            ...r,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: d, finish_reason: reason }],
          }) +
          '\n\n',
      );
    lines.push('data: [DONE]\n\n');
  } else {
    event('response.created', { response: { ...r, status: 'in_progress', output: [] } });
    for (const [output_index, item] of r.output.entries()) {
      event('response.output_item.added', {
        output_index,
        item: item.type === 'message' ? { ...item, status: 'in_progress', content: [] } : item,
      });
      if (item.type === 'message')
        for (const [content_index, part] of item.content.entries()) {
          const ref = { output_index, content_index, item_id: item.id };
          const refused = part.type === 'refusal',
            field = refused ? 'refusal' : 'text',
            kind = refused ? 'refusal' : 'output_text';
          event('response.content_part.added', { ...ref, part: { ...part, [field]: '' } });
          event('response.' + kind + '.delta', { ...ref, delta: part[field] });
          event('response.' + kind + '.done', { ...ref, [field]: part[field] });
          event('response.content_part.done', { ...ref, part });
        }
      event('response.output_item.done', { output_index, item });
    }
    event('response.completed', { response: r });
  }
  return new Response(lines.join(''), {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
  });
}
