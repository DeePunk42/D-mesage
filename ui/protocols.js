// These adapters produce display messages only. Capture and replay always use the wire body.
export const protocolNames = {
  chat: 'Chat Completions',
  responses: 'Responses',
  anthropic: 'Anthropic Messages',
};
const endpoints = {
  chat: '/v1/chat/completions',
  responses: '/v1/responses',
  anthropic: '/v1/messages',
};
export function endpointFor(protocol, path) {
  if (!Object.hasOwn(endpoints, protocol)) throw Error('Unknown request protocol');
  if (protocol === 'responses' && path === '/backend-api/codex/responses') return path;
  return endpoints[protocol];
}
export function validRequest(protocol, body) {
  if (!body || typeof body !== 'object') return false;
  if (protocol === 'responses')
    return (
      typeof body.input === 'string' ||
      Array.isArray(body.input) ||
      (body.input == null &&
        !!(body.previous_response_id || body.conversation || body.prompt || body.instructions))
    );
  return (protocol === 'chat' || protocol === 'anthropic') && Array.isArray(body.messages);
}
function itemMessage(item) {
  if (typeof item === 'string') return { role: 'user', content: item };
  if (item?.role) return item;
  const role =
    typeof item?.type === 'string' && item.type.endsWith('_output')
      ? 'tool'
      : item?.type === 'item_reference'
        ? 'reference'
        : 'assistant';
  return { role, content: [item] };
}
export function requestEntries(protocol, body) {
  const entries = [];
  function add(key, index, value, message) {
    entries.push({ key, index, value, message });
  }
  const preamble =
    protocol === 'anthropic' ? 'system' : protocol === 'responses' ? 'instructions' : null;
  if (preamble && body[preamble] != null)
    add(preamble, null, body[preamble], { role: preamble, content: body[preamble] });
  const key = protocol === 'responses' ? 'input' : 'messages';
  if (Array.isArray(body[key])) body[key].forEach((v, i) => add(key, i, v, itemMessage(v)));
  else if (typeof body[key] === 'string') add(key, null, body[key], itemMessage(body[key]));
  return entries;
}
export function responseMessages(protocol, reply) {
  if (protocol === 'anthropic' && Array.isArray(reply?.content))
    return [{ role: reply.role || 'assistant', content: reply.content }];
  if (protocol === 'responses' && Array.isArray(reply?.output))
    return reply.output.map(itemMessage);
  return null;
}
export function isTextBlock(part) {
  return (
    typeof part === 'string' ||
    (['text', 'input_text', 'output_text', 'summary_text'].includes(part?.type) &&
      typeof part.text === 'string')
  );
}

// An entry points at one native field or array element; its display role may
// be synthetic (e.g. a top-level instructions string or a function_call).
export function writeEntry(body, entry, value) {
  if (entry.index === null) return { ...body, [entry.key]: value };
  const items = body[entry.key].slice();
  items[entry.index] = value;
  return { ...body, [entry.key]: items };
}
export function removeEntry(body, entry) {
  const next = { ...body };
  if (entry.index !== null) next[entry.key] = body[entry.key].filter((_, i) => i !== entry.index);
  else if (entry.key === 'input') next.input = [];
  else delete next[entry.key];
  return next;
}
export function insertEntry(body, protocol, index) {
  const key = protocol === 'responses' ? 'input' : 'messages';
  const items = Array.isArray(body[key])
    ? body[key].slice()
    : typeof body[key] === 'string'
      ? [{ role: 'user', content: body[key] }]
      : [];
  items.splice(index, 0, { role: 'user', content: '' });
  return { ...body, [key]: items };
}
