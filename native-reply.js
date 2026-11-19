// Both native APIs also stream typed JSON events. Require the protocol's terminal
// event: EOF alone can leave a plausible-looking, truncated tool call.
export async function* sseData(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '',
    data = [];
  function line(s) {
    s = s.replace(/\r$/, '');
    if (!s) {
      const event = data.join('\n');
      data = [];
      return event;
    }
    if (s.startsWith('data:')) data.push(s.slice(5).replace(/^ /, ''));
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const lines = (buffer + value).split('\n');
      buffer = lines.pop();
      for (const s of lines) {
        const event = line(s);
        if (event) yield event;
      }
    }
    if (buffer) line(buffer);
    if (data.length) yield data.join('\n');
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export function nativeReply(protocol, r) {
  if (r?.error && !Array.isArray(r.output))
    throw Error(r.error.message || 'Gateway response error.');
  if (
    protocol === 'responses' &&
    Array.isArray(r?.output) &&
    ['completed', 'incomplete', 'failed'].includes(r.status)
  )
    return r;
  if (protocol === 'anthropic' && r?.type === 'message' && Array.isArray(r.content)) return r;
  throw Error('The gateway returned an incomplete ' + protocol + ' response.');
}
export async function nativeStream(protocol, body) {
  const items = [],
    blocks = new Map();
  let message;
  for await (const data of sseData(body)) {
    if (data === '[DONE]') break;
    const e = JSON.parse(data);
    if (e.type === 'error') throw Error(e.error?.message || e.message || 'Stream error');
    if (protocol === 'responses') {
      if (e.type === 'response.output_item.done') items[e.output_index] = e.item;
      if (['response.completed', 'response.incomplete', 'response.failed'].includes(e.type)) {
        const r = e.response;
        if (!r) throw Error('Missing terminal response.');
        if (items.length && !r.output?.length) r.output = items;
        return nativeReply(protocol, r);
      }
      continue;
    }
    if (e.type === 'message_start') {
      message = e.message;
      continue;
    }
    if (!message) continue;
    switch (e.type) {
      case 'content_block_start': {
        if (!Number.isSafeInteger(e.index) || e.index < 0 || e.index !== message.content.length)
          throw Error('Invalid content block index.');
        message.content.push(e.content_block);
        blocks.set(e.index, { json: '' });
        break;
      }
      case 'content_block_delta': {
        const part = message.content[e.index],
          state = blocks.get(e.index),
          d = e.delta;
        if (!part || !state) throw Error('Unexpected content block delta.');
        if (d.type === 'input_json_delta') state.json += d.partial_json;
        else if (d.type === 'citations_delta') (part.citations ??= []).push(d.citation);
        else {
          const key = {
            text_delta: 'text',
            thinking_delta: 'thinking',
            signature_delta: 'signature',
          }[d.type];
          if (!key) throw Error('Unsupported content delta: ' + d.type);
          part[key] = (part[key] ?? '') + d[key];
        }
        break;
      }
      case 'content_block_stop': {
        const state = blocks.get(e.index);
        if (!state) throw Error('Unexpected content block stop.');
        if (state.json) message.content[e.index].input = JSON.parse(state.json);
        blocks.delete(e.index);
        break;
      }
      case 'message_delta':
        Object.assign(message, e.delta);
        if (e.usage) message.usage = { ...message.usage, ...e.usage };
        break;
      case 'message_stop':
        if (blocks.size) throw Error('Stream interrupted inside a content block.');
        return nativeReply(protocol, message);
    }
  }
  throw Error('Stream interrupted before the completion event.');
}
