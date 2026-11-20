import { requestEntries } from './protocols.js';
import { toolLookup } from './response-items.js';

const pageSize = 40;

export function requestHistory(protocol, body) {
  const messages = requestEntries(protocol, body).map(({ message }) => message);
  let allCalls;
  return (before = messages.length) => {
    if (!Number.isSafeInteger(before) || before < 0 || before > messages.length)
      throw Error('Invalid message history cursor.');
    const start = Math.max(0, before - pageSize);
    const page = messages.slice(start, before);
    const calls = toolLookup(page);
    const linked = new Map();
    for (const message of page) {
      const ids = [message.tool_call_id];
      if (Array.isArray(message.content))
        for (const item of message.content) ids.push(item?.tool_use_id || item?.call_id || item?.id);
      for (const id of ids) {
        if (!id || calls.has(id) || linked.has(id)) continue;
        allCalls ??= toolLookup(messages);
        if (allCalls.has(id)) linked.set(id, allCalls.get(id));
      }
    }
    return { messages: page, start, before, next: start || null, linked: [...linked] };
  };
}
